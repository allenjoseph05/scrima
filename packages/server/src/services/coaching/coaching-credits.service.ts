/**
 * Coaching Credits Service
 *
 * One credit = one Tier 3 deep coaching session.
 * Credits are per-user per-month, no rollover, refunded on failure.
 *
 * Free: 0 credits/month
 * Pro:  4 credits/month
 * Ultra: 12 credits/month
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingCredits, users } from '../../db/schema.js';

const CREDITS_BY_TIER: Record<string, number> = {
  free: process.env.NODE_ENV === 'development' ? 99 : 0,
  pro: 4,
  ultra: 12,
};

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthResetDate(month: string): Date {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1));
}

export interface CreditBalance {
  total: number;
  used: number;
  remaining: number;
  resetsAt: Date;
  month: string;
}

export class CoachingCreditsService {
  constructor(private db: Db) {}

  /** Get (or create) the current month's credit record for a user. */
  async getCredits(userId: string): Promise<CreditBalance> {
    const month = currentMonth();

    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    const tier = user?.subscriptionTier ?? 'free';
    const total = CREDITS_BY_TIER[tier] ?? 0;

    let row = await this.db.query.coachingCredits.findFirst({
      where: and(eq(coachingCredits.userId, userId), eq(coachingCredits.month, month)),
    });

    if (!row) {
      const inserted = await this.db
        .insert(coachingCredits)
        .values({ userId, month, creditsTotal: total, creditsUsed: 0 })
        .onConflictDoNothing()
        .returning();
      row =
        inserted[0] ??
        (await this.db.query.coachingCredits.findFirst({
          where: and(eq(coachingCredits.userId, userId), eq(coachingCredits.month, month)),
        }));
    }

    // If user upgraded, update total
    if (row && row.creditsTotal !== total) {
      await this.db
        .update(coachingCredits)
        .set({ creditsTotal: total })
        .where(eq(coachingCredits.id, row.id));
    }

    const used = row?.creditsUsed ?? 0;
    return {
      total,
      used,
      remaining: Math.max(0, total - used),
      resetsAt: monthResetDate(month),
      month,
    };
  }

  /**
   * Check credits and decrement atomically.
   * Uses a single UPDATE with a WHERE guard to prevent TOCTOU races.
   * Returns { allowed, remaining } — allowed is true if a credit was consumed.
   */
  async checkAndDecrement(userId: string): Promise<{ allowed: boolean; remaining: number }> {
    // Ensure the record exists (and syncs tier total) before atomic decrement
    await this.getCredits(userId);

    const month = currentMonth();

    // Atomic decrement: only succeeds if credits_used < credits_total
    const result = await this.db.execute(sql`
      UPDATE coaching_credits
      SET credits_used = credits_used + 1
      WHERE user_id = ${userId}
      AND month = ${month}
      AND credits_used < credits_total
      RETURNING credits_total - credits_used as remaining
    `);

    if (result.rows.length === 0) {
      // No row updated = no credits remaining
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: Number(result.rows[0].remaining) };
  }

  /** Refund one credit atomically (called when analysis fails). */
  async refund(userId: string): Promise<void> {
    const month = currentMonth();
    await this.db.execute(sql`
      UPDATE coaching_credits
      SET credits_used = GREATEST(0, credits_used - 1)
      WHERE user_id = ${userId}
      AND month = ${month}
    `);
  }
}
