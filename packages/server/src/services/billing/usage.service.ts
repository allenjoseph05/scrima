import { SUBSCRIPTION_TIERS } from '@scrima/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { usageRecords, users } from '../../db/schema.js';

export type UsageOperation = 'game_analysis' | 'weekly_report';

export interface UsageCheck {
  allowed: boolean;
  reason?: string;
  remaining?: number;
}

export class UsageService {
  constructor(private db: Db) {}

  async canPerform(userId: string, operation: UsageOperation): Promise<UsageCheck> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) return { allowed: false, reason: 'User not found' };

    const tier = user.subscriptionTier as keyof typeof SUBSCRIPTION_TIERS;
    const limits = SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free;

    const periodStart = this.getPeriodStart();

    const records = await this.db
      .select()
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, userId),
          eq(usageRecords.operation, operation),
          gte(usageRecords.billingPeriodStart, periodStart),
        ),
      );

    const totalCount = records.reduce((sum, r) => sum + r.count, 0);
    const limit = limits.analysesPerWeek;

    if (limit === Number.POSITIVE_INFINITY) return { allowed: true };
    if (totalCount >= limit) {
      return { allowed: false, reason: `Weekly analysis limit (${limit}) reached`, remaining: 0 };
    }
    return { allowed: true, remaining: limit - totalCount };
  }

  /**
   * Atomically check the usage limit and record usage in a single transaction.
   * Prevents TOCTOU races between canPerform() and recordUsage().
   */
  async recordUsage(
    userId: string,
    operation: UsageOperation,
    costUsd: number,
  ): Promise<{ allowed: boolean; remaining?: number }> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) return { allowed: false };

    const tier = user.subscriptionTier as keyof typeof SUBSCRIPTION_TIERS;
    const limits = SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free;
    const limit = limits.analysesPerWeek;

    // Unlimited tier — skip count check
    if (limit === Number.POSITIVE_INFINITY) {
      await this.db.insert(usageRecords).values({
        userId,
        operation,
        billingPeriodStart: this.getPeriodStart(),
        count: 1,
        totalCostUsd: costUsd,
      });
      return { allowed: true };
    }

    const periodStart = this.getPeriodStart();

    return await this.db.transaction(async (tx) => {
      const countResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            eq(usageRecords.operation, operation),
            gte(usageRecords.billingPeriodStart, periodStart),
          ),
        );

      const totalCount = countResult[0]?.count ?? 0;
      if (totalCount >= limit) {
        return { allowed: false, remaining: 0 };
      }

      await tx.insert(usageRecords).values({
        userId,
        operation,
        billingPeriodStart: periodStart,
        count: 1,
        totalCostUsd: costUsd,
      });

      return { allowed: true, remaining: limit - totalCount - 1 };
    });
  }

  async getCurrentUsage(userId: string) {
    const periodStart = this.getPeriodStart();
    return this.db
      .select()
      .from(usageRecords)
      .where(
        and(eq(usageRecords.userId, userId), gte(usageRecords.billingPeriodStart, periodStart)),
      );
  }

  getPeriodStart(): Date {
    // Weekly window: Monday 00:00 UTC
    const now = new Date();
    const day = now.getUTCDay();
    const daysToMonday = day === 0 ? 6 : day - 1;
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - daysToMonday,
        0,
        0,
        0,
        0,
      ),
    );
  }
}
