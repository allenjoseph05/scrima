/**
 * Hypothesis Generator Service (Phase 7B — Living Mind)
 *
 * Detects patterns the coach hasn't explicitly observed yet but that the data
 * suggests — agent variance, map variance, recurring priority patterns, etc.
 * Surfaces them in the Brain panel's "STILL FIGURING OUT" tier so the player
 * can confirm or reject.
 *
 * Design:
 *   - Runs on every enrichment (post brain update). Dedupes so we don't
 *     re-create hypotheses for the same category within a cooldown window.
 *   - Max 3 active (pending) hypotheses at a time — prevents overwhelm.
 *   - Each detector is honest: returns null if data is too thin.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §7.2
 */

import { eq, and, desc, gte } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingGraphNodes, matches } from '../../db/schema.js';

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_ACTIVE_HYPOTHESES = 3;
const HYPOTHESIS_COOLDOWN_DAYS = 14;
const MATCH_WINDOW = 50;

// Thresholds for each detector — keep them conservative so we don't cry wolf.
const AGENT_MIN_GAMES = 5;
const AGENT_KD_GAP = 0.4;
const MAP_MIN_GAMES = 5;
const MAP_WR_GAP = 0.25;
const PATTERN_MIN_NODES = 5;
const PATTERN_MIN_COUNT = 5;
const PATTERN_WINDOW = 20;

// ── Types ───────────────────────────────────────────────────────────────────

export type HypothesisCategory = 'agent_variance' | 'map_variance' | 'pattern_recurring';

export interface HypothesisData {
  category: HypothesisCategory;
  evidence: string;
  status: 'pending' | 'confirmed' | 'rejected';
  evidenceCount: number;
  generatedAt: string;
  resolvedAt?: string | null;
}

export interface HypothesisRecord {
  id: string;
  label: string;
  data: HypothesisData;
  createdAt: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class HypothesisGeneratorService {
  constructor(private db: Db) {}

  /** Runs during post-enrichment brain update. Creates up to (cap - active) new hypotheses. */
  async generateIfNeeded(userId: string): Promise<{ created: number }> {
    const active = await this.listPending(userId);
    const slotsAvailable = MAX_ACTIVE_HYPOTHESES - active.length;
    if (slotsAvailable <= 0) return { created: 0 };

    // Don't regenerate same category within cooldown (rejected or confirmed still count)
    const recentCategories = await this.getCategoriesInCooldown(userId);
    const activeCategories = new Set(active.map((a) => a.data.category));
    const skip = new Set<HypothesisCategory>([
      ...Array.from(recentCategories),
      ...Array.from(activeCategories),
    ]);

    const detectors: Array<() => Promise<{ label: string; data: HypothesisData } | null>> = [];
    if (!skip.has('agent_variance')) detectors.push(() => this.detectAgentVariance(userId));
    if (!skip.has('map_variance')) detectors.push(() => this.detectMapVariance(userId));
    if (!skip.has('pattern_recurring')) detectors.push(() => this.detectPatternRecurring(userId));

    let created = 0;
    for (const detector of detectors) {
      if (created >= slotsAvailable) break;
      try {
        const result = await detector();
        if (!result) continue;
        await this.db.insert(coachingGraphNodes).values({
          userId,
          nodeType: 'hypothesis',
          label: result.label,
          data: result.data,
          importance: 0.6,
        });
        created++;
        console.log('[Hypothesis] %s', result.label);
      } catch (err) {
        console.warn('[Hypothesis] Detector failed:', err instanceof Error ? err.message : err);
      }
    }

    return { created };
  }

  /** List pending hypotheses for UI display. */
  async listPending(userId: string): Promise<HypothesisRecord[]> {
    const rows = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(
        and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'hypothesis')),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(10);

    return rows
      .filter((r) => (r.data as HypothesisData)?.status === 'pending')
      .slice(0, MAX_ACTIVE_HYPOTHESES)
      .map((r) => ({
        id: r.id,
        label: r.label,
        data: r.data as HypothesisData,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  /** Player agrees — promote to confirmed. */
  async confirm(userId: string, id: string): Promise<HypothesisRecord | null> {
    const existing = await this.getById(userId, id);
    if (!existing) return null;
    const updated: HypothesisData = {
      ...(existing.data as HypothesisData),
      status: 'confirmed',
      resolvedAt: new Date().toISOString(),
    };
    await this.db
      .update(coachingGraphNodes)
      .set({ data: updated, importance: 0.8 })
      .where(eq(coachingGraphNodes.id, id));
    return {
      id: existing.id,
      label: existing.label,
      data: updated,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  /** Player disagrees — mark rejected (kept as negative signal; deprioritized). */
  async reject(userId: string, id: string): Promise<HypothesisRecord | null> {
    const existing = await this.getById(userId, id);
    if (!existing) return null;
    const updated: HypothesisData = {
      ...(existing.data as HypothesisData),
      status: 'rejected',
      resolvedAt: new Date().toISOString(),
    };
    await this.db
      .update(coachingGraphNodes)
      .set({ data: updated, importance: 0.1 })
      .where(eq(coachingGraphNodes.id, id));
    return {
      id: existing.id,
      label: existing.label,
      data: updated,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  // ── Detectors ──────────────────────────────────────────────────────────

  private async detectAgentVariance(
    userId: string,
  ): Promise<{ label: string; data: HypothesisData } | null> {
    const rows = await this.db
      .select({
        agent: matches.agent,
        kills: matches.kills,
        deaths: matches.deaths,
        won: matches.won,
      })
      .from(matches)
      .where(eq(matches.userId, userId))
      .orderBy(desc(matches.playedAt))
      .limit(MATCH_WINDOW);

    const byAgent = new Map<string, { games: number; kills: number; deaths: number }>();
    for (const r of rows) {
      if (!r.agent || r.agent === 'unknown') continue;
      const e = byAgent.get(r.agent) ?? { games: 0, kills: 0, deaths: 0 };
      e.games++;
      e.kills += r.kills ?? 0;
      e.deaths += r.deaths ?? 0;
      byAgent.set(r.agent, e);
    }

    const qualified = Array.from(byAgent.entries())
      .filter(([, e]) => e.games >= AGENT_MIN_GAMES)
      .map(([agent, e]) => ({
        agent,
        games: e.games,
        kd: e.deaths > 0 ? e.kills / e.deaths : e.kills,
      }));

    if (qualified.length < 2) return null;
    qualified.sort((a, b) => b.kd - a.kd);
    const best = qualified[0];
    const worst = qualified[qualified.length - 1];
    if (best.kd - worst.kd < AGENT_KD_GAP) return null;

    return {
      label: `You perform better on ${best.agent} than ${worst.agent}`,
      data: {
        category: 'agent_variance',
        evidence: `${best.agent}: ${best.kd.toFixed(2)} K/D over ${best.games} games. ${worst.agent}: ${worst.kd.toFixed(2)} K/D over ${worst.games} games.`,
        status: 'pending',
        evidenceCount: best.games + worst.games,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private async detectMapVariance(
    userId: string,
  ): Promise<{ label: string; data: HypothesisData } | null> {
    const rows = await this.db
      .select({ map: matches.map, won: matches.won })
      .from(matches)
      .where(eq(matches.userId, userId))
      .orderBy(desc(matches.playedAt))
      .limit(MATCH_WINDOW);

    const byMap = new Map<string, { games: number; wins: number }>();
    for (const r of rows) {
      if (!r.map || r.map === 'unknown') continue;
      const e = byMap.get(r.map) ?? { games: 0, wins: 0 };
      e.games++;
      if (r.won) e.wins++;
      byMap.set(r.map, e);
    }

    const qualified = Array.from(byMap.entries())
      .filter(([, e]) => e.games >= MAP_MIN_GAMES)
      .map(([map, e]) => ({
        map,
        games: e.games,
        wr: e.wins / e.games,
      }));

    if (qualified.length < 2) return null;
    qualified.sort((a, b) => b.wr - a.wr);
    const best = qualified[0];
    const worst = qualified[qualified.length - 1];
    if (best.wr - worst.wr < MAP_WR_GAP) return null;

    return {
      label: `You win noticeably more on ${best.map} than ${worst.map}`,
      data: {
        category: 'map_variance',
        evidence: `${best.map}: ${Math.round(best.wr * 100)}% WR (${best.games} games). ${worst.map}: ${Math.round(worst.wr * 100)}% WR (${worst.games} games).`,
        status: 'pending',
        evidenceCount: best.games + worst.games,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private async detectPatternRecurring(
    userId: string,
  ): Promise<{ label: string; data: HypothesisData } | null> {
    const rows = await this.db
      .select({ data: coachingGraphNodes.data })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'pattern')))
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(PATTERN_WINDOW);

    if (rows.length < PATTERN_MIN_NODES) return null;

    const counts = new Map<string, number>();
    for (const r of rows) {
      const cat = (r.data as any)?.category;
      if (!cat || typeof cat !== 'string') continue;
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }

    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < PATTERN_MIN_COUNT) return null;

    const [category, count] = top;
    const pct = Math.round((count / rows.length) * 100);

    return {
      label: `Your persistent issue might be ${category.replace(/_/g, ' ')}`,
      data: {
        category: 'pattern_recurring',
        evidence: `"${category}" was the priority issue in ${count} of your last ${rows.length} games (${pct}%).`,
        status: 'pending',
        evidenceCount: count,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async getById(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.id, id),
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'hypothesis'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getCategoriesInCooldown(userId: string): Promise<Set<HypothesisCategory>> {
    const cutoff = new Date(Date.now() - HYPOTHESIS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({ data: coachingGraphNodes.data })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'hypothesis'),
          gte(coachingGraphNodes.createdAt, cutoff),
        ),
      );
    const set = new Set<HypothesisCategory>();
    for (const r of rows) {
      const cat = (r.data as HypothesisData)?.category;
      if (cat) set.add(cat);
    }
    return set;
  }
}
