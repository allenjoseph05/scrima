/**
 * Bottleneck Compass Service
 *
 * For a given player, determines which single skill (from BKT mastery data) is
 * currently the highest-leverage bottleneck — i.e. the one whose improvement
 * would unblock the most downstream skills via the prerequisite graph.
 *
 * See: docs/YOUR_COACH_PHASE3_PLAN.md
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { playerSkillMastery } from '../../db/schema.js';
import { SKILL_TAXONOMY, getSkillsForCategory } from '../../games/valorant/skill-taxonomy.js';

// ── Thresholds & policy ─────────────────────────────────────────────────────

const MIN_OBSERVATIONS_FOR_BOTTLENECK = 15;
const ZPD_LOW = 0.3; // below this: not yet learnable
const ZPD_HIGH = 0.7; // above this: effectively mastered
const MASTERED_THRESHOLD = 0.7;

// Research (docs/COACHING-RESEARCH.md): fundamentals gate upper layers.
// When two skills tie on blocked-count, prefer the lower layer first.
const DOMAIN_PRIORITY: Record<string, number> = {
  mechanical: 0,
  game_sense: 1,
  utility: 2,
  mental: 3,
};

// ── Return shape ────────────────────────────────────────────────────────────

export type CompassState =
  | { state: 'building'; totalObservations: number; gamesToGo: number }
  | { state: 'early'; totalObservations: number }
  | { state: 'all_mastered' }
  | {
      state: 'ready';
      primary: {
        skillId: string;
        name: string;
        domain: string;
        pMastery: number;
        blockedCount: number;
        blockedSkillIds: string[];
      };
      runnersUp: Array<{ skillId: string; name: string; blockedCount: number }>;
      totalObservations: number;
      alignedWithPriorityCategory?: boolean;
    };

// ── Service ─────────────────────────────────────────────────────────────────

export class BottleneckCompassService {
  constructor(private db: Db) {}

  async compute(userId: string, priorityCategory?: string): Promise<CompassState> {
    const mastery = await this.db
      .select()
      .from(playerSkillMastery)
      .where(eq(playerSkillMastery.userId, userId));

    const totalObservations = mastery.reduce((sum, m) => sum + m.observations, 0);

    // Gate 1 — not enough observations to call a bottleneck
    if (totalObservations < MIN_OBSERVATIONS_FOR_BOTTLENECK) {
      return {
        state: 'building',
        totalObservations,
        // Assume ~3 observations per game on average.
        gamesToGo: Math.max(
          1,
          Math.ceil((MIN_OBSERVATIONS_FOR_BOTTLENECK - totalObservations) / 3),
        ),
      };
    }

    // Gate 2 — everything is mastered
    const allMastered =
      mastery.length > 0 && mastery.every((m) => m.pMastery >= MASTERED_THRESHOLD);
    if (allMastered) {
      return { state: 'all_mastered' };
    }

    // Gate 3 — observations exist but nothing is in ZPD yet
    const inZPD = mastery.filter((m) => m.pMastery >= ZPD_LOW && m.pMastery <= ZPD_HIGH);
    if (inZPD.length === 0) {
      return { state: 'early', totalObservations };
    }

    // Score each ZPD skill by transitive blocked-count
    const scored = inZPD
      .map((m) => {
        const skillDef = SKILL_TAXONOMY.find((s) => s.id === m.skillId);
        if (!skillDef) return null; // schema drift — skill in DB but not in taxonomy
        const blocked = this.countBlocked(m.skillId);
        return {
          skillId: m.skillId,
          name: skillDef.name,
          domain: m.domain,
          pMastery: m.pMastery,
          blockedCount: blocked.size,
          blockedSkillIds: Array.from(blocked),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (scored.length === 0) {
      // All ZPD skills were unknown to the taxonomy (shouldn't happen in practice)
      return { state: 'early', totalObservations };
    }

    // Sort: max blocked first, then domain priority, then alphabetical for stability
    scored.sort((a, b) => {
      if (b.blockedCount !== a.blockedCount) return b.blockedCount - a.blockedCount;
      const dp = (DOMAIN_PRIORITY[a.domain] ?? 99) - (DOMAIN_PRIORITY[b.domain] ?? 99);
      if (dp !== 0) return dp;
      return a.skillId.localeCompare(b.skillId);
    });

    const primary = scored[0];
    const aligned = priorityCategory
      ? getSkillsForCategory(priorityCategory).some((s) => s.id === primary.skillId)
      : undefined;

    return {
      state: 'ready',
      primary,
      runnersUp: scored.slice(1, 3).map((s) => ({
        skillId: s.skillId,
        name: s.name,
        blockedCount: s.blockedCount,
      })),
      totalObservations,
      alignedWithPriorityCategory: aligned,
    };
  }

  /**
   * Count skills transitively blocked by `skillId` via the prerequisite graph.
   * A skill X blocks skill Y if X is in Y.prerequisites (direct) or in any
   * prerequisite of a skill that blocks Y (transitive).
   */
  private countBlocked(skillId: string): Set<string> {
    const blocked = new Set<string>();
    const visit = (id: string) => {
      for (const skill of SKILL_TAXONOMY) {
        if (skill.prerequisites.includes(id) && !blocked.has(skill.id)) {
          blocked.add(skill.id);
          visit(skill.id); // transitive
        }
      }
    };
    visit(skillId);
    return blocked;
  }
}
