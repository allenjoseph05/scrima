/**
 * Strategy Service — Self-evolving coaching approach per player (MemRL-inspired).
 *
 * Tracks which coaching strategies work for each player via Q-values:
 *   - After enrichment: extract strategies used from the coaching report
 *   - Before next enrichment: check if previously coached skills improved
 *   - Update Q-values: improvement → boost, regression → decay
 *
 * Strategy types:
 *   - correction_style: how mistakes are framed ("direct" vs "socratic" vs "example-based")
 *   - focus_area: which skill category was prioritized ("peeking" vs "utility" vs "positioning")
 *   - framing: how advice is framed ("play structured" vs "play passive" vs "take initiative")
 *   - drill_type: what practice was recommended ("aim trainer" vs "custom game" vs "vod review")
 *
 * Q-value update (Thompson Sampling / Bayesian):
 *   Q_new = Q_old + alpha * (reward - Q_old)
 *   where alpha = 1 / (attempts + 1), reward = 1 if improved else 0
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingStrategies, playerSkillMastery } from '../../db/schema.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Learning rate floor — prevents Q-value from becoming immovable after many attempts */
const MIN_ALPHA = 0.05;

/** Max strategies per user (prevents unbounded growth) */
const MAX_STRATEGIES_PER_USER = 100;

// ── Types ────────────────────────────────────────────────────────────────────

interface ExtractedStrategy {
  type: 'correction_style' | 'focus_area' | 'framing' | 'drill_type';
  description: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class StrategyService {
  constructor(private db: Db) {}

  /**
   * Extract and record coaching strategies from a completed enrichment.
   * Called post-enrichment to log what approaches were used this session.
   */
  async recordStrategiesFromReport(userId: string, report: any): Promise<{ recorded: number }> {
    try {
      const strategies = this.extractStrategies(report);
      if (strategies.length === 0) return { recorded: 0 };

      let recorded = 0;
      for (const strat of strategies) {
        await this.db
          .insert(coachingStrategies)
          .values({
            userId,
            strategyType: strat.type,
            description: strat.description,
            qValue: 0.5,
            attempts: 1,
            lastUsedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              coachingStrategies.userId,
              coachingStrategies.strategyType,
              coachingStrategies.description,
            ],
            set: {
              attempts: sql`${coachingStrategies.attempts} + 1`,
              lastUsedAt: new Date(),
            },
          });
        recorded++;
      }

      // Enforce strategy cap to prevent unbounded growth
      await this.enforceStrategyCap(userId);

      console.log('[Strategy] Recorded %d strategies for user %s', recorded, userId);
      return { recorded };
    } catch (err) {
      console.warn('[Strategy] recordStrategies failed:', err instanceof Error ? err.message : err);
      return { recorded: 0 };
    }
  }

  /**
   * Update Q-values based on whether previously coached skills improved.
   * Called post-enrichment AFTER BKT mastery update — compares current vs previous mastery.
   *
   * Logic: If a focus_area strategy targeted "peeking" and peeking_technique mastery
   * improved since last session, that strategy gets a success signal.
   */
  async updateQValues(userId: string): Promise<{ updated: number }> {
    try {
      // Get all strategies with recent usage
      const strategies = await this.db
        .select()
        .from(coachingStrategies)
        .where(eq(coachingStrategies.userId, userId));

      if (strategies.length === 0) return { updated: 0 };

      // Get current skill mastery state
      const skills = await this.db
        .select({
          skillId: playerSkillMastery.skillId,
          pMastery: playerSkillMastery.pMastery,
          trend: playerSkillMastery.trend,
        })
        .from(playerSkillMastery)
        .where(and(eq(playerSkillMastery.userId, userId), gt(playerSkillMastery.observations, 0)));

      const skillMap = new Map(skills.map((s) => [s.skillId, s]));
      let updated = 0;

      for (const strat of strategies) {
        // Only update strategies used in the last 7 days (recent enough for signal)
        if (strat.lastUsedAt) {
          const daysSinceUse = (Date.now() - strat.lastUsedAt.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceUse > 7) continue;
        }

        const reward = this.evaluateReward(strat, skillMap);
        if (reward === null) continue; // no signal

        // Q-learning update: Q_new = Q_old + alpha * (reward - Q_old)
        const alpha = Math.max(MIN_ALPHA, 1 / (strat.attempts + 1));
        const newQ = Math.max(0.01, Math.min(0.99, strat.qValue + alpha * (reward - strat.qValue)));

        const isSuccess = reward >= 0.5;
        await this.db
          .update(coachingStrategies)
          .set({
            qValue: newQ,
            successes: isSuccess
              ? sql`${coachingStrategies.successes} + 1`
              : coachingStrategies.successes,
          })
          .where(eq(coachingStrategies.id, strat.id));

        updated++;
      }

      if (updated > 0) {
        console.log('[Strategy] Updated %d Q-values for user %s', updated, userId);
      }

      return { updated };
    } catch (err) {
      console.warn('[Strategy] updateQValues failed:', err instanceof Error ? err.message : err);
      return { updated: 0 };
    }
  }

  /**
   * Get effective strategies for prompt injection — what works for this player.
   */
  async getEffectiveStrategies(userId: string): Promise<{
    effective: { type: string; description: string; qValue: number }[];
    ineffective: { type: string; description: string; qValue: number }[];
  }> {
    try {
      const strategies = await this.db
        .select({
          strategyType: coachingStrategies.strategyType,
          description: coachingStrategies.description,
          qValue: coachingStrategies.qValue,
          attempts: coachingStrategies.attempts,
        })
        .from(coachingStrategies)
        .where(
          and(
            eq(coachingStrategies.userId, userId),
            gt(coachingStrategies.attempts, 1), // need at least 2 uses for signal
          ),
        )
        .orderBy(desc(coachingStrategies.qValue));

      const effective = strategies
        .filter((s) => s.qValue >= 0.6)
        .slice(0, 5)
        .map((s) => ({ type: s.strategyType, description: s.description, qValue: s.qValue }));

      const ineffective = strategies
        .filter((s) => s.qValue < 0.35)
        .slice(0, 3)
        .map((s) => ({ type: s.strategyType, description: s.description, qValue: s.qValue }));

      return { effective, ineffective };
    } catch (err) {
      console.warn(
        '[Strategy] getEffectiveStrategies failed:',
        err instanceof Error ? err.message : err,
      );
      return { effective: [], ineffective: [] };
    }
  }

  /**
   * Format strategies for prompt injection.
   */
  formatForPrompt(strategies: {
    effective: { type: string; description: string; qValue: number }[];
    ineffective: { type: string; description: string; qValue: number }[];
  }): string {
    if (strategies.effective.length === 0 && strategies.ineffective.length === 0) return '';

    const lines: string[] = [];

    if (strategies.effective.length > 0) {
      lines.push('EFFECTIVE COACHING APPROACHES (what works for this player):');
      for (const s of strategies.effective) {
        lines.push(`  \u2022 ${s.description} (Q: ${s.qValue.toFixed(2)})`);
      }
    }

    if (strategies.ineffective.length > 0) {
      lines.push('');
      lines.push('AVOID (low effectiveness for this player):');
      for (const s of strategies.ineffective) {
        lines.push(`  \u2022 ${s.description} (Q: ${s.qValue.toFixed(2)})`);
      }
    }

    return lines.join('\n');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Extract coaching strategies from a report (no extra LLM calls).
   */
  private extractStrategies(report: any): ExtractedStrategy[] {
    const strategies: ExtractedStrategy[] = [];
    const priority = report.priorityIssue ?? report.priority_pattern;
    const sessionFocus = report.sessionFocus;

    // Focus area from priority pattern category
    if (priority?.category) {
      strategies.push({
        type: 'focus_area',
        description: `Focus on ${priority.category} issues`,
      });
    }

    // Correction style detection from coaching text
    const deaths = report.deathCoaching ?? report.death_coaching ?? [];
    if (deaths.length > 0) {
      // Check if corrections use specific examples vs generic advice
      const corrections = deaths.map((d: any) => d.correction ?? '').join(' ');
      const hasSpecificExamples = /round \d|at \d+:\d+|this specific/i.test(corrections);
      const hasSocratic = /\?|consider|think about|what if/i.test(corrections);

      if (hasSpecificExamples) {
        strategies.push({
          type: 'correction_style',
          description: 'Example-based corrections (references specific rounds/moments)',
        });
      }
      if (hasSocratic) {
        strategies.push({
          type: 'correction_style',
          description: 'Socratic corrections (asks questions, prompts self-reflection)',
        });
      }
      if (!hasSpecificExamples && !hasSocratic) {
        strategies.push({
          type: 'correction_style',
          description: 'Direct corrections (states what to do differently)',
        });
      }
    }

    // Framing from session focus / drill recommendations
    if (sessionFocus?.drill) {
      const drill =
        typeof sessionFocus.drill === 'string'
          ? sessionFocus.drill
          : (sessionFocus.drill?.name ?? '');
      if (drill) {
        strategies.push({
          type: 'drill_type',
          description: drill.slice(0, 100),
        });
      }
    }

    // Framing from the overall coaching approach
    const verdict = report.matchVerdict ?? report.match_verdict ?? '';
    if (/passive|patient|hold|wait/i.test(verdict)) {
      strategies.push({ type: 'framing', description: 'Passive/patient play framing' });
    } else if (/aggress|push|entry|create/i.test(verdict)) {
      strategies.push({ type: 'framing', description: 'Aggressive/initiative play framing' });
    } else if (/structur|disciplin|system/i.test(verdict)) {
      strategies.push({ type: 'framing', description: 'Structured/disciplined play framing' });
    }

    return strategies;
  }

  /**
   * Evaluate how well a strategy worked based on current skill trends.
   * Returns reward 0-1, or null if no signal.
   */
  private evaluateReward(
    strategy: { strategyType: string; description: string },
    skillMap: Map<string, { skillId: string; pMastery: number; trend: string }>,
  ): number | null {
    if (strategy.strategyType === 'focus_area') {
      // Extract category from description like "Focus on peeking issues"
      const match = strategy.description.match(/Focus on (\w+)/);
      if (!match) return null;
      const category = match[1];

      // Find skills in this category and check their trends
      const categorySkillMap: Record<string, string[]> = {
        peeking: ['peeking_technique', 'angle_discipline'],
        positioning: ['positioning', 'angle_discipline', 'map_awareness'],
        utility: [
          'utility_timing',
          'ability_economy',
          'flash_coordination',
          'smoke_usage',
          'setup_utility',
        ],
        movement: ['counter_strafing', 'movement_discipline'],
        crosshair: ['crosshair_placement', 'spray_control'],
        game_sense: ['map_awareness', 'rotation_timing', 'information_gathering', 'adaptability'],
        trading: ['trading'],
        economy: ['economy_management'],
      };

      const relatedSkills = categorySkillMap[category] ?? [];
      if (relatedSkills.length === 0) return null;

      let improving = 0;
      let total = 0;
      for (const skillId of relatedSkills) {
        const skill = skillMap.get(skillId);
        if (!skill) continue;
        total++;
        if (skill.trend === 'improving') improving++;
      }

      if (total === 0) return null;
      return improving / total;
    }

    if (strategy.strategyType === 'correction_style' || strategy.strategyType === 'framing') {
      // For non-skill-specific strategies, use overall improvement signal
      let improving = 0;
      let total = 0;
      for (const [_, skill] of skillMap) {
        total++;
        if (skill.trend === 'improving') improving++;
      }
      if (total === 0) return null;
      return improving / total;
    }

    return null;
  }

  /**
   * Enforce strategy cap per user.
   */
  async enforceStrategyCap(userId: string): Promise<void> {
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingStrategies)
      .where(eq(coachingStrategies.userId, userId));

    const count = Number(countResult[0]?.count ?? 0);
    if (count <= MAX_STRATEGIES_PER_USER) return;

    const excess = count - MAX_STRATEGIES_PER_USER;
    await this.db.execute(sql`
      DELETE FROM coaching_strategies
      WHERE id IN (
        SELECT id FROM coaching_strategies
        WHERE user_id = ${userId}
        ORDER BY q_value ASC, last_used_at ASC NULLS FIRST
        LIMIT ${excess}
      )
    `);
  }
}
