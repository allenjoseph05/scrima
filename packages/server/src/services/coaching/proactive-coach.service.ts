/**
 * Proactive Coach Service (Phase 7D — Living Mind)
 *
 * The coach initiates conversation on key events:
 *   - era_closed: "You just wrapped {era.title}."
 *   - era_started: "Starting a new chapter: {era.title}."
 *   - hypothesis_new: "Noticed something — can you confirm?"
 *   - returning_player: "Welcome back. Been {N} days — let me re-check."
 *   - plateau_detected: "Same focus {N} weeks. Try a different angle?"
 *
 * Messages are stored as graph nodes (nodeType='coach_message') so they
 * persist, deduplicate, and get swept by consolidation if unread forever.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §8.2
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingGraphNodes, matches } from '../../db/schema.js';
import type { EraRecord } from './era-detection.service.js';
import type { HypothesisRecord } from './hypothesis-generator.service.js';

// ── Constants ───────────────────────────────────────────────────────────────

const RETURNING_PLAYER_THRESHOLD_DAYS = 14;
const PLATEAU_THRESHOLD_DAYS = 42;
const PLATEAU_NOTIFICATION_COOLDOWN_DAYS = 14;
const MAX_UNREAD_BEFORE_SUPPRESSION = 5;

// ── Types ───────────────────────────────────────────────────────────────────

export type CoachMessageTrigger =
  | 'era_closed'
  | 'era_started'
  | 'hypothesis_new'
  | 'returning_player'
  | 'plateau_detected';

export interface CoachMessageData {
  trigger: CoachMessageTrigger;
  triggerRef?: string;
  body?: string;
  read: boolean;
  readAt?: string;
}

export interface CoachMessageRecord {
  id: string;
  label: string;
  data: CoachMessageData;
  createdAt: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ProactiveCoachService {
  constructor(private db: Db) {}

  // ── Notification entry points (called by other services) ────────────────

  async notifyEraClosed(userId: string, era: EraRecord): Promise<void> {
    const masteryLine =
      era.data.startMastery != null && era.data.endMastery != null
        ? `${Math.round(era.data.startMastery * 100)}% → ${Math.round(era.data.endMastery * 100)}%`
        : '';
    const body = era.data.summary ? era.data.summary : undefined;
    await this.create(userId, {
      trigger: 'era_closed',
      triggerRef: era.id,
      label: `Chapter wrapped: ${era.label}. ${masteryLine}`.trim(),
      body,
    });
  }

  async notifyEraStarted(userId: string, era: EraRecord): Promise<void> {
    await this.create(userId, {
      trigger: 'era_started',
      triggerRef: era.id,
      label: `New chapter started: ${era.label}.`,
      body: `We're working on ${era.data.primarySkillName.toLowerCase()} from ${Math.round(era.data.startMastery * 100)}% mastery.`,
    });
  }

  async notifyHypothesisNew(userId: string, h: HypothesisRecord): Promise<void> {
    await this.create(userId, {
      trigger: 'hypothesis_new',
      triggerRef: h.id,
      label: `I'm noticing something: ${h.label}`,
      body: h.data.evidence,
    });
  }

  /**
   * Check whether the current report's match means the player is returning
   * after a long break. If so, create a welcome-back message.
   */
  async maybeNotifyReturningPlayer(userId: string): Promise<void> {
    const rows = await this.db
      .select({ playedAt: matches.playedAt })
      .from(matches)
      .where(eq(matches.userId, userId))
      .orderBy(desc(matches.playedAt))
      .limit(2);

    if (rows.length < 2) return; // needs a prior match to compare against

    const [curr, prev] = rows;
    const diffDays = (curr.playedAt.getTime() - prev.playedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < RETURNING_PLAYER_THRESHOLD_DAYS) return;

    // Deduplicate — don't fire twice within 3 days for the same player
    const recentReturn = await this.getRecentByTrigger(userId, 'returning_player', 3);
    if (recentReturn) return;

    await this.create(userId, {
      trigger: 'returning_player',
      label: `Welcome back. It's been ${Math.round(diffDays)} days — let me re-check where you're at.`,
    });
  }

  /**
   * Check whether the currently active era has been open > PLATEAU_THRESHOLD_DAYS
   * without graduating. If so, fire a plateau prompt (with its own cooldown).
   */
  async maybeNotifyPlateau(userId: string): Promise<void> {
    const eraRows = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'era')))
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(5);

    const activeEra = eraRows.find((r) => (r.data as any)?.status === 'active');
    if (!activeEra) return;

    const data = activeEra.data as any;
    const startDate = new Date(data.startDate);
    const daysOpen = (Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOpen < PLATEAU_THRESHOLD_DAYS) return;

    const recentPlateau = await this.getRecentByTrigger(
      userId,
      'plateau_detected',
      PLATEAU_NOTIFICATION_COOLDOWN_DAYS,
    );
    if (recentPlateau) return;

    const weeks = Math.round(daysOpen / 7);
    await this.create(userId, {
      trigger: 'plateau_detected',
      triggerRef: activeEra.id,
      label: `Same focus for ${weeks} weeks. Want to try a different drill?`,
      body: `We've been on ${data.primarySkillName ?? 'this skill'} for ${weeks} weeks without graduation. Sometimes a different angle unsticks it.`,
    });
  }

  // ── Read-side API ───────────────────────────────────────────────────────

  /**
   * Return unread coach messages, newest first. Caps at 10 to avoid UI overflow.
   */
  async listUnread(userId: string): Promise<CoachMessageRecord[]> {
    const rows = await this.db
      .select({
        id: coachingGraphNodes.id,
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'coach_message'),
        ),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(20);

    return rows
      .filter((r) => !(r.data as CoachMessageData)?.read)
      .slice(0, 10)
      .map((r) => ({
        id: r.id,
        label: r.label,
        data: r.data as CoachMessageData,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  async markRead(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.id, id),
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'coach_message'),
        ),
      )
      .limit(1);
    if (rows.length === 0) return false;
    const data = rows[0].data as CoachMessageData;
    await this.db
      .update(coachingGraphNodes)
      .set({
        data: { ...data, read: true, readAt: new Date().toISOString() },
        importance: 0.3,
      })
      .where(eq(coachingGraphNodes.id, id));
    return true;
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async create(
    userId: string,
    input: {
      trigger: CoachMessageTrigger;
      label: string;
      body?: string;
      triggerRef?: string;
    },
  ): Promise<void> {
    // Avoid spam: if the user has a backlog of unread messages, silently skip.
    const unreadCount = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'coach_message'),
          sql`data ->> 'read' IS DISTINCT FROM 'true'`,
        ),
      );
    if (Number(unreadCount[0]?.count ?? 0) >= MAX_UNREAD_BEFORE_SUPPRESSION) {
      return;
    }

    await this.db.insert(coachingGraphNodes).values({
      userId,
      nodeType: 'coach_message',
      label: input.label,
      data: {
        trigger: input.trigger,
        triggerRef: input.triggerRef,
        body: input.body,
        read: false,
      } as CoachMessageData,
      importance: 0.7,
    });
    console.log('[ProactiveCoach] %s → %s', input.trigger, input.label);
  }

  private async getRecentByTrigger(
    userId: string,
    trigger: CoachMessageTrigger,
    withinDays: number,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({ id: coachingGraphNodes.id })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'coach_message'),
          gte(coachingGraphNodes.createdAt, cutoff),
          sql`data ->> 'trigger' = ${trigger}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
