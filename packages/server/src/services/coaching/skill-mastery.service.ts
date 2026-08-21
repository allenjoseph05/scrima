/**
 * Skill Mastery Service — Bayesian Knowledge Tracing per skill per player.
 *
 * After each enrichment, maps death categories to skills and updates BKT mastery.
 * Strengths mentioned in coaching output provide positive signals.
 *
 * BKT update rule:
 *   On INCORRECT (death with this skill's category):
 *     P(L_n | incorrect) = P(L_{n-1}) * P(slip) / P(incorrect)
 *     P(L_n) = P(L_n | incorrect) + (1 - P(L_n | incorrect)) * P(transit)
 *
 *   On CORRECT (game played without dying to this category):
 *     P(L_n | correct) = P(L_{n-1}) * (1 - P(slip)) / P(correct)
 *     P(L_n) = P(L_n | correct) + (1 - P(L_n | correct)) * P(transit)
 *
 * Mastery is clamped to [0.01, 0.99].
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { playerSkillMastery } from '../../db/schema.js';
import {
  SKILL_TAXONOMY,
  getAgentRole,
  getRankTier,
  getSkillsForCategory,
} from '../../games/valorant/skill-taxonomy.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MasteryProfile {
  skills: {
    id: string;
    name: string;
    domain: string;
    mastery: number;
    trend: string;
    observations: number;
  }[];
  weakest: { id: string; name: string; mastery: number }[];
  strongest: { id: string; name: string; mastery: number }[];
}

// ── Service ──────────────────────────────────────────────────────────────────

export class SkillMasteryService {
  constructor(private db: Db) {}

  /**
   * Update mastery from a completed coaching report.
   * Called after enrichment — maps death categories + strengths to BKT updates.
   */
  async updateFromReport(
    userId: string,
    report: any,
    agent?: string,
    rank?: string,
  ): Promise<{ updated: number; skills: string[] }> {
    try {
      const deaths = report.deathCoaching ?? report.death_coaching ?? [];
      const strengths: string[] = report.strengths ?? [];
      const role = getAgentRole(agent);
      const tier = getRankTier(rank);

      // Count negative signals per skill (deaths by category)
      const negativeSignals = new Map<string, number>();
      for (const death of deaths) {
        const category = death.category ?? 'unclear';
        if (category === 'unclear') continue;

        const implicated = getSkillsForCategory(category);
        for (const skill of implicated) {
          const weight = skill.roleWeight[role] * (skill.rankRelevance[tier] / 5);
          if (weight > 0.2) {
            // skip irrelevant skills for this role/rank
            negativeSignals.set(skill.id, (negativeSignals.get(skill.id) ?? 0) + 1);
          }
        }
      }

      // Count positive signals (strengths text matching skill names/categories)
      const positiveSignals = new Set<string>();
      const strengthText = strengths.join(' ').toLowerCase();
      for (const skill of SKILL_TAXONOMY) {
        const keywords = [
          skill.name.toLowerCase(),
          skill.id.replace(/_/g, ' '),
          ...skill.detectionCategories,
        ];
        // Use word boundary matching to prevent false positives
        // (e.g., "positioning" should not match inside "repositioning")
        if (
          keywords.some((k) => {
            const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(strengthText);
          })
        ) {
          positiveSignals.add(skill.id);
        }
      }

      // Apply BKT updates
      const updatedSkills: string[] = [];
      const allSignaledSkills = new Set([...negativeSignals.keys(), ...positiveSignals]);

      for (const skillId of allSignaledSkills) {
        const skill = SKILL_TAXONOMY.find((s) => s.id === skillId);
        if (!skill) continue;

        const negCount = negativeSignals.get(skillId) ?? 0;
        const isPositive = positiveSignals.has(skillId);

        // Ensure row exists
        const existing = await this.db
          .select()
          .from(playerSkillMastery)
          .where(
            and(eq(playerSkillMastery.userId, userId), eq(playerSkillMastery.skillId, skillId)),
          )
          .limit(1);

        let row = existing[0];
        if (!row) {
          const [inserted] = await this.db
            .insert(playerSkillMastery)
            .values({
              userId,
              skillId,
              domain: skill.domain,
              pMastery: 0.3,
              pTransit: 0.1,
              pSlip: 0.1,
              pGuess: 0.2,
              observations: 0,
              trend: 'stable',
            })
            .onConflictDoNothing()
            .returning();

          if (inserted) {
            row = inserted;
          } else {
            // Race condition — re-fetch
            const refetch = await this.db
              .select()
              .from(playerSkillMastery)
              .where(
                and(eq(playerSkillMastery.userId, userId), eq(playerSkillMastery.skillId, skillId)),
              )
              .limit(1);
            row = refetch[0];
            if (!row) continue;
          }
        }

        let newMastery = row.pMastery;
        const pSlip = row.pSlip;
        const pGuess = row.pGuess;
        const pTransit = row.pTransit;

        // Apply negative signals (each death is one incorrect observation)
        for (let i = 0; i < negCount; i++) {
          const pIncorrect = newMastery * pSlip + (1 - newMastery) * (1 - pGuess);
          const pLGivenIncorrect = (newMastery * pSlip) / Math.max(pIncorrect, 0.001);
          newMastery = pLGivenIncorrect + (1 - pLGivenIncorrect) * pTransit;
        }

        // Apply positive signal (strength observed = one correct observation)
        if (isPositive) {
          const pCorrect = newMastery * (1 - pSlip) + (1 - newMastery) * pGuess;
          const pLGivenCorrect = (newMastery * (1 - pSlip)) / Math.max(pCorrect, 0.001);
          newMastery = pLGivenCorrect + (1 - pLGivenCorrect) * pTransit;
        }

        // Clamp
        newMastery = Math.max(0.01, Math.min(0.99, newMastery));

        // Determine trend
        const prevMastery = row.pMastery;
        const delta = newMastery - prevMastery;
        let trend = 'stable';
        if (delta > 0.03) trend = 'improving';
        else if (delta < -0.03) trend = 'regressing';

        // Update
        await this.db
          .update(playerSkillMastery)
          .set({
            pMastery: newMastery,
            observations: sql`${playerSkillMastery.observations} + ${negCount + (isPositive ? 1 : 0)}`,
            lastObservedAt: new Date(),
            trend,
          })
          .where(eq(playerSkillMastery.id, row.id));

        updatedSkills.push(skillId);
      }

      console.log(
        '[SkillMastery] Updated %d skills for user %s: %s',
        updatedSkills.length,
        userId,
        updatedSkills.join(', '),
      );

      return { updated: updatedSkills.length, skills: updatedSkills };
    } catch (err) {
      console.warn('[SkillMastery] Failed:', err instanceof Error ? err.message : err);
      return { updated: 0, skills: [] };
    }
  }

  /**
   * Get the full mastery profile for a user — used for brain context injection.
   */
  async getMasteryProfile(userId: string): Promise<MasteryProfile> {
    try {
      const rows = await this.db
        .select()
        .from(playerSkillMastery)
        .where(eq(playerSkillMastery.userId, userId))
        .orderBy(playerSkillMastery.pMastery);

      const skills = rows.map((r) => {
        const def = SKILL_TAXONOMY.find((s) => s.id === r.skillId);
        return {
          id: r.skillId,
          name: def?.name ?? r.skillId,
          domain: r.domain,
          mastery: r.pMastery,
          trend: r.trend,
          observations: r.observations,
        };
      });

      const observed = skills.filter((s) => s.observations > 0);
      const weakest = observed.slice(0, 3);
      const strongest = observed.slice(-3).reverse();

      return { skills, weakest, strongest };
    } catch (err) {
      console.warn(
        '[SkillMastery] getMasteryProfile failed:',
        err instanceof Error ? err.message : err,
      );
      return { skills: [], weakest: [], strongest: [] };
    }
  }

  /**
   * Format mastery profile as a context block for prompt injection.
   */
  formatForPrompt(profile: MasteryProfile): string {
    if (profile.skills.length === 0) return '';

    const observed = profile.skills.filter((s) => s.observations > 0);
    if (observed.length === 0) return '';

    const lines: string[] = ['SKILL MASTERY:'];

    for (const s of observed) {
      const level =
        s.mastery < 0.3
          ? 'weak'
          : s.mastery < 0.6
            ? 'developing'
            : s.mastery < 0.8
              ? 'solid'
              : 'strong';
      const arrow =
        s.trend === 'improving' ? '\u2191' : s.trend === 'regressing' ? '\u2193' : '\u2192';
      lines.push(
        `  \u2022 ${s.name}: ${(s.mastery * 100).toFixed(0)}% (${level}) ${arrow} ${s.trend} [${s.observations} obs]`,
      );
    }

    if (profile.weakest.length > 0) {
      lines.push('');
      lines.push('PRIORITY AREAS (lowest mastery):');
      for (const w of profile.weakest) {
        lines.push(`  \u2022 ${w.name}: ${(w.mastery * 100).toFixed(0)}%`);
      }
    }

    return lines.join('\n');
  }
}
