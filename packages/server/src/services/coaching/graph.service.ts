/**
 * Coaching Graph Service — Knowledge graph for the coaching brain.
 *
 * Creates nodes and edges from coaching reports to build a connected
 * knowledge graph of player behavior, patterns, and coaching insights.
 *
 * Node types: game, event (death), pattern, reflection
 * Edge types: demonstrates, caused_by, related_to, preceded_by
 *
 * Gracefully degrades if pgvector extension is unavailable (embeddings optional).
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingGraphEdges, coachingGraphNodes } from '../../db/schema.js';
import { getAgentRole, getSkillsForCategory } from '../../games/valorant/skill-taxonomy.js';
import { embedTexts, isValid768 } from './embedding.util.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_NODES_PER_USER = 500;
const IMPORTANCE_DECAY_FACTOR = 0.95; // per-game decay for old nodes

// Hybrid scoring weights for graph reads (P9). Mirrors observation.service —
// when no query embedding is supplied we collapse to importance × recency.
const GRAPH_SCORING = {
  withQuery: { sim: 0.45, importance: 0.3, recency: 0.25 },
  withoutQuery: { sim: 0.0, importance: 0.65, recency: 0.35 },
};
const GRAPH_RECENCY_HALF_LIFE_DAYS = 45;
/** Max nodes to embed in a single backfill sweep — bounds Gemini cost per call. */
const BACKFILL_BATCH = 30;

// ── Service ──────────────────────────────────────────────────────────────────

export class GraphService {
  constructor(private db: Db) {}

  /**
   * Ingest a completed coaching report into the knowledge graph.
   * Creates game node, event nodes (deaths), pattern nodes, and connecting edges.
   *
   * Each node gets a 768-dim embedding so brain-context reads can score by
   * semantic similarity to the user's question (P9 hybrid retrieval). Failed
   * embeddings degrade gracefully — the node still inserts, just without
   * a vector, and falls back to importance ordering on read.
   */
  async ingestReport(
    userId: string,
    reportId: string,
    report: any,
    agent?: string,
    map?: string,
  ): Promise<{ nodes: number; edges: number }> {
    try {
      const deaths = report.deathCoaching ?? report.death_coaching ?? [];
      const priority = report.priorityIssue ?? report.priority_pattern ?? report.priority_issue;
      const secondaries =
        report.secondaryIssues ?? report.secondary_patterns ?? report.secondary_issues ?? [];
      const strengths: string[] = report.strengths ?? [];
      const verdict = report.matchVerdict ?? report.match_verdict ?? '';

      let nodeCount = 0;
      let edgeCount = 0;

      // ── 1. Game Node ───────────────────────────────────────────────────
      const gameLabel = `Game on ${map ?? 'unknown'} as ${agent ?? 'unknown'}`;
      const gameEmbed = await this.embedNodeText(`${gameLabel}. ${verdict.slice(0, 400)}`);
      const [gameNode] = await this.db
        .insert(coachingGraphNodes)
        .values({
          userId,
          nodeType: 'game',
          label: gameLabel,
          data: {
            reportId,
            agent,
            map,
            deaths: deaths.length,
            verdict: verdict.slice(0, 200),
            strengths,
          },
          importance: 0.6,
          ...(gameEmbed ? { embedding: gameEmbed } : {}),
        })
        .returning();
      nodeCount++;

      // Link to previous game (temporal chain)
      const prevGame = await this.db
        .select({ id: coachingGraphNodes.id })
        .from(coachingGraphNodes)
        .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'game')))
        .orderBy(desc(coachingGraphNodes.createdAt))
        .limit(2); // get 2 — current + previous

      if (prevGame.length >= 2 && prevGame[1].id !== gameNode.id) {
        await this.db.insert(coachingGraphEdges).values({
          sourceId: prevGame[1].id,
          targetId: gameNode.id,
          edgeType: 'preceded_by',
          weight: 1.0,
        });
        edgeCount++;
      }

      // ── 2. Event Nodes (deaths) ────────────────────────────────────────
      const deathNodeIds: string[] = [];
      for (const death of deaths) {
        const category = death.category ?? 'unclear';
        if (category === 'unclear') continue;

        const importance = this.calcDeathImportance(death);
        const deathLabel = `Death ${death.death_number}: ${category}`;
        const deathEmbedText = [
          deathLabel,
          (death.situation ?? '').slice(0, 200),
          (death.mistake ?? '').slice(0, 200),
          (death.correction ?? '').slice(0, 200),
        ]
          .filter(Boolean)
          .join(' — ');
        const deathEmbed = await this.embedNodeText(deathEmbedText);
        const [deathNode] = await this.db
          .insert(coachingGraphNodes)
          .values({
            userId,
            nodeType: 'event',
            label: deathLabel,
            data: {
              reportId,
              deathNumber: death.death_number,
              category,
              situation: (death.situation ?? '').slice(0, 200),
              mistake: (death.mistake ?? '').slice(0, 200),
              correction: (death.correction ?? '').slice(0, 200),
              time: death.approximate_time,
              avoidable: death.avoidable,
            },
            importance,
            ...(deathEmbed ? { embedding: deathEmbed } : {}),
          })
          .returning();
        nodeCount++;
        deathNodeIds.push(deathNode.id);

        // Edge: game → event
        await this.db.insert(coachingGraphEdges).values({
          sourceId: gameNode.id,
          targetId: deathNode.id,
          edgeType: 'demonstrates',
          weight: importance,
        });
        edgeCount++;

        // Edge: event → skill (via category mapping)
        const skills = getSkillsForCategory(category);
        const role = getAgentRole(agent);
        for (const skill of skills.slice(0, 2)) {
          // top 2 most relevant skills
          const skillNodeId = await this.getOrCreateSkillNode(
            userId,
            skill.id,
            skill.name,
            skill.domain,
          );
          await this.db.insert(coachingGraphEdges).values({
            sourceId: deathNode.id,
            targetId: skillNodeId,
            edgeType: 'demonstrates',
            weight: skill.roleWeight[role],
            data: { category, agent },
          });
          edgeCount++;
        }
      }

      // ── 3. Pattern Nodes ───────────────────────────────────────────────
      if (priority?.title) {
        const priorityEmbed = await this.embedNodeText(
          [
            priority.title,
            (priority.what_happened ?? '').slice(0, 300),
            (priority.what_to_do ?? priority.fix ?? '').slice(0, 300),
          ]
            .filter(Boolean)
            .join(' — '),
        );
        const [patternNode] = await this.db
          .insert(coachingGraphNodes)
          .values({
            userId,
            nodeType: 'pattern',
            label: priority.title,
            data: {
              reportId,
              category: priority.category,
              deathCount: priority.rounds_affected ?? priority.death_count ?? 0,
              whatHappened: (priority.what_happened ?? '').slice(0, 300),
              fix: (priority.what_to_do ?? priority.fix ?? '').slice(0, 300),
            },
            importance: 0.8, // priority patterns are high importance
            ...(priorityEmbed ? { embedding: priorityEmbed } : {}),
          })
          .returning();
        nodeCount++;

        // Edge: game → pattern
        await this.db.insert(coachingGraphEdges).values({
          sourceId: gameNode.id,
          targetId: patternNode.id,
          edgeType: 'demonstrates',
          weight: 0.9,
        });
        edgeCount++;

        // Find similar past patterns and link them
        const similarPatterns = await this.findSimilarPatterns(
          userId,
          priority.category,
          patternNode.id,
        );
        for (const sim of similarPatterns) {
          await this.db.insert(coachingGraphEdges).values({
            sourceId: sim.id,
            targetId: patternNode.id,
            edgeType: 'related_to',
            weight: 0.7,
          });
          edgeCount++;
        }
      }

      for (const sec of secondaries) {
        if (!sec?.title) continue;
        const secEmbed = await this.embedNodeText(
          [
            sec.title,
            (sec.what_happened ?? '').slice(0, 300),
            (sec.what_to_do ?? sec.fix ?? '').slice(0, 300),
          ]
            .filter(Boolean)
            .join(' — '),
        );
        const [secNode] = await this.db
          .insert(coachingGraphNodes)
          .values({
            userId,
            nodeType: 'pattern',
            label: sec.title,
            data: {
              reportId,
              category: sec.category,
              deathCount: sec.rounds_affected ?? sec.death_count ?? 0,
              whatHappened: (sec.what_happened ?? '').slice(0, 300),
              fix: (sec.what_to_do ?? sec.fix ?? '').slice(0, 300),
            },
            importance: 0.6,
            ...(secEmbed ? { embedding: secEmbed } : {}),
          })
          .returning();
        nodeCount++;

        await this.db.insert(coachingGraphEdges).values({
          sourceId: gameNode.id,
          targetId: secNode.id,
          edgeType: 'demonstrates',
          weight: 0.6,
        });
        edgeCount++;
      }

      // ── 4. Decay old node importance ───────────────────────────────────
      // Decay is handled by ConsolidationService.applyFadeMemDecay — do not double-decay
      // await this.decayImportance(userId);

      // ── 5. Enforce node cap ────────────────────────────────────────────
      await this.enforceNodeCap(userId);

      console.log(
        '[Graph] Ingested report %s: %d nodes, %d edges for user %s',
        reportId,
        nodeCount,
        edgeCount,
        userId,
      );

      return { nodes: nodeCount, edges: edgeCount };
    } catch (err) {
      console.warn('[Graph] Ingest failed:', err instanceof Error ? err.message : err);
      return { nodes: 0, edges: 0 };
    }
  }

  /**
   * Get graph summary for a user — used for brain context and UI.
   */
  async getGraphSummary(userId: string): Promise<{
    totalNodes: number;
    totalEdges: number;
    patterns: { label: string; category: string; occurrences: number }[];
    recentGames: { label: string; createdAt: string }[];
  }> {
    try {
      const nodeCount = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(coachingGraphNodes)
        .where(eq(coachingGraphNodes.userId, userId));

      const edgeCount = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(coachingGraphEdges)
        .innerJoin(coachingGraphNodes, eq(coachingGraphEdges.sourceId, coachingGraphNodes.id))
        .where(eq(coachingGraphNodes.userId, userId));

      // Get top patterns by importance
      const patterns = await this.db
        .select({
          label: coachingGraphNodes.label,
          data: coachingGraphNodes.data,
          importance: coachingGraphNodes.importance,
        })
        .from(coachingGraphNodes)
        .where(
          and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'pattern')),
        )
        .orderBy(desc(coachingGraphNodes.importance))
        .limit(10);

      // Get recent games
      const recentGames = await this.db
        .select({
          label: coachingGraphNodes.label,
          createdAt: coachingGraphNodes.createdAt,
        })
        .from(coachingGraphNodes)
        .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'game')))
        .orderBy(desc(coachingGraphNodes.createdAt))
        .limit(5);

      return {
        totalNodes: Number(nodeCount[0]?.count ?? 0),
        totalEdges: Number(edgeCount[0]?.count ?? 0),
        patterns: patterns.map((p) => ({
          label: p.label,
          category: (p.data as any)?.category ?? 'unknown',
          occurrences: 1, // TODO: count related_to edges for true occurrence count
        })),
        recentGames: recentGames.map((g) => ({
          label: g.label,
          createdAt: g.createdAt.toISOString(),
        })),
      };
    } catch (err) {
      console.warn('[Graph] getSummary failed:', err instanceof Error ? err.message : err);
      return { totalNodes: 0, totalEdges: 0, patterns: [], recentGames: [] };
    }
  }

  /**
   * Format graph context for prompt injection.
   *
   * When `opts.queryEmbedding` is supplied, pattern/concept nodes are scored
   * with hybrid retrieval (cosine similarity + importance + recency) so the
   * patterns most relevant to the user's current question surface \u2014 not just
   * the loudest ones. Without a query, falls back to importance ordering.
   */
  async formatForPrompt(userId: string, opts?: { queryEmbedding?: number[] }): Promise<string> {
    const summary = await this.getGraphSummary(userId);
    if (summary.totalNodes === 0) return '';

    const useQuery = isValid768(opts?.queryEmbedding);
    const w = useQuery ? GRAPH_SCORING.withQuery : GRAPH_SCORING.withoutQuery;

    let topPatterns: Array<{ label: string; category: string }> = [];
    try {
      if (useQuery) {
        const queryLiteral = `[${opts!.queryEmbedding!.join(',')}]`;
        const r = await this.db.execute(sql`
          SELECT
            label,
            data,
            (
              ${sql.raw(String(w.sim))}        * COALESCE(1 - (embedding <=> ${queryLiteral}::vector), 0) +
              ${sql.raw(String(w.importance))} * importance +
              ${sql.raw(String(w.recency))}    * EXP(-EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / (${GRAPH_RECENCY_HALF_LIFE_DAYS} * 86400.0))
            ) AS score
          FROM coaching_graph_nodes
          WHERE user_id = ${userId}
            AND node_type IN ('pattern', 'concept')
          ORDER BY score DESC
          LIMIT 5
        `);
        const rows = ((r as any).rows ?? r) as Array<{ label: string; data: any }>;
        topPatterns = rows.map((row) => ({
          label: row.label,
          category: row.data?.category ?? 'unknown',
        }));
      } else {
        topPatterns = summary.patterns.slice(0, 5);
      }
    } catch (err) {
      console.warn(
        '[Graph] hybrid retrieval failed, falling back to importance:',
        err instanceof Error ? err.message : err,
      );
      topPatterns = summary.patterns.slice(0, 5);
    }

    const lines: string[] = [];

    if (topPatterns.length > 0) {
      lines.push('CONNECTED PATTERNS (from knowledge graph):');
      for (const p of topPatterns) {
        lines.push(`  \u2022 [${p.category}] ${p.label}`);
      }
    }

    if (summary.recentGames.length > 0) {
      lines.push('');
      lines.push(
        `COACHING HISTORY: ${summary.totalNodes} knowledge points across ${summary.recentGames.length} recent games`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Embed pattern/event/game nodes that don't yet have a vector.
   *
   * Older nodes inserted before the embedding plumbing landed have NULL
   * embedding \u2014 they get sim=0 in hybrid retrieval and rely entirely on
   * importance. This sweep fills them in incrementally so the graph layer
   * benefits from semantic search as the player keeps using the app.
   *
   * Returns the number of nodes successfully embedded. Caller decides how
   * often to run this \u2014 typically once per game inside the post-enrichment
   * fan-out, capped by BACKFILL_BATCH so wall-clock + cost stay bounded.
   */
  async backfillEmbeddings(userId: string, limit = BACKFILL_BATCH): Promise<number> {
    let candidates: Array<{ id: string; label: string; data: any; nodeType: string }> = [];
    try {
      const rows = await this.db
        .select({
          id: coachingGraphNodes.id,
          label: coachingGraphNodes.label,
          data: coachingGraphNodes.data,
          nodeType: coachingGraphNodes.nodeType,
        })
        .from(coachingGraphNodes)
        .where(and(eq(coachingGraphNodes.userId, userId), isNull(coachingGraphNodes.embedding)))
        .orderBy(desc(coachingGraphNodes.importance))
        .limit(limit);
      candidates = rows;
    } catch (err) {
      console.warn('[Graph] backfill query failed:', err instanceof Error ? err.message : err);
      return 0;
    }

    if (candidates.length === 0) return 0;

    const texts = candidates.map((c) => this.composeEmbeddingText(c.label, c.data, c.nodeType));
    const vectors = await embedTexts(texts);

    let updated = 0;
    for (let i = 0; i < candidates.length; i++) {
      const vec = vectors[i];
      if (!isValid768(vec)) continue;
      try {
        await this.db
          .update(coachingGraphNodes)
          .set({ embedding: vec })
          .where(eq(coachingGraphNodes.id, candidates[i].id));
        updated++;
      } catch (err) {
        console.warn(
          '[Graph] backfill update failed for %s: %s',
          candidates[i].id,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (updated > 0) {
      console.log(
        '[Graph] Backfilled %d/%d embeddings for user %s',
        updated,
        candidates.length,
        userId,
      );
    }
    return updated;
  }

  /** Embed a single graph-node text. Returns null on failure. */
  private async embedNodeText(text: string): Promise<number[] | null> {
    if (!text || text.trim().length === 0) return null;
    const [v] = await embedTexts([text]);
    return isValid768(v) ? v : null;
  }

  /** Build the embedding text for a node from its label + key data fields. */
  private composeEmbeddingText(label: string, data: any, nodeType: string): string {
    const parts: string[] = [label];
    if (data && typeof data === 'object') {
      switch (nodeType) {
        case 'event':
          if (data.situation) parts.push(String(data.situation));
          if (data.mistake) parts.push(String(data.mistake));
          if (data.correction) parts.push(String(data.correction));
          break;
        case 'pattern':
        case 'concept':
          if (data.whatHappened) parts.push(String(data.whatHappened));
          if (data.fix) parts.push(String(data.fix));
          break;
        case 'game':
          if (data.verdict) parts.push(String(data.verdict));
          break;
        case 'reflection':
          if (data.insight) parts.push(String(data.insight));
          if (data.evidence) parts.push(String(data.evidence));
          break;
      }
    }
    return parts.filter(Boolean).join(' \u2014 ').slice(0, 1500);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private calcDeathImportance(death: any): number {
    let importance = 0.5;
    if (death.avoidable) importance += 0.1;
    const priority = death.coaching_priority ?? 3;
    importance += (priority - 3) * 0.1; // 5 → +0.2, 1 → -0.2
    return Math.max(0.1, Math.min(1.0, importance));
  }

  private async getOrCreateSkillNode(
    userId: string,
    skillId: string,
    name: string,
    domain: string,
  ): Promise<string> {
    // Check if skill node exists
    const existing = await this.db
      .select({ id: coachingGraphNodes.id })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'skill'),
          sql`${coachingGraphNodes.data}->>'skillId' = ${skillId}`,
        ),
      )
      .limit(1);

    if (existing.length > 0) return existing[0].id;

    const [node] = await this.db
      .insert(coachingGraphNodes)
      .values({
        userId,
        nodeType: 'skill',
        label: name,
        data: { skillId, domain },
        importance: 0.7,
      })
      .returning();

    return node.id;
  }

  private async findSimilarPatterns(userId: string, category: string, excludeId: string) {
    return this.db
      .select({ id: coachingGraphNodes.id })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'pattern'),
          sql`${coachingGraphNodes.data}->>'category' = ${category}`,
          sql`${coachingGraphNodes.id} != ${excludeId}`,
        ),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(3);
  }

  private async decayImportance(userId: string): Promise<void> {
    // Decay all non-skill nodes by the decay factor
    await this.db.execute(sql`
      UPDATE coaching_graph_nodes
      SET importance = GREATEST(0.05, importance * ${IMPORTANCE_DECAY_FACTOR})
      WHERE user_id = ${userId}
        AND node_type != 'skill'
    `);
  }

  private async enforceNodeCap(userId: string): Promise<void> {
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingGraphNodes)
      .where(eq(coachingGraphNodes.userId, userId));

    const count = Number(countResult[0]?.count ?? 0);
    if (count <= MAX_NODES_PER_USER) return;

    const excess = count - MAX_NODES_PER_USER;

    // Delete lowest-importance non-skill nodes (skill nodes are persistent)
    await this.db.execute(sql`
      DELETE FROM coaching_graph_nodes
      WHERE id IN (
        SELECT id FROM coaching_graph_nodes
        WHERE user_id = ${userId} AND node_type NOT IN ('skill')
        ORDER BY importance ASC, created_at ASC
        LIMIT ${excess}
      )
    `);

    console.log('[Graph] Pruned %d low-importance nodes for user %s', excess, userId);
  }
}
