/**
 * Consolidation Service — Post-session brain processing ("sleep").
 *
 * After each enrichment, orchestrates:
 *   1. FadeMem importance decay on graph nodes (relevance × frequency × recency)
 *   2. Pattern merging — dedup similar pattern nodes via category matching
 *   3. LLM reflection — every 3 games, generate higher-level concept nodes
 *
 * Inspired by:
 *   - CLS Theory: consolidation happens between sessions, not during
 *   - FadeMem: intelligent forgetting (82% fact retention at 55% storage)
 *   - Generative Agents: importance-threshold triggered reflections
 *   - TraceMem: narrative threads from raw observations
 */

import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { Db } from '../../db/index.js';
import {
  coachingGraphEdges,
  coachingGraphNodes,
  coachingReports,
  playerSkillMastery,
} from '../../db/schema.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Reflection triggers after this many games without one */
const REFLECTION_INTERVAL = 3;

/** Max concept/reflection nodes per user (prevents unbounded growth) */
const MAX_REFLECTION_NODES = 50;

/** FadeMem decay parameters */
const DECAY = {
  /** Base decay rate per game for event nodes (deaths) */
  event: 0.88,
  /** Base decay rate per game for pattern nodes */
  pattern: 0.93,
  /** Base decay rate per game for game nodes */
  game: 0.9,
  /** Concept/reflection nodes decay very slowly */
  concept: 0.98,
  /** Minimum importance before node becomes prunable */
  floor: 0.03,
};

/** Phase 7C — data lifecycle retention tiers */
const LIFECYCLE = {
  /** After this many days, strip bulky fields from report JSONB */
  SLIM_REPORTS_AFTER_DAYS: 30,
  /** After this many days, prune low-importance graph nodes (preserving permanent types) */
  PRUNE_NODES_AFTER_DAYS: 180,
  /** Importance floor below which cold nodes get pruned */
  PRUNE_IMPORTANCE_BELOW: 0.2,
  /** After this many days, archive low-confidence observations */
  ARCHIVE_OBSERVATIONS_AFTER_DAYS: 60,
  /** Confidence below this counts as low for archiving */
  LOW_CONFIDENCE_BELOW: 0.3,
  /** Node types never touched by pruning (permanent memory) */
  PERMANENT_NODE_TYPES: ['era', 'skill', 'reflection'] as string[],
};

/** Gemini model for reflection generation (text-only, cheap) */
const REFLECTION_MODEL = 'gemini-2.5-flash-lite';

// ── Service ──────────────────────────────────────────────────────────────────

export class ConsolidationService {
  constructor(private db: Db) {}

  /**
   * Run full consolidation after a game enrichment.
   * Called post-enrichment — non-blocking, non-fatal.
   */
  async consolidate(userId: string): Promise<{
    decayed: number;
    merged: number;
    reflected: boolean;
    slimmed: number;
    pruned: number;
    archivedObs: number;
  }> {
    let decayed = 0;
    let merged = 0;
    let reflected = false;
    let slimmed = 0;
    let pruned = 0;
    let archivedObs = 0;

    // Each step is independently fault-tolerant.
    try {
      decayed = await this.applyFadeMemDecay(userId);
    } catch (err) {
      console.warn('[Consolidation] decay:', err instanceof Error ? err.message : err);
    }

    try {
      merged = await this.mergePatterns(userId);
    } catch (err) {
      console.warn('[Consolidation] merge:', err instanceof Error ? err.message : err);
    }

    try {
      reflected = await this.maybeReflect(userId);
    } catch (err) {
      console.warn('[Consolidation] reflect:', err instanceof Error ? err.message : err);
    }

    // Phase 7C — retention tiers. Cheap per-run; safe to call every enrichment.
    try {
      slimmed = await this.slimOldReports(userId);
    } catch (err) {
      console.warn('[Consolidation] slim:', err instanceof Error ? err.message : err);
    }

    try {
      pruned = await this.pruneColdNodes(userId);
    } catch (err) {
      console.warn('[Consolidation] prune:', err instanceof Error ? err.message : err);
    }

    try {
      archivedObs = await this.archiveOrphanedObservations(userId);
    } catch (err) {
      console.warn('[Consolidation] archive:', err instanceof Error ? err.message : err);
    }

    if (slimmed > 0 || pruned > 0 || archivedObs > 0) {
      console.log(
        '[Consolidation] lifecycle: slimmed %d reports, pruned %d cold nodes, archived %d observations',
        slimmed,
        pruned,
        archivedObs,
      );
    }

    console.log(
      '[Consolidation] User %s: decayed %d, merged %d, reflection=%s',
      userId,
      decayed,
      merged,
      reflected,
    );

    return { decayed, merged, reflected, slimmed, pruned, archivedObs };
  }

  /**
   * Sweep users who haven't had a recent enrichment and run consolidation
   * for each. Keeps decay/pruning/slim moving for idle users — without this
   * a player who stops uploading sees their old graph nodes hold stale
   * importance forever.
   *
   * Bounds:
   *   - Last completed report between 24h and 60d ago (active but not just-now)
   *   - At most `maxUsers` users per sweep to keep wall-clock predictable
   */
  async consolidateStaleUsers(maxUsers = 200): Promise<{
    swept: number;
    failed: number;
  }> {
    let swept = 0;
    let failed = 0;

    let userRows: Array<{ user_id: string }> = [];
    try {
      const result = await this.db.execute(sql`
        SELECT user_id
        FROM coaching_reports
        WHERE status = 'completed' AND completed_at IS NOT NULL
        GROUP BY user_id
        HAVING MAX(completed_at) < NOW() - INTERVAL '24 hours'
           AND MAX(completed_at) > NOW() - INTERVAL '60 days'
        ORDER BY MAX(completed_at) DESC
        LIMIT ${maxUsers}
      `);
      userRows = ((result as any).rows ?? result) as Array<{ user_id: string }>;
    } catch (err) {
      console.warn(
        '[Consolidation] stale-user query failed:',
        err instanceof Error ? err.message : err,
      );
      return { swept: 0, failed: 0 };
    }

    for (const row of userRows) {
      try {
        await this.consolidate(row.user_id);
        swept++;
      } catch (err) {
        failed++;
        console.warn(
          '[Consolidation] sweep failed for user %s:',
          row.user_id,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      '[Consolidation] Stale-user sweep done: %d swept, %d failed (of %d candidates)',
      swept,
      failed,
      userRows.length,
    );
    return { swept, failed };
  }

  // ── Phase 7C — Data lifecycle tiers ──────────────────────────────────────

  /**
   * Strip bulky/transient fields from report JSONB for reports older than
   * SLIM_REPORTS_AFTER_DAYS. Keeps all coaching content; drops raw VLM dump
   * and debug fields. Conservative — only fields we know are unused.
   */
  private async slimOldReports(userId: string): Promise<number> {
    const cutoff = new Date(Date.now() - LIFECYCLE.SLIM_REPORTS_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const targetReports = await this.db
      .select({
        id: coachingReports.id,
        report: coachingReports.report,
      })
      .from(coachingReports)
      .where(and(eq(coachingReports.userId, userId), lt(coachingReports.createdAt, cutoff)))
      .limit(20); // small batch per run

    let slimmed = 0;
    for (const row of targetReports) {
      const r = row.report as Record<string, unknown> | null;
      if (!r || typeof r !== 'object') continue;

      const next = { ...r };
      let changed = false;

      // Raw VLM dump (planned in canonical v3)
      if ('vlmRaw' in next && next.vlmRaw !== null) {
        next.vlmRaw = undefined;
        changed = true;
      }

      // Debug scratch
      for (const k of Object.keys(next)) {
        if (k.startsWith('__') && k.endsWith('__')) {
          delete (next as any)[k];
          changed = true;
        }
      }

      // Raw legacy `moments` field — unused by current UI, kept for v1 only
      if (Array.isArray(next.moments) && (next.moments as unknown[]).length > 0) {
        next.moments = [];
        changed = true;
      }

      if (!changed) continue;

      await this.db
        .update(coachingReports)
        .set({ report: next })
        .where(eq(coachingReports.id, row.id));
      slimmed++;
    }

    return slimmed;
  }

  /**
   * Prune cold graph nodes older than PRUNE_NODES_AFTER_DAYS with importance
   * below PRUNE_IMPORTANCE_BELOW. Preserves permanent node types entirely.
   * Preserves hypotheses that the player has CONFIRMED (negative signals from
   * rejected ones get pruned normally — their job is done).
   */
  private async pruneColdNodes(userId: string): Promise<number> {
    const cutoff = new Date(Date.now() - LIFECYCLE.PRUNE_NODES_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const permanent = LIFECYCLE.PERMANENT_NODE_TYPES;

    // Drizzle doesn't play nicely with NOT IN using arrays without a helper,
    // so we express the keep-set with raw SQL for clarity.
    const result = await this.db.execute(sql`
      DELETE FROM coaching_graph_nodes
      WHERE user_id = ${userId}
        AND created_at < ${cutoff}
        AND importance < ${LIFECYCLE.PRUNE_IMPORTANCE_BELOW}
        AND node_type NOT IN (${sql.join(
          permanent.map((t) => sql`${t}`),
          sql`, `,
        )})
        AND NOT (
          node_type = 'hypothesis'
          AND data ->> 'status' = 'confirmed'
        )
    `);

    return Number((result as any)?.rowCount ?? 0);
  }

  /**
   * Archive old low-confidence observations. Keeps the row (for embedding
   * durability + possible re-confirmation) but sets archived=true so it no
   * longer flows into prompt context or Brain panel.
   */
  private async archiveOrphanedObservations(userId: string): Promise<number> {
    const cutoff = new Date(
      Date.now() - LIFECYCLE.ARCHIVE_OBSERVATIONS_AFTER_DAYS * 24 * 60 * 60 * 1000,
    );

    const result = await this.db.execute(sql`
      UPDATE player_observations
      SET archived = true
      WHERE user_id = ${userId}
        AND archived = false
        AND last_seen_at < ${cutoff}
        AND COALESCE(confidence, 0.5) < ${LIFECYCLE.LOW_CONFIDENCE_BELOW}
    `);

    return Number((result as any)?.rowCount ?? 0);
  }

  // ── 1. FadeMem Importance Decay ───────────────────────────────────────────

  /**
   * Apply differentiated decay based on node type.
   * Unlike simple uniform decay, FadeMem uses:
   *   importance_new = importance_old × decay_rate^(age_factor)
   * where age_factor increases with time since last access.
   */
  private async applyFadeMemDecay(userId: string): Promise<number> {
    // Decay each node type with its own rate
    // Nodes accessed recently decay slower (recency bonus)
    const result = await this.db.execute(sql`
      UPDATE coaching_graph_nodes
      SET importance = GREATEST(
        ${DECAY.floor},
        importance * CASE node_type
          WHEN 'event'   THEN ${DECAY.event}
          WHEN 'pattern' THEN ${DECAY.pattern}
          WHEN 'game'    THEN ${DECAY.game}
          WHEN 'concept' THEN ${DECAY.concept}
          WHEN 'reflection' THEN ${DECAY.concept}
          WHEN 'skill'   THEN 1.0
          ELSE 0.95
        END
        * CASE
          WHEN last_accessed_at > now() - interval '7 days' THEN 1.0
          WHEN last_accessed_at > now() - interval '30 days' THEN 0.95
          ELSE 0.90
          END
      )
      WHERE user_id = ${userId}
        AND node_type != 'skill'
    `);

    return Number((result as any)?.rowCount ?? 0);
  }

  // ── 2. Pattern Merging ────────────────────────────────────────────────────

  /**
   * Merge pattern nodes that share the same category.
   * Instead of cosine similarity (requires embeddings), we use category + label overlap
   * to find patterns that should be consolidated.
   *
   * When merged: keep the newer node, transfer edges, boost importance.
   */
  private async mergePatterns(userId: string): Promise<number> {
    // Find pattern nodes grouped by category
    const patterns = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        importance: coachingGraphNodes.importance,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'pattern')))
      .orderBy(desc(coachingGraphNodes.createdAt));

    if (patterns.length < 2) return 0;

    // Group by category + label so only truly duplicate patterns are merged
    const byCategoryAndLabel = new Map<string, typeof patterns>();
    for (const p of patterns) {
      const cat = (p.data as any)?.category ?? 'unknown';
      const key = `${cat}::${p.label}`;
      const group = byCategoryAndLabel.get(key) ?? [];
      group.push(p);
      byCategoryAndLabel.set(key, group);
    }

    let mergeCount = 0;

    for (const [_key, group] of byCategoryAndLabel) {
      if (group.length < 2) continue;

      // Keep the newest pattern, merge older ones into it
      const [keeper, ...duplicates] = group;

      for (const dup of duplicates) {
        // Transfer edges from duplicate to keeper
        await this.db.execute(sql`
          UPDATE coaching_graph_edges
          SET target_id = ${keeper.id}
          WHERE target_id = ${dup.id}
            AND source_id != ${keeper.id}
        `);
        await this.db.execute(sql`
          UPDATE coaching_graph_edges
          SET source_id = ${keeper.id}
          WHERE source_id = ${dup.id}
            AND target_id != ${keeper.id}
        `);

        // Boost keeper's importance (accumulated evidence)
        const boostedImportance = Math.min(1.0, keeper.importance + dup.importance * 0.3);
        await this.db
          .update(coachingGraphNodes)
          .set({ importance: boostedImportance })
          .where(eq(coachingGraphNodes.id, keeper.id));

        // Delete duplicate (cascade deletes remaining edges)
        await this.db.delete(coachingGraphNodes).where(eq(coachingGraphNodes.id, dup.id));

        mergeCount++;
      }
    }

    return mergeCount;
  }

  // ── 3. LLM Reflection ────────────────────────────────────────────────────

  /**
   * Every REFLECTION_INTERVAL games, generate higher-level coaching reflections.
   * These become "concept" nodes in the graph — abstractions over raw events.
   *
   * Level 0: "Died peeking A main without flash" (event node — already exists)
   * Level 1: "Tends to dry-peek when holding defense" (pattern node — already exists)
   * Level 2: "Impatience under defensive pressure" (concept node — generated here)
   */
  private async maybeReflect(userId: string): Promise<boolean> {
    // Count games since last reflection
    const lastReflection = await this.db
      .select({ createdAt: coachingGraphNodes.createdAt })
      .from(coachingGraphNodes)
      .where(
        and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'reflection')),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(1);

    const lastReflectionDate = lastReflection[0]?.createdAt ?? new Date(0);

    // Count game nodes since last reflection
    const gamesSince = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'game'),
          gt(coachingGraphNodes.createdAt, lastReflectionDate),
        ),
      );

    const count = Number(gamesSince[0]?.count ?? 0);
    if (count < REFLECTION_INTERVAL) return false;

    // Gather context for reflection
    const context = await this.gatherReflectionContext(userId, lastReflectionDate);
    if (!context) return false;

    // Generate reflection via LLM
    const reflections = await this.generateReflection(context);
    if (!reflections || reflections.length === 0) return false;

    // Store as concept nodes
    for (const reflection of reflections) {
      const [node] = await this.db
        .insert(coachingGraphNodes)
        .values({
          userId,
          nodeType: 'reflection',
          label: reflection.title,
          data: {
            insight: reflection.insight,
            evidence: reflection.evidence,
            gamesAnalyzed: count,
            generatedAt: new Date().toISOString(),
          },
          importance: 0.85, // reflections start high importance
        })
        .returning();

      // Link reflection to relevant pattern nodes
      const relatedPatterns = await this.db
        .select({ id: coachingGraphNodes.id })
        .from(coachingGraphNodes)
        .where(
          and(
            eq(coachingGraphNodes.userId, userId),
            eq(coachingGraphNodes.nodeType, 'pattern'),
            gt(coachingGraphNodes.createdAt, lastReflectionDate),
          ),
        )
        .limit(5);

      for (const pattern of relatedPatterns) {
        await this.db.insert(coachingGraphEdges).values({
          sourceId: pattern.id,
          targetId: node.id,
          edgeType: 'related_to',
          weight: 0.8,
        });
      }
    }

    // Enforce reflection node cap
    await this.enforceReflectionCap(userId);

    console.log('[Consolidation] Generated %d reflections for user %s', reflections.length, userId);
    return true;
  }

  /**
   * Gather context from recent games, patterns, and skill mastery for the reflection prompt.
   */
  private async gatherReflectionContext(userId: string, sinceDate: Date): Promise<string | null> {
    // Get recent game summaries
    const recentGames = await this.db
      .select({
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
      })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'game'),
          gt(coachingGraphNodes.createdAt, sinceDate),
        ),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(5);

    if (recentGames.length === 0) return null;

    // Get recent patterns
    const recentPatterns = await this.db
      .select({
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        importance: coachingGraphNodes.importance,
      })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'pattern'),
          gt(coachingGraphNodes.createdAt, sinceDate),
        ),
      )
      .orderBy(desc(coachingGraphNodes.importance))
      .limit(10);

    // Get current skill mastery (weakest + strongest)
    const skills = await this.db
      .select({
        skillId: playerSkillMastery.skillId,
        domain: playerSkillMastery.domain,
        pMastery: playerSkillMastery.pMastery,
        trend: playerSkillMastery.trend,
        observations: playerSkillMastery.observations,
      })
      .from(playerSkillMastery)
      .where(and(eq(playerSkillMastery.userId, userId), gt(playerSkillMastery.observations, 0)))
      .orderBy(playerSkillMastery.pMastery)
      .limit(20);

    // Get previous reflections for continuity
    const prevReflections = await this.db
      .select({
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
      })
      .from(coachingGraphNodes)
      .where(
        and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'reflection')),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(3);

    // Build context string
    const lines: string[] = [];

    lines.push('RECENT GAMES:');
    for (const g of recentGames) {
      const d = g.data as any;
      lines.push(`  - ${g.label} | ${d.deaths ?? '?'} deaths | Verdict: ${d.verdict ?? 'n/a'}`);
    }

    if (recentPatterns.length > 0) {
      lines.push('\nRECURRING PATTERNS:');
      for (const p of recentPatterns) {
        const d = p.data as any;
        lines.push(`  - [${d.category ?? '?'}] ${p.label}: ${d.whatHappened ?? ''}`);
      }
    }

    if (skills.length > 0) {
      const weakest = skills.slice(0, 3);
      const strongest = skills.slice(-3).reverse();
      lines.push('\nSKILL MASTERY:');
      lines.push('  Weakest:');
      for (const s of weakest) {
        lines.push(`    - ${s.skillId}: ${(s.pMastery * 100).toFixed(0)}% (${s.trend})`);
      }
      lines.push('  Strongest:');
      for (const s of strongest) {
        lines.push(`    - ${s.skillId}: ${(s.pMastery * 100).toFixed(0)}% (${s.trend})`);
      }
    }

    if (prevReflections.length > 0) {
      lines.push('\nPREVIOUS COACHING INSIGHTS:');
      for (const r of prevReflections) {
        const d = r.data as any;
        lines.push(`  - ${r.label}: ${d.insight ?? ''}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Call LLM to generate higher-level coaching reflections from raw context.
   */
  private async generateReflection(
    context: string,
  ): Promise<{ title: string; insight: string; evidence: string }[] | null> {
    if (!env.GEMINI_API_KEY) {
      console.warn('[Consolidation] GEMINI_API_KEY not set — skipping reflection');
      return null;
    }

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

      const prompt = `You are an expert FPS coaching analyst reviewing a player's recent Valorant performance.

Based on the data below, generate 1-3 higher-level coaching insights. These should be ABSTRACTIONS — not restating what happened, but identifying deeper patterns, connections between issues, or root causes.

Good insight: "Economy management and aggression are linked — when this player force-buys, they feel pressure to make aggressive plays to justify the purchase, leading to predictable deaths."
Bad insight: "Player died a lot from peeking." (too surface-level)

Good insight: "Mechanical fundamentals are solid but game sense lags — this player wins aim duels but takes unfavorable fights. Coaching should focus on WHEN to fight, not HOW."
Bad insight: "Player needs to improve positioning." (too generic)

${context}

Respond with a JSON array of objects with fields: title (short, 5-10 words), insight (1-2 sentences connecting dots), evidence (which data points support this).
Return at most 3 insights. If the data is too sparse for meaningful abstraction, return an empty array [].`;

      const response = await ai.models.generateContent({
        model: REFLECTION_MODEL,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      });

      const text = response.text ?? '';
      const parsed = JSON.parse(text);

      if (!Array.isArray(parsed)) return null;

      return parsed
        .filter((r: any) => r.title && r.insight)
        .slice(0, 3)
        .map((r: any) => ({
          title: String(r.title).slice(0, 100),
          insight: String(r.insight).slice(0, 500),
          evidence: String(r.evidence ?? '').slice(0, 300),
        }));
    } catch (err) {
      console.warn(
        '[Consolidation] Reflection LLM call failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Cap reflection nodes to prevent unbounded growth.
   */
  private async enforceReflectionCap(userId: string): Promise<void> {
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingGraphNodes)
      .where(
        and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'reflection')),
      );

    const count = Number(countResult[0]?.count ?? 0);
    if (count <= MAX_REFLECTION_NODES) return;

    const excess = count - MAX_REFLECTION_NODES;

    await this.db.execute(sql`
      DELETE FROM coaching_graph_nodes
      WHERE id IN (
        SELECT id FROM coaching_graph_nodes
        WHERE user_id = ${userId} AND node_type = 'reflection'
        ORDER BY importance ASC, created_at ASC
        LIMIT ${excess}
      )
    `);
  }

  /**
   * Format recent reflections for prompt injection.
   */
  async formatReflectionsForPrompt(userId: string): Promise<string> {
    try {
      const reflections = await this.db
        .select({
          label: coachingGraphNodes.label,
          data: coachingGraphNodes.data,
        })
        .from(coachingGraphNodes)
        .where(
          and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'reflection')),
        )
        .orderBy(desc(coachingGraphNodes.importance))
        .limit(3);

      if (reflections.length === 0) return '';

      const lines: string[] = ['COACHING INSIGHTS (higher-level patterns):'];
      for (const r of reflections) {
        const d = r.data as any;
        lines.push(`  \u2022 ${r.label}: ${d.insight ?? ''}`);
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
