/**
 * Era Detection Service (Phase 5)
 *
 * Maintains the player's era timeline. Runs as part of the post-enrichment
 * brain-update flow (after SkillMasteryService has updated BKT).
 *
 * Lifecycle:
 *   • Era STARTS when no active era exists AND a skill is in ZPD with ≥2 observations.
 *   • Era ENDS when its primary skill graduates (mastery ≥ 0.7 AND observations ≥ 5).
 *
 * Stored as graph nodes with nodeType='era' and importance=1.0 (max, so they
 * don't decay). Each era has the full narrative + metadata in `data`.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §5
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingGraphNodes, playerSkillMastery } from '../../db/schema.js';
import { SKILL_TAXONOMY } from '../../games/valorant/skill-taxonomy.js';
import { EraSummaryService } from './era-summary.service.js';

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Era graduation thresholds — tightened in v2 to avoid premature "completion"
 * claims. Earlier defaults (mastery≥0.7, obs≥5) fired too eagerly under our
 * gaming-tuned BKT noise (pSlip=0.30-0.40), making the dashboard claim a
 * skill was "mastered" after a handful of favourable death observations.
 *
 * New gates require:
 *   • mastery ≥ 0.75 (was 0.70)              — clearer signal vs noise floor
 *   • observations ≥ 8 (was 5)                — more samples before declaring
 *   • trend != 'regressing'                    — recent direction must agree
 */
const GRADUATION_MASTERY = 0.75;
const GRADUATION_MIN_OBSERVATIONS = 8;
const ZPD_LOW = 0.3;
const ZPD_HIGH = 0.7;
const MIN_OBSERVATIONS_TO_START_ERA = 2;
const ERA_REOPEN_COOLDOWN_DAYS = 14;

/** Live-status thresholds (option A — UI-side regression badge). */
const REGRESSION_THRESHOLD = 0.5; // below this = "regressed"
const DECLINING_THRESHOLD = 0.65; // 0.5–0.65 = "declining"; ≥0.65 = "maintained"

// Fundamentals before upper layers — same as Phase 3 compass
const DOMAIN_PRIORITY: Record<string, number> = {
  mechanical: 0,
  game_sense: 1,
  utility: 2,
  mental: 3,
};

// ── Node data shape ─────────────────────────────────────────────────────────

export interface EraNodeData {
  startDate: string;
  endDate: string | null;
  status: 'active' | 'graduated' | 'abandoned' | 'paused';
  primarySkillId: string;
  primarySkillName: string;
  domain: string;
  gamesCount: number;
  startMastery: number;
  endMastery: number | null;
  summary: string;
}

export interface EraRecord {
  id: string;
  label: string;
  data: EraNodeData;
  createdAt: string;
  /** Live re-checked mastery for the era's primary skill (option A). null if skill was deleted. */
  currentMastery?: number | null;
  /** Live status derived from currentMastery vs era endMastery — UI badge. */
  liveStatus?: 'active' | 'maintained' | 'declining' | 'regressed' | 'unknown';
}

// ── Service ─────────────────────────────────────────────────────────────────

export class EraDetectionService {
  constructor(private db: Db) {}

  /**
   * Run era detection after brain updates. Safe to call on every enrichment;
   * no-ops if nothing needs to change.
   *
   * Returns what happened (for logging + future proactive coach notifications).
   */
  async detectAndUpdate(userId: string): Promise<{
    closed: EraRecord | null;
    opened: EraRecord | null;
  }> {
    const closed = await this.checkAndCloseActiveEra(userId);
    const opened = await this.checkAndStartNewEra(userId);
    return { closed, opened };
  }

  /**
   * List all eras for a user, newest first. Caps at 50 (realistic ceiling — after
   * 100+ eras we'd need pagination, but that's generations of gameplay).
   *
   * Enriches each era with the primary skill's CURRENT mastery (live re-check)
   * and a derived `liveStatus` so the UI can show:
   *   • 'active'      — the era is still in progress
   *   • 'maintained'  — closed era; current mastery still ≥0.65 (kept the skill)
   *   • 'declining'   — closed era; current mastery 0.5–0.65 (slipping)
   *   • 'regressed'   — closed era; current mastery <0.5 (lost it)
   *   • 'unknown'     — skill row missing (legacy / corrupted state)
   *
   * Single SQL JOIN — avoids the N+1 query that a per-row mastery lookup
   * would cause when a player has many eras.
   */
  async listForUser(userId: string): Promise<EraRecord[]> {
    const result = await this.db.execute(sql`
      SELECT
        cgn.id          AS id,
        cgn.label       AS label,
        cgn.data        AS data,
        cgn.created_at  AS "createdAt",
        psm.p_mastery   AS "currentMastery"
      FROM coaching_graph_nodes cgn
      LEFT JOIN player_skill_mastery psm
        ON psm.user_id = cgn.user_id
       AND psm.skill_id = (cgn.data->>'primarySkillId')
      WHERE cgn.user_id = ${userId}
        AND cgn.node_type = 'era'
      ORDER BY cgn.created_at DESC
      LIMIT 50
    `);
    const rows = ((result as any).rows ?? result) as Array<{
      id: string;
      label: string;
      data: any;
      createdAt: string | Date;
      currentMastery: number | null;
    }>;

    return rows.map((r) => {
      const data = r.data as EraNodeData;
      const currentMastery = r.currentMastery ?? null;
      const liveStatus = computeLiveStatus(data, currentMastery);
      return {
        id: r.id,
        label: r.label,
        data,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
        currentMastery,
        liveStatus,
      };
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async checkAndCloseActiveEra(userId: string): Promise<EraRecord | null> {
    const activeEra = await this.getActiveEra(userId);
    if (!activeEra) return null;
    const data = activeEra.data;

    // Look up the primary skill's current mastery
    const skillRows = await this.db
      .select()
      .from(playerSkillMastery)
      .where(
        and(
          eq(playerSkillMastery.userId, userId),
          eq(playerSkillMastery.skillId, data.primarySkillId),
        ),
      )
      .limit(1);

    if (skillRows.length === 0) return null;
    const skill = skillRows[0];

    // Tightened gate (option C):
    //   • mastery must clear 0.75 (raised from 0.7) — clearer signal vs BKT noise
    //   • at least 8 observations (raised from 5) — bigger sample, less luck
    //   • trend must not be regressing — direction matters, not just current value
    const graduated =
      skill.pMastery >= GRADUATION_MASTERY &&
      skill.observations >= GRADUATION_MIN_OBSERVATIONS &&
      skill.trend !== 'regressing';
    if (!graduated) return null;

    // Era graduated — compute summary and persist
    const durationMs = Date.now() - new Date(data.startDate).getTime();
    const durationDays = Math.max(1, Math.round(durationMs / (1000 * 60 * 60 * 24)));

    const summaryService = new EraSummaryService();
    const summary = await summaryService.generate({
      primarySkillName: data.primarySkillName,
      domain: data.domain,
      startMastery: data.startMastery,
      endMastery: skill.pMastery,
      gamesCount: data.gamesCount,
      durationDays,
    });

    const updatedData: EraNodeData = {
      ...data,
      endDate: new Date().toISOString(),
      status: 'graduated',
      endMastery: skill.pMastery,
      summary: summary.summary,
    };

    await this.db
      .update(coachingGraphNodes)
      .set({ label: summary.title, data: updatedData })
      .where(eq(coachingGraphNodes.id, activeEra.id));

    console.log(
      '[Era] Closed "%s" (%s, %d%% → %d%%, %d games)',
      summary.title,
      data.primarySkillName,
      Math.round(data.startMastery * 100),
      Math.round(skill.pMastery * 100),
      data.gamesCount,
    );

    return { ...activeEra, label: summary.title, data: updatedData };
  }

  private async checkAndStartNewEra(userId: string): Promise<EraRecord | null> {
    // Bail if there's still an active era (we only support one at a time)
    const stillActive = await this.getActiveEra(userId);
    if (stillActive) return null;

    // Pick the highest-leverage skill in ZPD (same logic as Phase 3 compass)
    const masteryRows = await this.db
      .select()
      .from(playerSkillMastery)
      .where(eq(playerSkillMastery.userId, userId));

    const candidates = masteryRows
      .filter(
        (m) =>
          m.pMastery >= ZPD_LOW &&
          m.pMastery <= ZPD_HIGH &&
          m.observations >= MIN_OBSERVATIONS_TO_START_ERA,
      )
      .map((m) => {
        const skillDef = SKILL_TAXONOMY.find((s) => s.id === m.skillId);
        return { mastery: m, skillDef };
      })
      .filter(
        (
          c,
        ): c is {
          mastery: (typeof masteryRows)[number];
          skillDef: (typeof SKILL_TAXONOMY)[number];
        } => c.skillDef !== undefined,
      );

    if (candidates.length === 0) return null;

    const scored = candidates.map((c) => ({
      mastery: c.mastery,
      skillDef: c.skillDef,
      blockedCount: this.countBlocked(c.mastery.skillId),
    }));

    scored.sort((a, b) => {
      if (b.blockedCount !== a.blockedCount) return b.blockedCount - a.blockedCount;
      const dp =
        (DOMAIN_PRIORITY[a.mastery.domain] ?? 99) - (DOMAIN_PRIORITY[b.mastery.domain] ?? 99);
      if (dp !== 0) return dp;
      return a.mastery.skillId.localeCompare(b.mastery.skillId);
    });

    const pick = scored[0];

    // Cooldown: don't re-open an era for the same skill within 14 days
    const recent = await this.getRecentEraForSkill(userId, pick.mastery.skillId);
    if (recent) {
      const daysSince = (Date.now() - new Date(recent.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < ERA_REOPEN_COOLDOWN_DAYS) return null;
    }

    const startData: EraNodeData = {
      startDate: new Date().toISOString(),
      endDate: null,
      status: 'active',
      primarySkillId: pick.mastery.skillId,
      primarySkillName: pick.skillDef.name,
      domain: pick.mastery.domain,
      gamesCount: 0,
      startMastery: pick.mastery.pMastery,
      endMastery: null,
      summary: '',
    };

    const [node] = await this.db
      .insert(coachingGraphNodes)
      .values({
        userId,
        nodeType: 'era',
        label: `The ${pick.skillDef.name} Era`,
        data: startData,
        importance: 1.0,
      })
      .returning();

    console.log(
      '[Era] Started "%s" for user %s (skill mastery %d%%)',
      node.label,
      userId,
      Math.round(pick.mastery.pMastery * 100),
    );

    return {
      id: node.id,
      label: node.label,
      data: startData,
      createdAt: node.createdAt.toISOString(),
    };
  }

  private async getActiveEra(userId: string): Promise<EraRecord | null> {
    const rows = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'era')))
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(10);

    const active = rows.find((r) => (r.data as EraNodeData)?.status === 'active');
    if (!active) return null;
    return {
      id: active.id,
      label: active.label,
      data: active.data as EraNodeData,
      createdAt: active.createdAt.toISOString(),
    };
  }

  private async getRecentEraForSkill(userId: string, skillId: string): Promise<EraRecord | null> {
    const rows = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'era')))
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(30);

    const match = rows.find((r) => (r.data as EraNodeData)?.primarySkillId === skillId);
    if (!match) return null;
    return {
      id: match.id,
      label: match.label,
      data: match.data as EraNodeData,
      createdAt: match.createdAt.toISOString(),
    };
  }

  /**
   * Derive the user-facing "live status" for an era from its stored data
   * plus the skill's current mastery.
   *
   * Active eras always show 'active' regardless of mastery. Closed eras
   * are bucketed: ≥0.65 = maintained, 0.5–0.65 = declining, <0.5 = regressed.
   * If the skill row is missing (rare — corrupted state or legacy data),
   * the era is shown 'unknown' and the UI hides the badge.
   */
  static computeLiveStatus(
    data: EraNodeData,
    currentMastery: number | null,
  ): NonNullable<EraRecord['liveStatus']> {
    return computeLiveStatus(data, currentMastery);
  }

  /** Count transitively-blocked skills via the static prerequisite graph. */
  private countBlocked(skillId: string): number {
    const blocked = new Set<string>();
    const visit = (id: string) => {
      for (const skill of SKILL_TAXONOMY) {
        if (skill.prerequisites.includes(id) && !blocked.has(skill.id)) {
          blocked.add(skill.id);
          visit(skill.id);
        }
      }
    };
    visit(skillId);
    return blocked.size;
  }
}

// ── Module-level helper (also exposed via static method on the class) ───────

function computeLiveStatus(
  data: EraNodeData,
  currentMastery: number | null,
): NonNullable<EraRecord['liveStatus']> {
  if (data.status === 'active') return 'active';
  if (currentMastery == null) return 'unknown';
  if (currentMastery >= DECLINING_THRESHOLD) return 'maintained';
  if (currentMastery >= REGRESSION_THRESHOLD) return 'declining';
  return 'regressed';
}
