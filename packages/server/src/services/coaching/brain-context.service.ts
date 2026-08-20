/**
 * Brain Context Service — Unified assembler for all coaching brain layers.
 *
 * Replaces scattered try/catch context injection blocks in coaching.routes.ts
 * with a single call that gathers:
 *   1. Player observations (pgvector semantic memory)
 *   2. Skill mastery profile (BKT)
 *   3. Knowledge graph patterns
 *   4. Coaching reflections (higher-level insights)
 *   5. Strategy effectiveness (what coaching approaches work)
 *
 * Each layer is independently fault-tolerant — if one fails, the others still inject.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingGraphNodes, playerSkillMastery } from '../../db/schema.js';
import { ObservationService } from './observation.service.js';
import { SkillMasteryService } from './skill-mastery.service.js';
import { GraphService } from './graph.service.js';
import { StrategyService } from './strategy.service.js';
import { ConsolidationService } from './consolidation.service.js';
import { EraDetectionService } from './era-detection.service.js';
import { HypothesisGeneratorService } from './hypothesis-generator.service.js';
import { ProactiveCoachService } from './proactive-coach.service.js';
import { knowledgeService } from '../../jobs/index.js';
import { embedText } from './embedding.util.js';

// All Valorant agent canonical lowercase keys (matches game_knowledge entry_key).
// Used to detect agent mentions in user questions so the brain can pivot
// context. Maintained in sync with games/valorant/ability-categories.ts.
const KNOWN_AGENT_KEYS = [
  'jett',
  'phoenix',
  'reyna',
  'raze',
  'yoru',
  'neon',
  'iso',
  'waylay',
  'cypher',
  'killjoy',
  'sage',
  'chamber',
  'deadlock',
  'vyse',
  'veto',
  'brimstone',
  'omen',
  'viper',
  'astra',
  'harbor',
  'clove',
  'miks',
  'sova',
  'breach',
  'skye',
  'kayo',
  'fade',
  'gekko',
  'tejo',
];

/**
 * Detect agent mentions in a free-form user question.
 *
 * Lenient matching:
 *   - strips possessive "'s"  ("yoru's" → "yoru")
 *   - strips trailing "s"      ("vipers" → "viper", "yorus" → "yoru")
 *   - tolerates KAY/O variants ("kay/o" / "kayo" / "kay-o" all → "kayo")
 *
 * Returns ALL agents named, in the order they first appear. Caller decides
 * how to use them (single = pivot context; multiple = inject each kit so
 * Gemini can address them all rather than picking one).
 *
 * Capped at 3 to keep the prompt bounded — beyond that the question is
 * almost certainly a list and the brain should answer generically.
 */
function detectAgentsInQuestion(text: string | undefined): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();

  // Tokenize on non-alpha. Trims plurals and possessives token-by-token.
  const tokens = lower
    .split(/[^a-z]+/g)
    .map((t) => t.replace(/'s$/, ''))
    .map((t) => (/[a-z]{4,}s$/.test(t) ? t.slice(0, -1) : t))
    .filter(Boolean);

  const found: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (KNOWN_AGENT_KEYS.includes(tok) && !seen.has(tok)) {
      seen.add(tok);
      found.push(tok);
      if (found.length >= 3) break;
    }
  }
  return found;
}

// Phase 4 — inject player's committed focus (if any, within 24h) into prompt context.
const COMMITMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// M2 — bound the dynamic per-user block size. ~4 chars/token; 2500 chars ≈ 625
// tokens of brain context. Dropped lowest-priority blocks first if over budget.
const MAX_BRAIN_CHARS = 2500;

// Block priorities (highest = most likely to keep). focus_commitment is highest
// because it's a 24h-fresh user signal; strategies are lowest because they're
// telemetry, not advice the player needs. game_knowledge sits high because
// it's the cacheable static-per-agent reference the LLM needs to recognise
// ability names like "Gatecrash" or callouts like "A Hookah".
const BLOCK_PRIORITY: Record<string, number> = {
  focus_commitment: 100,
  game_knowledge: 90,
  skill_mastery: 80,
  observations: 70,
  graph: 60,
  reflections: 40,
  strategies: 20,
};

function formatFocusCommitmentBlock(focus: string, committedAt: Date): string {
  const hoursAgo = Math.max(0, Math.round((Date.now() - committedAt.getTime()) / (1000 * 60 * 60)));
  return `═══ PLAYER'S COMMITTED FOCUS (set ${hoursAgo}h ago) ═══

Before this game, the player explicitly chose this as their focus for this session:

  "${focus}"

Your job:
• In coaching_continuity.progress_note, evaluate specifically whether the player
  honored this commitment in THIS video. Be specific: count compliant vs.
  non-compliant moments if observable (e.g. "Committed to Leer-first — 4 of 8
  peeks honored").
• In priority_pattern or death_coaching, reference the commitment when relevant —
  praise success where they did it, name the miss where they broke it.
• Do NOT pivot to a different focus. The player chose THIS one. Respect it.`;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class BrainContextService {
  constructor(private db: Db) {}

  /**
   * Assemble full brain context for prompt injection.
   *
   * Pass `opts.queryText` to enable hybrid retrieval — observations are scored
   * by semantic similarity to the query in addition to frequency / recency /
   * confidence. Without a query we fall back to frequency × recency × conf.
   *
   * Output is a single string that callers should place at the END of their
   * system prompt (static rules first, dynamic player data last) so Gemini's
   * implicit caching can hit the stable prefix.
   */
  async assembleContext(userId: string, opts?: { queryText?: string }): Promise<string> {
    const observationSvc = new ObservationService(this.db);
    const skillSvc = new SkillMasteryService(this.db);
    const graphSvc = new GraphService(this.db);
    const strategySvc = new StrategyService(this.db);
    const consolidationSvc = new ConsolidationService(this.db);

    // Embed the question ONCE and share across observation + graph hybrid
    // retrieval. Saves one Gemini round-trip per chat turn vs. each layer
    // embedding the same text independently.
    let queryEmbedding: number[] | undefined;
    if (opts?.queryText && opts.queryText.trim().length > 0) {
      const v = await embedText(opts.queryText.trim());
      if (v) queryEmbedding = v;
    }

    // Detect ALL agent mentions in the user's question. When the question
    // names agents we:
    //   • pull each agent's kit into the game_knowledge block
    //   • boost observations tagged with any of those agents
    // When the question names no agent, both fall back to today's
    // "use most-recent" / "no agent boost" behaviour.
    const mentionedAgents = detectAgentsInQuestion(opts?.queryText);

    // Run brain layer queries in parallel (5 layers + Phase 4 focus commitment + game knowledge)
    const [observations, skills, graph, reflections, strategies, focusCommitment, gameKnowledge] =
      await Promise.allSettled([
        observationSvc.recallForSynthesis(userId, { queryEmbedding, agentFilter: mentionedAgents }),
        skillSvc.getMasteryProfile(userId),
        graphSvc.formatForPrompt(userId, { queryEmbedding }),
        consolidationSvc.formatReflectionsForPrompt(userId),
        strategySvc.getEffectiveStrategies(userId),
        this.getLatestFocusCommitment(userId),
        this.getGameKnowledgeBlock(userId, mentionedAgents),
      ]);

    // Collect (priority, text) pairs so we can drop low-priority blocks if
    // the combined size exceeds MAX_BRAIN_CHARS.
    const candidates: { kind: string; text: string }[] = [];

    if (observations.status === 'fulfilled' && observations.value.contextBlock) {
      candidates.push({ kind: 'observations', text: observations.value.contextBlock });
    }
    if (skills.status === 'fulfilled') {
      const block = skillSvc.formatForPrompt(skills.value);
      if (block) candidates.push({ kind: 'skill_mastery', text: block });
    }
    if (graph.status === 'fulfilled' && graph.value) {
      candidates.push({ kind: 'graph', text: graph.value });
    }
    if (reflections.status === 'fulfilled' && reflections.value) {
      candidates.push({ kind: 'reflections', text: reflections.value });
    }
    if (strategies.status === 'fulfilled') {
      const block = strategySvc.formatForPrompt(strategies.value);
      if (block) candidates.push({ kind: 'strategies', text: block });
    }
    if (focusCommitment.status === 'fulfilled' && focusCommitment.value) {
      candidates.push({
        kind: 'focus_commitment',
        text: formatFocusCommitmentBlock(
          focusCommitment.value.focus,
          focusCommitment.value.committedAt,
        ),
      });
    }
    if (gameKnowledge.status === 'fulfilled' && gameKnowledge.value) {
      candidates.push({ kind: 'game_knowledge', text: gameKnowledge.value });
    }

    if (candidates.length === 0) return '';

    // Sort by priority DESC, then take blocks until we run out of budget.
    candidates.sort((a, b) => (BLOCK_PRIORITY[b.kind] ?? 0) - (BLOCK_PRIORITY[a.kind] ?? 0));

    const kept: { kind: string; text: string }[] = [];
    let used = 0;
    for (const c of candidates) {
      const cost = c.text.length + 2; // +2 for the "\n\n" separator between blocks
      if (used + cost > MAX_BRAIN_CHARS && kept.length > 0) continue;
      kept.push(c);
      used += cost;
    }

    // Re-sort kept blocks back to a readable display order. game_knowledge
    // first (static-per-agent — also stays at the cache prefix), then mastery
    // → memory → graph → reflections → strategies → focus commitment last so
    // it's the freshest signal next to the user's question.
    const displayOrder: Record<string, number> = {
      game_knowledge: 0,
      skill_mastery: 1,
      observations: 2,
      graph: 3,
      reflections: 4,
      strategies: 5,
      focus_commitment: 6,
    };
    kept.sort((a, b) => (displayOrder[a.kind] ?? 99) - (displayOrder[b.kind] ?? 99));

    return kept.map((c) => c.text).join('\n\n');
  }

  /**
   * Build a concise "AGENT KIT REFERENCE" block from the player's most-played
   * agent (and map, if known) across their last 5 completed reports.
   *
   * Without this, Gemini-2.5-flash-lite reliably fails to recognise ability
   * names like "Gatecrash" — even when they're elsewhere in the player data.
   * The block is static per-agent, so it sits at the head of the brain
   * context and benefits from Gemini's implicit prompt cache.
   *
   * Returns empty string when no recent reports exist or the knowledge cache
   * has no matching entry (gracefully degrades — better than blocking).
   */
  private async getGameKnowledgeBlock(userId: string, mentionedAgents?: string[]): Promise<string> {
    try {
      // Agent/map can live in any of: dedicated column, report JSONB
      // (`detectedAgent` from VLM), or the underlying match row. Coalesce
      // across all so we don't whiff just because the column wasn't backfilled.
      const result = await this.db.execute(sql`
        SELECT
          COALESCE(
            cr.resolved_agent,
            cr.report->>'detectedAgent',
            cr.report->>'agent',
            m.user_confirmed_agent,
            m.agent
          ) AS agent,
          COALESCE(
            cr.resolved_map,
            cr.report->>'detectedMap',
            cr.report->>'map',
            m.user_confirmed_map,
            m.map
          ) AS map
        FROM coaching_reports cr
        LEFT JOIN matches m ON m.id = ANY(cr.match_ids)
        WHERE cr.user_id = ${userId}
          AND cr.status = 'completed'
        ORDER BY cr.created_at DESC
        LIMIT 8
      `);
      const recent = ((result as any).rows ?? result) as Array<{
        agent: string | null;
        map: string | null;
      }>;

      if (recent.length === 0 && (!mentionedAgents || mentionedAgents.length === 0)) return '';

      // Pick agents to render kit blocks for:
      //   1. ALL agents the user explicitly named in the question (multi-agent)
      //   2. If none, the most-recent agent (default — single block)
      // Map is only meaningful for the recent-game default; for explicitly
      // named agents we skip the map block (could be from any historical game).
      let agentsToRender: { agent: string; map: string | null }[] = [];
      if (mentionedAgents && mentionedAgents.length > 0) {
        agentsToRender = mentionedAgents.map((a) => {
          const matchedRow = recent.find((r) => r.agent && r.agent.toLowerCase() === a);
          return { agent: matchedRow?.agent ?? a, map: matchedRow?.map ?? null };
        });
      } else {
        const firstWith = (key: 'agent' | 'map') => recent.find((r) => r[key])?.[key] ?? null;
        const topAgent = firstWith('agent');
        const topMap = firstWith('map');
        if (!topAgent) return '';
        agentsToRender = [{ agent: topAgent, map: topMap }];
      }

      // Render one section per agent, joined by separators. The PLAYER
      // DATA / KIT structure stays identical to the single-agent case.
      const sections: string[] = [];
      for (const { agent: topAgent, map: topMap } of agentsToRender) {
        const section = await this.renderAgentSection(userId, topAgent, topMap);
        if (section) sections.push(section);
      }
      return sections.join('\n\n─────────\n\n');
    } catch (err) {
      console.warn(
        '[Brain] game knowledge fetch failed:',
        err instanceof Error ? err.message : err,
      );
      return '';
    }
  }

  /** Render one agent's PLAYER DATA + KIT + (optional) MAP block. */
  private async renderAgentSection(
    userId: string,
    topAgent: string,
    topMap: string | null,
  ): Promise<string> {
    try {
      // Normalize for entry-key lookup. The knowledge store stores keys as
      // lowercase ASCII (e.g. "kayo", "yoru"); incoming display names may
      // contain slashes ("KAY/O"), apostrophes, accents, or hyphens.
      const normalizeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const agentKey = normalizeKey(topAgent);
      const agentEntry = knowledgeService.getEntryWithFallback('valorant', 'agent', agentKey);
      const lines: string[] = [];

      // ── Honesty signal: count actual player data on this agent ─────────
      // Without this Gemini sees the kit and assumes the player has played
      // this agent, leading to fabricated specifics ("you often place
      // Refract beacon X"). With explicit counts she can either ground in
      // real observations or admit there's no data.
      const dataCheck = await this.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM coaching_reports
            WHERE user_id = ${userId}
              AND status = 'completed'
              AND LOWER(COALESCE(resolved_agent, report->>'detectedAgent', report->>'agent')) = ${agentKey}
          ) AS games,
          (SELECT COUNT(*) FROM player_observations
            WHERE user_id = ${userId}
              AND archived = false
              AND valid_until IS NULL
              AND agent = ${agentKey}
          ) AS observations
      `);
      const counts = (((dataCheck as any).rows ?? dataCheck)[0] ?? {
        games: 0,
        observations: 0,
      }) as { games: number | string; observations: number | string };
      const games = Number(counts.games ?? 0);
      const observationsCount = Number(counts.observations ?? 0);
      if (agentEntry) {
        const md = (agentEntry.mergedData ?? {}) as Record<string, unknown>;
        const role = typeof md.role === 'string' ? md.role : '';
        const abilities = typeof md.abilities === 'string' ? md.abilities : '';
        const flags = typeof md.flags === 'string' ? md.flags : '';

        // Player-data signal goes FIRST so Gemini sees it before the kit
        // and grounds her language ("you've played" vs "general advice").
        if (games === 0) {
          lines.push(
            `PLAYER DATA ON ${agentEntry.displayName}: NONE — this player has never had ${agentEntry.displayName} games analyzed. The kit below is for REFERENCE ONLY. Do not invent specific habits like "you often X" or "we've seen you Y" — give general kit guidance instead and tell the player you have no specific data on their ${agentEntry.displayName} play.`,
          );
        } else if (observationsCount === 0) {
          lines.push(
            `PLAYER DATA ON ${agentEntry.displayName}: ${games} game(s) analyzed but 0 specific observations stored. Reference general kit principles only — do not claim specific habits.`,
          );
        } else {
          lines.push(
            `PLAYER DATA ON ${agentEntry.displayName}: ${games} game(s) analyzed, ${observationsCount} specific observation(s). You may reference these grounded in the OBSERVATIONS block.`,
          );
        }
        lines.push('');

        lines.push(`AGENT KIT — ${agentEntry.displayName}${role ? ` (${role})` : ''}:`);
        if (abilities) {
          // The static knowledge stores abilities as a multi-line string —
          // indent each line for prompt readability.
          for (const line of abilities.split('\n')) {
            if (line.trim()) lines.push(`  ${line.trim()}`);
          }
        }
        if (flags) {
          lines.push('');
          lines.push(
            `Common ${agentEntry.displayName} mistakes (from coaching corpus, NOT this player's data):`,
          );
          for (const line of flags.split('\n')) {
            const stripped = line.trim().replace(/^[•\-*]\s*/, '');
            if (stripped) lines.push(`  • ${stripped}`);
          }
        }
      }

      if (topMap) {
        const mapEntry = knowledgeService.getEntryWithFallback(
          'valorant',
          'map',
          normalizeKey(topMap),
        );
        if (mapEntry) {
          const md = (mapEntry.mergedData ?? {}) as Record<string, unknown>;
          const callouts = typeof md.callouts === 'string' ? md.callouts : '';
          const tips =
            typeof md.tips === 'string'
              ? md.tips
              : typeof md.expectation === 'string'
                ? md.expectation
                : '';
          if (callouts || tips) {
            if (lines.length > 0) lines.push('');
            lines.push(`MAP — ${mapEntry.displayName}:`);
            if (callouts) lines.push(`  Callouts: ${callouts.replace(/\n/g, ', ')}`);
            if (tips) lines.push(`  ${tips}`);
          }
        }
      }

      return lines.join('\n');
    } catch (err) {
      console.warn(
        '[Brain] game knowledge fetch failed:',
        err instanceof Error ? err.message : err,
      );
      return '';
    }
  }

  /**
   * Fetch the user's most-recent focus commitment, if any, within the last 24h.
   * Older commitments stay in the graph as history but don't auto-inject into prompts.
   */
  private async getLatestFocusCommitment(
    userId: string,
  ): Promise<{ focus: string; committedAt: Date } | null> {
    try {
      const rows = await this.db
        .select({
          label: coachingGraphNodes.label,
          createdAt: coachingGraphNodes.createdAt,
        })
        .from(coachingGraphNodes)
        .where(
          and(
            eq(coachingGraphNodes.userId, userId),
            eq(coachingGraphNodes.nodeType, 'focus_commitment'),
          ),
        )
        .orderBy(desc(coachingGraphNodes.createdAt))
        .limit(1);

      if (rows.length === 0) return null;
      const ageMs = Date.now() - rows[0].createdAt.getTime();
      if (ageMs > COMMITMENT_WINDOW_MS) return null;
      return { focus: rows[0].label, committedAt: rows[0].createdAt };
    } catch (err) {
      console.warn(
        '[Brain] focus commitment fetch failed:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Run all post-enrichment brain updates.
   * Called after enrichment succeeds — updates all brain layers from the report.
   */
  async updateFromReport(
    userId: string,
    reportId: string,
    report: any,
    agent?: string,
    map?: string,
  ): Promise<{
    observations: number;
    skills: number;
    graphNodes: number;
    graphEdges: number;
    strategies: number;
    consolidated: boolean;
  }> {
    const result = {
      observations: 0,
      skills: 0,
      graphNodes: 0,
      graphEdges: 0,
      strategies: 0,
      consolidated: false,
    };

    // 1. Extract and store observations
    try {
      const svc = new ObservationService(this.db);
      result.observations = await svc.extractAndStore(userId, reportId, report);
    } catch (err) {
      console.warn(
        '[Brain] Observation extraction failed:',
        err instanceof Error ? err.message : err,
      );
    }

    // 2. Update skill mastery via BKT
    try {
      const svc = new SkillMasteryService(this.db);
      const masteryResult = await svc.updateFromReport(userId, report, agent);
      result.skills = masteryResult.updated;
    } catch (err) {
      console.warn(
        '[Brain] Skill mastery update failed:',
        err instanceof Error ? err.message : err,
      );
    }

    // 3. Ingest into knowledge graph
    try {
      const svc = new GraphService(this.db);
      const graphResult = await svc.ingestReport(userId, reportId, report, agent, map);
      result.graphNodes = graphResult.nodes;
      result.graphEdges = graphResult.edges;
      // Best-effort: fill embeddings on older nodes that were inserted before
      // the embed plumbing landed. Bounded by BACKFILL_BATCH so per-call cost
      // stays predictable. Failure here doesn't block any other layer.
      svc
        .backfillEmbeddings(userId)
        .catch((err) =>
          console.warn('[Brain] Graph backfill failed:', err instanceof Error ? err.message : err),
        );
    } catch (err) {
      console.warn('[Brain] Graph ingestion failed:', err instanceof Error ? err.message : err);
    }

    // 4. Record coaching strategies used
    try {
      const svc = new StrategyService(this.db);
      const stratResult = await svc.recordStrategiesFromReport(userId, report);
      result.strategies = stratResult.recorded;

      // Also update Q-values based on current skill trends
      await svc.updateQValues(userId);
    } catch (err) {
      console.warn('[Brain] Strategy recording failed:', err instanceof Error ? err.message : err);
    }

    // 5. Run consolidation (decay, merge, reflect)
    try {
      const svc = new ConsolidationService(this.db);
      const consResult = await svc.consolidate(userId);
      result.consolidated = consResult.reflected;
    } catch (err) {
      console.warn('[Brain] Consolidation failed:', err instanceof Error ? err.message : err);
    }

    // 6. Era detection (Phase 5 — Living Mind)
    //    Runs AFTER skill mastery update and graph ingestion. Checks if the
    //    active era's primary skill graduated, closes it if so, starts a new
    //    era if conditions met. Safe to call on every enrichment.
    const proactive = new ProactiveCoachService(this.db);
    try {
      const svc = new EraDetectionService(this.db);
      const eraResult = await svc.detectAndUpdate(userId);
      if (eraResult.closed) {
        console.log('[Brain] Era closed: %s', eraResult.closed.label);
        try {
          await proactive.notifyEraClosed(userId, eraResult.closed);
        } catch (e) {
          console.warn('[Brain] proactive(era_closed):', e instanceof Error ? e.message : e);
        }
      }
      if (eraResult.opened) {
        console.log('[Brain] Era opened: %s', eraResult.opened.label);
        try {
          await proactive.notifyEraStarted(userId, eraResult.opened);
        } catch (e) {
          console.warn('[Brain] proactive(era_started):', e instanceof Error ? e.message : e);
        }
      }
    } catch (err) {
      console.warn('[Brain] Era detection failed:', err instanceof Error ? err.message : err);
    }

    // 7. Hypothesis generation (Phase 7B — Living Mind belief tiers)
    //    Generates up to 3 tentative hypotheses about the player (agent
    //    variance, map variance, recurring pattern) for them to confirm or
    //    reject. Deduped by category + 14-day cooldown.
    try {
      const svc = new HypothesisGeneratorService(this.db);
      const hResult = await svc.generateIfNeeded(userId);
      if (hResult.created > 0) {
        console.log('[Brain] %d new hypothesis(es) generated', hResult.created);
        // Fire a proactive coach message for each new hypothesis.
        // The service itself handles dedup + unread-count suppression.
        try {
          const pending = await svc.listPending(userId);
          for (const h of pending.slice(0, hResult.created)) {
            await proactive.notifyHypothesisNew(userId, h);
          }
        } catch (e) {
          console.warn('[Brain] proactive(hypothesis_new):', e instanceof Error ? e.message : e);
        }
      }
    } catch (err) {
      console.warn(
        '[Brain] Hypothesis generation failed:',
        err instanceof Error ? err.message : err,
      );
    }

    // 8. Proactive coach — returning player + plateau checks (Phase 7D)
    try {
      await proactive.maybeNotifyReturningPlayer(userId);
    } catch (err) {
      console.warn('[Brain] proactive(returning):', err instanceof Error ? err.message : err);
    }
    try {
      await proactive.maybeNotifyPlateau(userId);
    } catch (err) {
      console.warn('[Brain] proactive(plateau):', err instanceof Error ? err.message : err);
    }

    // 9. Reconcile cross-table state. Catches the case where one layer
    //    failed mid-fan-out and left orphan references — e.g. a graph skill
    //    node whose skillId has no row in player_skill_mastery (would happen
    //    if step 2 failed but step 3 succeeded). Idempotent + cheap.
    try {
      await this.reconcileBrainState(userId);
    } catch (err) {
      console.warn('[Brain] reconcile:', err instanceof Error ? err.message : err);
    }

    return result;
  }

  /**
   * Heal cross-table inconsistencies after the per-layer fan-out.
   *
   * Per-layer try/catch keeps individual failures from cascading, but doesn't
   * fix orphans the failure leaves behind. Concrete case we hit: graph layer
   * creates a `skill` node with `data.skillId='peeking'` but skill-mastery
   * layer crashed before inserting the corresponding `player_skill_mastery`
   * row → bottleneck-compass, weekly report etc. then read a NULL skill row
   * and silently degrade.
   *
   * This sweep finds those orphans and creates default mastery rows so
   * downstream queries succeed. Cheap (one query per call), idempotent
   * (unique constraint + onConflictDoNothing).
   */
  private async reconcileBrainState(userId: string): Promise<{ healed: number }> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT
        (gn.data->>'skillId') AS skill_id,
        COALESCE(gn.data->>'domain', 'unknown') AS domain
      FROM coaching_graph_nodes gn
      LEFT JOIN player_skill_mastery psm
        ON psm.user_id = ${userId}
       AND psm.skill_id = (gn.data->>'skillId')
      WHERE gn.user_id = ${userId}
        AND gn.node_type = 'skill'
        AND gn.data ? 'skillId'
        AND psm.id IS NULL
    `);
    const rows = ((result as any).rows ?? result) as Array<{ skill_id: string; domain: string }>;
    let healed = 0;
    for (const row of rows) {
      if (!row.skill_id) continue;
      try {
        const ins = await this.db
          .insert(playerSkillMastery)
          .values({
            userId,
            skillId: row.skill_id,
            domain: row.domain || 'unknown',
          })
          .onConflictDoNothing()
          .returning({ id: playerSkillMastery.id });
        if (ins.length > 0) healed++;
      } catch (err) {
        console.warn(
          '[Brain] reconcile insert failed for %s: %s',
          row.skill_id,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (healed > 0) {
      console.log('[Brain] Reconciled %d orphan skill node(s) for user %s', healed, userId);
    }
    return { healed };
  }
}
