/**
 * Chat quota service — authoritative enforcement for Ask-Your-Coach chat.
 *
 * Client-side counters in the React store are advisory only. This service
 * is the source of truth. Rows are keyed on (userId, matchId, dayStart)
 * so "15 per match per day" and "15 brain-chat per day" are independent.
 *
 * Soft-blocked / safety-filtered responses do NOT increment the counter —
 * callers invoke `record()` only after a successful LLM response.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { chatQuotaUsage } from '../../db/schema.js';

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  reached: boolean;
  dayStart: string;
}

export const BRAIN_CHAT_MATCH_KEY = ''; // empty string bucket for brain chat

/** Return the UTC-midnight ISO date string (YYYY-MM-DD) for the given moment. */
function todayKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class ChatQuotaService {
  constructor(
    private readonly db: Db,
    private readonly limit = 15,
  ) {}

  getLimit(): number {
    return this.limit;
  }

  async status(userId: string, matchId: string): Promise<QuotaStatus> {
    const dayStart = todayKey();
    const row = await this.db.query.chatQuotaUsage.findFirst({
      where: and(
        eq(chatQuotaUsage.userId, userId),
        eq(chatQuotaUsage.matchId, matchId),
        eq(chatQuotaUsage.dayStart, dayStart),
      ),
    });
    const used = row?.count ?? 0;
    const remaining = Math.max(0, this.limit - used);
    return { limit: this.limit, used, remaining, reached: remaining === 0, dayStart };
  }

  /**
   * Record one billable chat question. Returns the new status.
   * Uses INSERT ... ON CONFLICT DO UPDATE so it's safe under concurrency.
   */
  async record(userId: string, matchId: string): Promise<QuotaStatus> {
    const dayStart = todayKey();
    const rows = await this.db
      .insert(chatQuotaUsage)
      .values({ userId, matchId, dayStart, count: 1 })
      .onConflictDoUpdate({
        target: [chatQuotaUsage.userId, chatQuotaUsage.matchId, chatQuotaUsage.dayStart],
        set: {
          count: sql`${chatQuotaUsage.count} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ count: chatQuotaUsage.count });

    const used = rows[0]?.count ?? 0;
    const remaining = Math.max(0, this.limit - used);
    return { limit: this.limit, used, remaining, reached: remaining === 0, dayStart };
  }
}
