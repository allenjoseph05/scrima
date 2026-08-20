/**
 * Player Observation Service — Semantic Coaching Memory
 *
 * Stores text observations per player with pgvector embeddings.
 * After each enrichment, extracts observations from the coaching report.
 * Before the next enrichment, recalls relevant past observations for prompt injection.
 *
 * Uses Google text-embedding-004 (768-dim, free/near-free tier).
 * Gracefully degrades if pgvector extension is not available.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { playerObservations } from '../../db/schema.js';
import { embedTexts } from './embedding.util.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Observation {
  id: string;
  category: 'habit' | 'strength' | 'insight';
  text: string;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
  // Phase 6 — Brain self-model agree/disagree state (may be null on older rows)
  confidence?: number | null;
  confirmedAt?: string | null;
  disagreedAt?: string | null;
}

export interface RecallResult {
  observations: Observation[];
  contextBlock: string;
}

interface RawObservation {
  category: 'habit' | 'strength' | 'insight';
  text: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const COSINE_DISTANCE_THRESHOLD = 0.08; // 0.92 cosine similarity
const MAX_ACTIVE_OBSERVATIONS = 200;
const RECALL_LIMIT_SYNTHESIS = 8;

// Hybrid retrieval weights (M1). When a query embedding is supplied we mix
// semantic similarity with frequency, recency, and confidence. Without one
// we fall back to frequency × recency × confidence — same shape, no semantic.
const SCORING = {
  withQuery: { sim: 0.45, freq: 0.2, recency: 0.2, conf: 0.15 },
  withoutQuery: { sim: 0.0, freq: 0.4, recency: 0.4, conf: 0.2 },
};
/** Drop observations the user explicitly disagreed with (confidence drifts < this). */
const MIN_CONFIDENCE = 0.2;
/** Recency half-life in days for the exponential decay term. */
const RECENCY_HALF_LIFE_DAYS = 30;

// ── Sanitizers (run before any candidate observation is accepted) ───────────

/** Pipeline / system messages that escaped into report fields. Drop. */
const META_MESSAGE_REGEX =
  /\b(ai match[- ]summary|analyzed \d+ of \d+ deaths?|grounded in frames|per[- ]death coaching|vlm|enrichment|pipeline|fallback)\b/i;

/** Pure stats like "4 of 10 deaths caused by peeking errors this game". */
const PURE_STATS_REGEX = /^\d+ of \d+ (deaths?|engagements?|rounds?)/i;

/**
 * Match agent ability names with slot label parens — "Fakeout (Q)", "C Blindside",
 * "Gatecrash (E)" — and replace with the slot reference only. This prevents
 * agent-A observations from leaking into agent-B chats via M1 hybrid retrieval.
 *
 * Pattern handles two common shapes:
 *   1. "<AbilityName> (<C|Q|E|X>)"     → "(Q) ability"  → " ability" with slot
 *   2. "<C|Q|E|X> <AbilityName>"       → "Q ability"
 *
 * The slot letter is preserved so coaching can still say "your Q" / "your E".
 */
const ABILITY_NAME_PAREN_REGEX = /\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)\s*\(([CQEX])\)/g;
/** Inverse form: "Q Fakeout" / "C Blindside" → captures slot in $1, name in $2. */
const ABILITY_NAME_PREFIX_REGEX = /\b([CQEX])\s+([A-Z][a-zA-Z'-]+)\b/g;

/**
 * Strengths sometimes contain critique-shaped sentences ("you were not
 * consistently pushing"). Gemini's strengths[] field doesn't enforce positivity.
 * Drop entries whose wording reads as criticism.
 */
const NEGATIVE_STRENGTH_REGEX =
  /\b(not consistently|did not|didn't|failed to|never |missed|should have|could have)\b/i;

// ── Service ──────────────────────────────────────────────────────────────────

export class ObservationService {
  private available: boolean | null = null;

  constructor(private db: Db) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Extract observations from a completed coaching report and store them.
   * Returns the number of observations stored/merged.
   */
  async extractAndStore(userId: string, reportId: string, report: any): Promise<number> {
    if (!(await this.isAvailable())) {
      console.warn('[Observations] SKIPPED — pgvector extension not available on database');
      return 0;
    }

    const observations = this.extractObservations(report);
    if (observations.length === 0) {
      console.log('[Observations] No observations extracted from report %s', reportId);
      return 0;
    }

    // Tag every observation with the agent the player was on. Stored
    // lowercased so agent-aware retrieval can do exact matches.
    const reportAgent = (report?.detectedAgent ?? report?.resolvedAgent ?? report?.agent ?? null) as
      | string
      | null;
    const agent = reportAgent ? reportAgent.toLowerCase() : null;

    console.log(
      '[Observations] Extracted %d observations from report %s (agent=%s), embedding...',
      observations.length,
      reportId,
      agent ?? 'unknown',
    );

    // Embed all observation texts in sequence (avoid burst rate limiting)
    const embeddings = await this.embed(observations.map((o) => o.text));

    let stored = 0;
    let skippedEmbedding = 0;
    for (let i = 0; i < observations.length; i++) {
      const embedding = embeddings[i];
      if (!embedding || embedding.length !== 768) {
        skippedEmbedding++;
        console.warn(
          '[Observations] Skipping observation %d — embedding has %d dims (expected 768): "%s"',
          i,
          embedding?.length ?? 0,
          observations[i].text.slice(0, 60),
        );
        continue;
      }

      try {
        await this.storeWithDedup(userId, reportId, {
          category: observations[i].category,
          text: observations[i].text,
          embedding,
          agent,
        });
        stored++;
      } catch (err) {
        console.warn(
          '[Observations] Failed to store observation:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (skippedEmbedding > 0) {
      console.warn(
        '[Observations] %d/%d observations skipped due to bad embeddings',
        skippedEmbedding,
        observations.length,
      );
    }

    // Enforce soft cap
    await this.enforceObservationCap(userId);

    console.log(
      '[Observations] Stored %d/%d observations for user %s',
      stored,
      observations.length,
      userId,
    );
    return stored;
  }

  /**
   * Recall top observations for prompt injection (synthesis context).
   *
   * Hybrid scoring: when `opts.queryText` (or `queryEmbedding`) is supplied we
   * weight cosine similarity alongside frequency, recency, and confidence so
   * the most *relevant* observations to the current chat / pre-game context
   * are surfaced — not just the most frequent ones. Without a query we fall
   * back to frequency × recency × confidence (same shape, no semantic term).
   *
   * Disagreed observations (confidence < MIN_CONFIDENCE) are excluded.
   */
  async recallForSynthesis(
    userId: string,
    opts?: {
      queryText?: string;
      queryEmbedding?: number[];
      limit?: number;
      agentFilter?: string | string[] | null;
    },
  ): Promise<RecallResult> {
    if (!(await this.isAvailable())) return { observations: [], contextBlock: '' };

    const limit = opts?.limit ?? RECALL_LIMIT_SYNTHESIS;

    try {
      // Resolve query embedding from text if needed. A failed embed silently
      // degrades to the no-query path — better than blocking recall.
      let queryEmbedding = opts?.queryEmbedding;
      if (!queryEmbedding && opts?.queryText && opts.queryText.trim().length > 0) {
        const embeds = await this.embed([opts.queryText.trim()]);
        if (embeds[0]?.length === 768) queryEmbedding = embeds[0];
      }

      const useQuery = queryEmbedding && queryEmbedding.length === 768;
      const w = useQuery ? SCORING.withQuery : SCORING.withoutQuery;
      const queryLiteral = useQuery ? `[${queryEmbedding!.join(',')}]` : '';

      // Build the score expression in SQL so ranking happens database-side.
      //   similarity   = 1 - cosine_distance(embedding, query)        ∈ [0,1]
      //   frequency    = ln(occurrences + 1) / ln(20)                  capped via LEAST
      //   recency      = exp(-Δdays / HALF_LIFE)                       ∈ (0,1]
      //   confidence   = COALESCE(confidence, 0.5)                     ∈ [0,1]
      //   agent_boost  = +AGENT_BOOST if agent matches the query's agent
      //                  (or no agent filter and the row has no agent tag)
      const simExpr = useQuery ? sql`(1 - (embedding <=> ${queryLiteral}::vector))` : sql`0`;
      const freqExpr = sql`LEAST(1.0, LN(occurrences + 1) / LN(20))`;
      const recencyExpr = sql`EXP(-EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / (${RECENCY_HALF_LIFE_DAYS} * 86400.0))`;
      const confExpr = sql`COALESCE(confidence, 0.5)`;
      // Agent boost: if any target agents are supplied, observations
      // tagged with any of them get a +0.20 score bump. Untagged rows
      // (legacy) get +0.05 so they don't drop entirely. Non-matching
      // tagged rows get nothing — surface only if semantic similarity
      // alone clears the bar.
      const agentList = Array.isArray(opts?.agentFilter)
        ? opts.agentFilter.map((a) => a.toLowerCase()).filter(Boolean)
        : typeof opts?.agentFilter === 'string' && opts.agentFilter
          ? [opts.agentFilter.toLowerCase()]
          : [];
      const agentBoost =
        agentList.length > 0
          ? sql`CASE
                WHEN agent = ANY(ARRAY[${sql.join(
                  agentList.map((a) => sql`${a}`),
                  sql`, `,
                )}]::text[]) THEN 0.20
                WHEN agent IS NULL THEN 0.05
                ELSE 0.00
              END`
          : sql`0`;

      const result = await this.db.execute(sql`
        SELECT
          id,
          category,
          text,
          occurrences,
          last_seen_at  AS "lastSeenAt",
          created_at    AS "createdAt",
          confidence,
          agent,
          (
            ${sql.raw(String(w.sim))}     * ${simExpr} +
            ${sql.raw(String(w.freq))}    * ${freqExpr} +
            ${sql.raw(String(w.recency))} * ${recencyExpr} +
            ${sql.raw(String(w.conf))}    * ${confExpr} +
            ${agentBoost}
          ) AS score
        FROM player_observations
        WHERE user_id = ${userId}
          AND archived = false
          AND valid_until IS NULL
          AND COALESCE(confidence, 0.5) >= ${MIN_CONFIDENCE}
        ORDER BY score DESC
        LIMIT ${limit}
      `);

      const rows = ((result as any).rows ?? result) as Array<{
        id: string;
        category: string;
        text: string;
        occurrences: number;
        lastSeenAt: Date | string;
        createdAt: Date | string;
        confidence: number | null;
        score: number;
      }>;

      const observations: Observation[] = rows.map((r) => ({
        id: r.id,
        category: r.category as Observation['category'],
        text: r.text,
        occurrences: r.occurrences,
        lastSeenAt: typeof r.lastSeenAt === 'string' ? r.lastSeenAt : r.lastSeenAt.toISOString(),
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
        confidence: r.confidence ?? null,
      }));

      return {
        observations,
        contextBlock: this.formatContextBlock(observations),
      };
    } catch (err) {
      console.warn('[Observations] Recall failed:', err instanceof Error ? err.message : err);
      return { observations: [], contextBlock: '' };
    }
  }

  /**
   * List all active observations for the "Your Coach" UI page.
   */
  async listForPlayer(
    userId: string,
  ): Promise<{ habits: Observation[]; strengths: Observation[]; insights: Observation[] }> {
    if (!(await this.isAvailable())) return { habits: [], strengths: [], insights: [] };

    try {
      const rows = await this.db
        .select({
          id: playerObservations.id,
          category: playerObservations.category,
          text: playerObservations.text,
          occurrences: playerObservations.occurrences,
          lastSeenAt: playerObservations.lastSeenAt,
          createdAt: playerObservations.createdAt,
          confidence: playerObservations.confidence,
          confirmedAt: playerObservations.confirmedAt,
          disagreedAt: playerObservations.disagreedAt,
        })
        .from(playerObservations)
        .where(
          and(
            eq(playerObservations.userId, userId),
            eq(playerObservations.archived, false),
            // Only show currently-valid observations in the UI. Superseded
            // beliefs remain in DB for historical queries.
            sql`${playerObservations.validUntil} IS NULL`,
          ),
        )
        .orderBy(desc(playerObservations.occurrences), desc(playerObservations.lastSeenAt));

      const habits: Observation[] = [];
      const strengths: Observation[] = [];
      const insights: Observation[] = [];

      for (const r of rows) {
        const obs: Observation = {
          id: r.id,
          category: r.category as Observation['category'],
          text: r.text,
          occurrences: r.occurrences,
          lastSeenAt: r.lastSeenAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          confidence: r.confidence ?? null,
          confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
          disagreedAt: r.disagreedAt ? r.disagreedAt.toISOString() : null,
        };
        if (r.category === 'habit') habits.push(obs);
        else if (r.category === 'strength') strengths.push(obs);
        else insights.push(obs);
      }

      return { habits, strengths, insights };
    } catch (err) {
      console.warn('[Observations] List failed:', err instanceof Error ? err.message : err);
      return { habits: [], strengths: [], insights: [] };
    }
  }

  /**
   * Retire an observation: set valid_until = now() so it no longer surfaces
   * in active reads, but stays queryable for historical lookups. If a
   * supersedingId is provided, link the two for audit ("was X, became Y").
   *
   * Used by the user-facing "dismiss" path — superseded beliefs are not
   * deletions, just retirement.
   */
  async supersede(observationId: string, userId: string, supersedingId?: string): Promise<boolean> {
    try {
      const result = await this.db
        .update(playerObservations)
        .set({
          validUntil: new Date(),
          supersededBy: supersedingId ?? null,
          archived: true, // back-compat: legacy filters that still gate on archived
        })
        .where(and(eq(playerObservations.id, observationId), eq(playerObservations.userId, userId)))
        .returning({ id: playerObservations.id });
      return result.length > 0;
    } catch (err) {
      console.warn('[Observations] supersede failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Check if pgvector extension is available. Caches the result.
   */
  private async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const result = await this.db.execute(
        sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
      );
      this.available = (result as any).rows?.length > 0 || (result as any).length > 0;
      if (!this.available) {
        console.warn(
          '[Observations] pgvector extension NOT found — observations feature disabled. Run: CREATE EXTENSION vector;',
        );
      } else {
        console.log('[Observations] pgvector extension available — observations feature enabled');
      }
    } catch (err) {
      this.available = false;
      console.warn(
        '[Observations] pgvector check FAILED — observations feature disabled:',
        err instanceof Error ? err.message : err,
      );
    }
    return this.available;
  }

  /** Thin wrapper — keeps the call site readable + adds the per-service log. */
  private async embed(texts: string[]): Promise<number[][]> {
    const results = await embedTexts(texts);
    console.log(
      '[Observations] Embedded %d texts, %d successful (768-dim)',
      texts.length,
      results.filter((r) => r.length === 768).length,
    );
    return results;
  }

  /**
   * Store an observation with deduplication.
   * If a similar observation exists (cosine distance <= threshold), merge instead of inserting.
   */
  private async storeWithDedup(
    userId: string,
    reportId: string,
    obs: { category: string; text: string; embedding: number[]; agent: string | null },
  ): Promise<void> {
    const vectorLiteral = `[${obs.embedding.join(',')}]`;

    // Find closest existing ACTIVE observation. Superseded rows shouldn't
    // dedup-merge — they're historical, not current beliefs.
    const existing = await this.db.execute(sql`
      SELECT id, occurrences
      FROM player_observations
      WHERE user_id = ${userId}
        AND archived = false
        AND valid_until IS NULL
        AND (embedding <=> ${vectorLiteral}::vector) <= ${COSINE_DISTANCE_THRESHOLD}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT 1
    `);

    const rows = (existing as any).rows ?? existing;
    if (rows && rows.length > 0) {
      // Merge: increment occurrences, update last_seen_at and report_id
      const existingId = rows[0].id;
      await this.db
        .update(playerObservations)
        .set({
          occurrences: sql`${playerObservations.occurrences} + 1`,
          lastSeenAt: new Date(),
          reportId,
          // Update agent if the new sighting has an agent and the existing
          // row didn't (e.g. legacy null) — but don't overwrite an existing
          // agent tag, since merging across agents would still be wrong.
          ...(obs.agent ? { agent: sql`COALESCE(${playerObservations.agent}, ${obs.agent})` } : {}),
        })
        .where(eq(playerObservations.id, existingId));
    } else {
      // Insert new observation
      await this.db.insert(playerObservations).values({
        userId,
        reportId,
        category: obs.category,
        text: obs.text,
        embedding: obs.embedding,
        occurrences: 1,
        lastSeenAt: new Date(),
        agent: obs.agent,
      });
    }
  }

  /**
   * Archive oldest observations if a player exceeds the soft cap.
   * Counts only currently-valid beliefs (validUntil IS NULL) so retired
   * observations don't push the active count over the cap.
   */
  private async enforceObservationCap(userId: string): Promise<void> {
    const activeFilter = and(
      eq(playerObservations.userId, userId),
      eq(playerObservations.archived, false),
      sql`${playerObservations.validUntil} IS NULL`,
    );

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(playerObservations)
      .where(activeFilter);

    const count = Number(countResult[0]?.count ?? 0);
    if (count <= MAX_ACTIVE_OBSERVATIONS) return;

    const excess = count - MAX_ACTIVE_OBSERVATIONS;

    // Retire oldest active observations bi-temporally (sets validUntil + archived
    // for back-compat). Archived/retired rows survive for historical queries.
    const toArchive = await this.db
      .select({ id: playerObservations.id })
      .from(playerObservations)
      .where(activeFilter)
      .orderBy(asc(playerObservations.lastSeenAt))
      .limit(excess);

    const now = new Date();
    for (const row of toArchive) {
      await this.db
        .update(playerObservations)
        .set({ archived: true, validUntil: now })
        .where(eq(playerObservations.id, row.id));
    }
  }

  /**
   * Extract observations from a completed coaching report.
   * No LLM calls — all text comes from existing report fields.
   *
   * Three sanitizers run on every candidate observation BEFORE it's accepted:
   *   - meta filter — drops pipeline messages like "AI match-summary was
   *     unavailable" that shouldn't be player-facing beliefs
   *   - jargon filter — replaces internal terms ("LIT") with player English
   *   - agent-leak filter — strips agent-specific ability names ("Fakeout
   *     (Q)") so observations don't carry one agent's kit into another
   *     agent's coaching when retrieved later
   *
   * The (now removed) "X of N deaths caused by Y" rule was producing
   * statistical observations the player couldn't agree/disagree with — the
   * underlying signal already lives in BKT skill mastery, surfacing it as
   * a habit was duplicating + bothering the user.
   */
  private extractObservations(report: any): RawObservation[] {
    const observations: RawObservation[] = [];
    if (!report) return observations;

    const sanitize = (text: string): string | null => {
      if (!text) return null;
      const trimmed = text.trim();
      if (trimmed.length === 0) return null;

      // Drop pipeline / system messages — these are not coaching beliefs.
      if (META_MESSAGE_REGEX.test(trimmed)) return null;
      // Drop pure stats — "4 of 10 deaths caused by X" can't be agreed/disagreed.
      if (PURE_STATS_REGEX.test(trimmed)) return null;

      let cleaned = trimmed;
      // Strip agent-specific ability names. "Fakeout (Q)" → "your Q ability"
      // so a Yoru observation doesn't poison a later Phoenix chat. The slot
      // letter is preserved so coaching can still distinguish between
      // info-tools (Q) and setups (E) generically.
      cleaned = cleaned.replace(ABILITY_NAME_PAREN_REGEX, 'your $2 ability');
      // Also handle "Q Fakeout" / "C Blindside" prefix style.
      cleaned = cleaned.replace(ABILITY_NAME_PREFIX_REGEX, 'your $1 ability');
      // De-jargon LIT → ready.
      cleaned = cleaned.replace(/\bLIT\b/g, 'ready');
      cleaned = cleaned.replace(/\blit\b(?=[\s,.;)])/g, 'ready');
      return cleaned;
    };

    const push = (category: RawObservation['category'], rawText: string) => {
      const cleaned = sanitize(rawText);
      if (cleaned) observations.push({ category, text: cleaned });
    };

    // 1. Priority issue → habit
    const pri = report.priorityIssue ?? report.priority_pattern ?? report.priority_issue;
    if (pri?.title) {
      const detail = pri.what_happened ?? pri.root_cause ?? '';
      const fix = pri.what_to_do ?? pri.fix ?? '';
      push('habit', [pri.title, detail, fix].filter(Boolean).join(' — '));
    }

    // 2. Secondary issues → habits
    const secs =
      report.secondaryIssues ?? report.secondary_patterns ?? report.secondary_issues ?? [];
    for (const s of secs) {
      if (!s?.title) continue;
      const detail = s.what_happened ?? s.root_cause ?? '';
      const fix = s.what_to_do ?? s.fix ?? '';
      push('habit', [s.title, detail, fix].filter(Boolean).join(' — '));
    }

    // 3. Strengths → strengths
    //    Filter out negatively-worded entries — Gemini sometimes lists
    //    critiques in `strengths[]` ("you were not consistently pushing
    //    fights at low HP") which then show up as agree/disagree confusion.
    const strengths = report.strengths ?? [];
    for (const st of strengths) {
      const text = typeof st === 'string' ? st : (st?.description ?? '');
      if (text && !NEGATIVE_STRENGTH_REGEX.test(text)) {
        push('strength', text);
      }
    }

    // 4. Coaching continuity progress note → insight
    const continuity = report.coachingContinuity ?? report.coaching_continuity;
    if (continuity?.progress_note) {
      push('insight', continuity.progress_note);
    }

    // 5. Ability anti-pattern findings → habits (X3c)
    //    Each anti-pattern detected by ability-anti-patterns.ts becomes a
    //    habit observation. Cross-game frequency emerges naturally because
    //    storeWithDedup() bumps `occurrences` when the same habitKey-flavored
    //    text shows up in subsequent games.
    const findings = report.abilityFindings ?? [];
    if (Array.isArray(findings)) {
      const groupedByHabit = new Map<string, { count: number; sample: string }>();
      for (const f of findings) {
        if (!f?.habitKey || !f?.text) continue;
        const existing = groupedByHabit.get(f.habitKey);
        if (existing) existing.count++;
        else groupedByHabit.set(f.habitKey, { count: 1, sample: f.text });
      }
      for (const [habitKey, data] of groupedByHabit) {
        push('habit', `${habitKey}: ${data.sample}`);
      }
    }

    // 6. Ability positive-pattern findings → strengths (X4)
    //    Mirror of rule 5 but for the WHAT-WORKED block. Each positive
    //    becomes a `strength` observation; cross-game consistency naturally
    //    accumulates via dedup-merge so a player who consistently nails
    //    setup deployment ends up with a high-occurrence strength.
    const wins = report.abilityWins ?? [];
    if (Array.isArray(wins)) {
      for (const w of wins) {
        if (!w?.habitKey || !w?.text) continue;
        push('strength', `${w.habitKey}: ${w.text}`);
      }
    }

    return observations;
  }

  /**
   * Format observations into a context block for prompt injection.
   */
  private formatContextBlock(observations: Observation[]): string {
    if (observations.length === 0) return '';

    const habits = observations.filter((o) => o.category === 'habit');
    const strengths = observations.filter((o) => o.category === 'strength');
    const insights = observations.filter((o) => o.category === 'insight');

    const lines: string[] = [];

    if (habits.length > 0) {
      lines.push('RECURRING HABITS:');
      for (const h of habits) {
        lines.push(`  \u2022 [seen ${h.occurrences}\u00d7] ${h.text}`);
      }
    }

    if (strengths.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('STRENGTHS:');
      for (const s of strengths) {
        lines.push(`  \u2022 [seen ${s.occurrences}\u00d7] ${s.text}`);
      }
    }

    if (insights.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('INSIGHTS:');
      for (const ins of insights) {
        lines.push(`  \u2022 ${ins.text}`);
      }
    }

    return lines.join('\n');
  }
}
