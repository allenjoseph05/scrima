/**
 * Weekly Report Service
 *
 * Runs every Sunday 11 PM UTC (BullMQ cron).
 *
 * For each paid user who played games this week:
 *   1. Find matches from the past 7 days
 *   2. Select top 2-3 games that haven't been analyzed yet
 *   3. Decrement credits for each selected game
 *   4. Create weekly_coaching_report with status='awaiting_uploads'
 *      (the selected match IDs are stored — client fetches and uploads them)
 *
 * When client uploads the recordings via POST /coaching/deep-analyze
 * with trigger='weekly_report', each game is analyzed individually.
 * When all per-game reports complete, synthesize() is called to build
 * the final weekly report.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Db } from '../../db/index.js';
import { coachingReports, matches, users, weeklyCoachingReports } from '../../db/schema.js';
import { logger } from '../../shared/logger.js';
import type { CoachingCreditsService } from './coaching-credits.service.js';

export class WeeklyReportService {
  constructor(
    private db: Db,
    private credits: CoachingCreditsService,
  ) {}

  async generateForAllPaidUsers(): Promise<void> {
    const paidUsers = await this.db
      .select({ id: users.id, tier: users.subscriptionTier })
      .from(users)
      .where(inArray(users.subscriptionTier, ['pro', 'ultra']));

    logger.info({ count: paidUsers.length }, 'Weekly report: processing paid users');

    for (const user of paidUsers) {
      await this.generateForUser(user.id).catch((err) =>
        logger.error({ userId: user.id, err }, 'Weekly report generation failed for user'),
      );
    }
  }

  async generateForUser(userId: string): Promise<void> {
    const { weekStart, weekEnd } = currentWeekBounds();
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(weekEnd);

    // Idempotent — skip if already created
    const existing = await this.db.query.weeklyCoachingReports.findFirst({
      where: and(
        eq(weeklyCoachingReports.userId, userId),
        eq(weeklyCoachingReports.weekStart, weekStartStr),
      ),
    });
    if (existing) return;

    // Games played this week
    const gamesThisWeek = await this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.userId, userId),
          gte(matches.playedAt, weekStart),
          lte(matches.playedAt, weekEnd),
        ),
      );

    if (gamesThisWeek.length === 0) return;

    // Prefer games with more deaths and close scores
    const scoredGames = gamesThisWeek
      .map((m) => ({
        matchId: m.id,
        score:
          (m.deaths ?? 0) * 2 +
          (m.won === false ? 5 : 0) +
          ((m.scoreTeam ?? 0) + (m.scoreEnemy ?? 0) > 0 &&
          Math.abs((m.scoreTeam ?? 0) - (m.scoreEnemy ?? 0)) <= 3
            ? 3
            : 0),
      }))
      .sort((a, b) => b.score - a.score);

    // How many credits available
    const balance = await this.credits.getCredits(userId);
    const gamesCount = Math.min(3, scoredGames.length, balance.remaining);
    if (gamesCount === 0) return;

    const selectedMatchIds = scoredGames.slice(0, gamesCount).map((g) => g.matchId);

    // Decrement credits for selected games
    let creditsObtained = 0;
    for (let i = 0; i < gamesCount; i++) {
      const creditResult = await this.credits.checkAndDecrement(userId);
      if (!creditResult.allowed) break;
      creditsObtained++;
    }
    // Only use as many matches as credits we obtained
    const actualMatchIds = selectedMatchIds.slice(0, creditsObtained);
    if (creditsObtained === 0) return;

    await this.db.insert(weeklyCoachingReports).values({
      id: uuidv4(),
      userId,
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      status: 'awaiting_uploads',
      gamesPlayed: gamesThisWeek.length,
      totalDeaths: gamesThisWeek.reduce((s, m) => s + (m.deaths ?? 0), 0),
      selectedMatchIds: actualMatchIds,
      patternBreakdown: {} as any,
      progressChart: [] as any,
      topMoments: [],
      positiveHighlights: [],
      assessment: {},
      drills: [],
    });

    logger.info(
      { userId, weekStart: weekStartStr, selectedMatchIds: actualMatchIds },
      'Weekly report created, awaiting uploads',
    );
  }

  async synthesize(userId: string, weekStart: string): Promise<void> {
    const weeklyReport = await this.db.query.weeklyCoachingReports.findFirst({
      where: and(
        eq(weeklyCoachingReports.userId, userId),
        eq(weeklyCoachingReports.weekStart, weekStart),
      ),
    });
    if (!weeklyReport || weeklyReport.status !== 'processing') return;

    // Fetch all per-game reports for selected matches
    const gameReports = await this.db
      .select()
      .from(coachingReports)
      .where(
        and(
          eq(coachingReports.userId, userId),
          eq(coachingReports.trigger, 'weekly_report'),
          eq(coachingReports.status, 'completed'),
          sql`${coachingReports.matchIds} && ARRAY[${sql.join(
            weeklyReport.selectedMatchIds.map((id) => sql`${id}`),
            sql`,`,
          )}]::text[]`,
        ),
      );

    if (gameReports.length === 0) return;

    const allMoments: any[] = [];
    const allPositive: any[] = [];
    const allDrills: any[] = [];

    for (const gr of gameReports) {
      const r = gr.report as any;
      if (r?.moments) allMoments.push(...r.moments);
      if (r?.positiveHighlights) allPositive.push(...r.positiveHighlights);
      if (r?.drills) allDrills.push(...r.drills);
    }

    const severityOrder: Record<string, number> = { critical: 0, important: 1, minor: 2 };
    const topMoments = allMoments
      .sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2))
      .slice(0, 10);

    const uniqueDrills = Array.from(new Map(allDrills.map((d) => [d.name, d])).values()).slice(
      0,
      3,
    );

    const allAssessments = gameReports.map((r) => r.overallAssessment).filter(Boolean);

    await this.db
      .update(weeklyCoachingReports)
      .set({
        status: 'completed',
        gamesAnalyzedDeep: gameReports.length,
        topMoments: topMoments as any,
        positiveHighlights: allPositive.slice(0, 5) as any,
        assessment: { overall: allAssessments[0] ?? '' } as any,
        drills: uniqueDrills as any,
      })
      .where(
        and(
          eq(weeklyCoachingReports.userId, userId),
          eq(weeklyCoachingReports.weekStart, weekStart),
        ),
      );

    logger.info({ userId, weekStart }, 'Weekly report synthesized and completed');
  }
}

function currentWeekBounds(): { weekStart: Date; weekEnd: Date } {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  const weekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToMonday),
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { weekStart, weekEnd };
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
