/**
 * Game Analysis Service — Single-Pass Architecture
 *
 * Flow:
 *   1. Check coaching credit (fail fast if none)
 *   2. Decrement credit
 *   3. Create coaching_report row (status = 'processing')
 *   4. Create coaching_job row (status = 'processing')
 *   5. Download full-game compressed video from temp storage
 *   6. Upload to Gemini Files API, wait for ACTIVE
 *   7. Single VLM call — detect deaths + coach in one pass
 *   8. Parse + store coaching report (status = 'completed')
 *   9. Delete video from temp storage
 *
 * Uses gemini-2.5-flash-lite by default — cheapest model with video support.
 * Death detection + coaching in one call: ~$0.018 per 40-min game.
 * Structured JSON output constrains hallucinations.
 *
 * On any failure:
 *   - Mark report + job as 'failed'
 *   - Refund coaching credit
 */

import type { GameContext } from '@scrima/shared';
import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env.js';
import type { Db } from '../../db/index.js';
import { coachingJobs, coachingReports, matches } from '../../db/schema.js';
import { VlmError } from '../../shared/errors.js';
import type { UsageService } from '../billing/usage.service.js';
import type { TempStorageService } from '../storage/temp-storage.service.js';
import {
  type GeminiModelId,
  GeminiProvider,
  type UploadedFileHandle,
} from '../vlm/gemini.provider.js';
import { PromptBuilder } from '../vlm/prompt.builder.js';
import type { CoachingCreditsService } from './coaching-credits.service.js';

// ── Helpers ────────────────────────────────────��────────────────────────────

/** Parse "ability@MM:SS: description; ..." string into structured array. */
function parseUtilitySummary(
  summary: string | undefined,
): { ability_name: string; approximate_time: string; usage_description: string }[] {
  if (!summary) return [];
  return summary
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const atIdx = entry.indexOf('@');
      const colonIdx = entry.indexOf(':', atIdx > 0 ? atIdx : 0);
      if (atIdx > 0 && colonIdx > atIdx) {
        return {
          ability_name: entry.slice(0, atIdx).trim(),
          approximate_time: entry.slice(atIdx + 1, colonIdx).trim(),
          usage_description: entry.slice(colonIdx + 1).trim(),
        };
      }
      return { ability_name: 'unknown', approximate_time: '', usage_description: entry };
    });
}

// ── Exported types (used by routes + jobs) ────���────────────��────────────────

export interface DeepAnalyzeInput {
  matchId: string;
  userId: string;
  videoKey: string;
  context: GameContext;
  trigger: 'manual' | 'weekly_report';
  bullJobId?: string;
  sparseInterval?: number;
  /** When true, the client already burned HH:MM:SS timestamps into the video — skip server-side processing. */
  timestampsBurned?: boolean;
}

export interface DeepAnalyzeResult {
  reportId: string;
  overallAssessment: string;
  moments: unknown[];
  topIssues: unknown[];
  positiveHighlights: unknown[];
  drills: unknown[];
  vlmCostUsd: number;
  processingTimeMs: number;
}

export interface CoachingPatternEntry {
  category: string;
  count: number;
  recentCount: number;
  trend: 'improving' | 'recurring' | 'new';
}

export interface CoachingHistory {
  sessionNumber: number;
  patterns: CoachingPatternEntry[];
  lastDrill: string | null;
  lastCue: string | null;
  lastChallenge: { title: string; category: string } | null;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class DeepAnalysisService {
  private vlm = new GeminiProvider(env.VLM_MODEL as GeminiModelId);

  constructor(
    private db: Db,
    private storage: TempStorageService,
    private usage: UsageService,
    private credits: CoachingCreditsService,
  ) {}

  async analyzeGame(input: DeepAnalyzeInput): Promise<DeepAnalyzeResult> {
    const start = Date.now();
    const gameMode = input.context.gameMode ?? 'competitive';
    const gameId = input.context.game ?? 'valorant';

    console.log(
      '[Analysis] START — agent=%s, map=%s, mode=%s, match=%s (user-selected agent override)',
      input.context.agent ?? 'unknown',
      input.context.map ?? 'unknown',
      gameMode,
      input.matchId,
    );

    // ── 0. Reject unsupported modes (no credit deducted, no Gemini call) ────
    if (!PromptBuilder.isCoachableMode(gameId, gameMode)) {
      return this.rejectUnsupportedMode(input, gameId, gameMode, start);
    }

    // ── 1. Credit check ─────────────────────────────────────────────────────
    const creditResult = await this.credits.checkAndDecrement(input.userId);
    if (!creditResult.allowed) {
      throw new VlmError(
        'No deep coaching credits remaining. Credits reset on the 1st of each month.',
        'NO_CREDITS',
      );
    }

    // ── 2. Create DB records (processing) ───────────────────────────────────
    const reportId = uuidv4();
    const jobId = uuidv4();

    await this.db.insert(coachingReports).values({
      id: reportId,
      userId: input.userId,
      type: 'game_analysis',
      trigger: input.trigger,
      status: 'processing',
      matchIds: [input.matchId],
    });

    await this.db.insert(coachingJobs).values({
      id: jobId,
      userId: input.userId,
      reportId,
      matchId: input.matchId,
      bullJobId: input.bullJobId ?? null,
      status: 'processing',
      attempts: 1,
    });

    let fileHandle: UploadedFileHandle | null = null;

    try {
      // ── 3. Prepare context + download video ───────────────────────────────
      const enrichedContext = await this.enrichContext(input.matchId, input.userId, input.context);
      const videoBuffer = await this.storage.download(input.videoKey);

      if (videoBuffer.length < 20_000) {
        throw new VlmError(
          'Video is too short for coaching analysis. Please record at least 1 minute of gameplay.',
          'VIDEO_TOO_SHORT',
        );
      }

      // ── 4. Upload video + build coaching history in parallel ──────────────
      const skipProcessing = input.timestampsBurned === true;
      if (skipProcessing) {
        console.log('[Analysis] timestamps already burned by client — skipping server-side ffmpeg');
      }
      const [uploadedFile, coachingHistory] = await Promise.all([
        this.vlm.uploadVideoFile(videoBuffer, undefined, skipProcessing),
        this.buildCoachingHistory(input.userId),
      ]);
      fileHandle = uploadedFile;

      console.log(
        '[Analysis] video uploaded (%sMB), coaching history built (session #%d)',
        (videoBuffer.length / 1024 / 1024).toFixed(1),
        coachingHistory?.sessionNumber ?? 1,
      );

      // ── 5. Death detection pass (flash-lite finds deaths + timestamps) ────
      //    Full coaching happens later in the enrichment step from high-res
      //    client frames. This pass only needs to: validate video, find deaths,
      //    identify agent/map, and note basic context per death.
      const prompt = PromptBuilder.buildDeathDetectionPrompt(
        enrichedContext,
        coachingHistory ?? undefined,
      );
      const reportSchema = PromptBuilder.getDeathDetectionSchema(gameId);

      console.log(
        '[Analysis] death detection → %s (%d char system + %d char user prompt)',
        this.vlm.modelId,
        prompt.systemInstruction.length,
        prompt.userPrompt.length,
      );

      let result = await this.vlm.analyzeFullGameBuffer(
        videoBuffer,
        prompt,
        enrichedContext,
        reportSchema,
        fileHandle,
      );

      console.log(
        '[Analysis] detection complete: cost=$%s, tokens_in=%d, tokens_out=%d, time=%dms',
        result.costUsd.toFixed(4),
        result.tokensUsed.input,
        result.tokensUsed.output,
        Date.now() - start,
      );

      // ── 5b. Guard: Gemini returned empty output → fail + refund ───────────
      if (result.tokensUsed.output === 0) {
        throw new VlmError(
          'Gemini returned empty response (0 output tokens). This is a transient issue — please try again.',
          'EMPTY_VLM_RESPONSE',
        );
      }

      // ── 5c. Retry: flash-lite sometimes misses all deaths — retry once ────
      const detectedDeathsCheck = (result.coachingReport as any).detected_deaths ?? [];
      const isCoachableMode = ['competitive', 'unrated', 'swiftplay', 'premier'].includes(gameMode);
      if (detectedDeathsCheck.length === 0 && isCoachableMode) {
        console.log(
          '[Analysis] 0 deaths in %s mode — retrying once (file already uploaded)',
          gameMode,
        );
        try {
          const retryResult = await this.vlm.analyzeFullGameBuffer(
            videoBuffer,
            prompt,
            enrichedContext,
            reportSchema,
            fileHandle,
          );
          console.log(
            '[Analysis] retry complete: cost=$%s, tokens_out=%d, deaths=%d',
            retryResult.costUsd.toFixed(4),
            retryResult.tokensUsed.output,
            ((retryResult.coachingReport as any).detected_deaths ?? []).length,
          );

          // Use retry result if it found deaths, otherwise keep original
          if (((retryResult.coachingReport as any).detected_deaths ?? []).length > 0) {
            // Accumulate cost from both attempts
            retryResult.costUsd += result.costUsd;
            result = retryResult;
          } else {
            result.costUsd += retryResult.costUsd;
          }
        } catch (retryErr) {
          console.warn(
            '[Analysis] 0-death retry failed, using original result: %s',
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
        }
      }

      const r = result.coachingReport as any;
      const costUsd = result.costUsd;

      // ── 6. Check validation — is this Valorant? ───────────────────────────
      const validation = r.video_validation ?? r.videoValidation;

      if (validation?.is_valorant === false) {
        await this.credits.refund(input.userId).catch(() => {});
        const msg = validation.rejection_reason || 'This does not appear to be Valorant gameplay.';
        return this.completeAsRejection(reportId, jobId, input, msg, costUsd, result, start);
      }

      if (r.rejected) {
        await this.credits.refund(input.userId).catch(() => {});
        const msg = r.rejectionReason ?? 'Not Valorant gameplay';
        return this.completeAsRejection(reportId, jobId, input, msg, costUsd, result, start);
      }

      // ── 7. Convert death detection output to report format ────────────────
      //    Creates minimal deathCoaching entries (timestamps + basic context).
      //    Full coaching text will be provided by the enrichment step.
      // User-selected agent/map from client UI takes priority over VLM detection.
      // VLM often misidentifies newer agents (e.g. Waylay → Clove) past its training cutoff.
      const userAgent = enrichedContext.agent;
      const userMap = enrichedContext.map;
      const detectedAgent =
        userAgent && userAgent !== 'unknown'
          ? userAgent
          : (validation?.detected_agent ?? 'unknown');
      const detectedMap =
        userMap && userMap !== 'unknown' ? userMap : (validation?.detected_map ?? 'unknown');
      const detectedDeaths = r.detected_deaths ?? [];
      const matchOverview = r.match_overview ?? {};

      const deathCoaching = detectedDeaths.map((d: any) => ({
        death_number: d.death_number ?? 0,
        approximate_time: d.approximate_time ?? '',
        situation: d.context_before_death ?? '',
        mistake: '',
        correction: '',
        category: 'unclear',
        avoidable: true,
        weapon_used: d.weapon_observation ?? 'unknown',
        weapon_confidence: 'uncertain' as const,
        killed_by: d.killed_by_observation ?? 'unknown',
        killed_by_confidence: 'uncertain' as const,
        visual_evidence: '',
        coaching_priority: d.coaching_priority ?? 3,
        round_utility_events: parseUtilitySummary(d.round_utility_summary),
      }));

      await this.db
        .update(coachingReports)
        .set({
          status: 'completed',
          report: {
            deathCoaching,
            matchVerdict: matchOverview.overall_playstyle ?? '',
            priorityIssue: null,
            secondaryIssues: [],
            strengths: matchOverview.observed_strengths ?? [],
            sessionFocus: null,
            gameMode: gameMode,
            detectedAgent,
            detectedMap,
            coachingHistory: coachingHistory ?? null,
            coachingContinuity: null,
            enrichmentStatus: 'pending',
            // Legacy fields
            moments: [],
            positiveHighlights: [],
            drills: [],
          },
          topIssues: [],
          overallAssessment: matchOverview.overall_playstyle ?? '',
          // Denormalize VLM detection + resolved values onto dedicated columns.
          // Brain context, compass, weekly report all read these directly —
          // leaving them null forces every reader into a JSONB COALESCE dance.
          vlmDetectedAgent: detectedAgent ?? null,
          vlmDetectedMap: detectedMap ?? null,
          resolvedAgent: detectedAgent ?? null,
          resolvedMap: detectedMap ?? null,
          vlmModel: this.vlm.modelId,
          vlmCostUsd: costUsd,
          tokensInput: result.tokensUsed.input,
          tokensOutput: result.tokensUsed.output,
          processingTimeMs: Date.now() - start,
          completedAt: new Date(),
        })
        .where(eq(coachingReports.id, reportId));

      await this.db
        .update(coachingJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(coachingJobs.id, jobId));

      await this.db
        .update(matches)
        .set({ analysisStatus: 'analyzed' })
        .where(eq(matches.id, input.matchId));

      await this.usage.recordUsage(input.userId, 'game_analysis', costUsd);
      await this.storage.delete(input.videoKey).catch(() => {});

      console.log(
        '[Analysis] saved: %d deaths detected, agent=%s, map=%s, cost=$%s (enrichment pending)',
        deathCoaching.length,
        detectedAgent,
        detectedMap,
        costUsd.toFixed(4),
      );

      return {
        reportId,
        overallAssessment: matchOverview.overall_playstyle ?? '',
        moments: [],
        topIssues: [],
        positiveHighlights: [],
        drills: [],
        vlmCostUsd: costUsd,
        processingTimeMs: Date.now() - start,
      };
    } catch (err) {
      // ── Failure: mark failed + refund credit ──────────────────────────────
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Analysis] FAILED: %s', errorMsg);

      await this.db
        .update(coachingReports)
        .set({ status: 'failed' })
        .where(eq(coachingReports.id, reportId));

      await this.db
        .update(coachingJobs)
        .set({
          status: 'failed',
          errorMsg,
          updatedAt: new Date(),
        })
        .where(eq(coachingJobs.id, jobId));

      await this.credits.refund(input.userId).catch(() => {});
      await this.storage.delete(input.videoKey).catch(() => {});

      throw err;
    } finally {
      if (fileHandle) {
        await this.vlm.deleteVideoFile(fileHandle.fileName).catch(() => {});
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Handle unsupported game mode — no credit charge, no VLM call. */
  private async rejectUnsupportedMode(
    input: DeepAnalyzeInput,
    gameId: string,
    gameMode: string,
    start: number,
  ): Promise<DeepAnalyzeResult> {
    const reportId = uuidv4();
    const jobId = uuidv4();
    const msg = PromptBuilder.getRejectionMessage(gameId, gameMode);

    const rejectionReport = {
      rejected: true,
      rejectionReason: msg,
      gameMode,
      deathCoaching: [],
      matchVerdict: msg,
      priorityIssue: null,
      secondaryIssues: [],
      strengths: [],
      sessionFocus: null,
      moments: [],
      positiveHighlights: [],
      drills: [],
    };

    await this.db.insert(coachingReports).values({
      id: reportId,
      userId: input.userId,
      type: 'game_analysis',
      trigger: input.trigger,
      status: 'completed',
      matchIds: [input.matchId],
      report: rejectionReport,
      overallAssessment: msg,
    });

    await this.db.insert(coachingJobs).values({
      id: jobId,
      userId: input.userId,
      reportId,
      matchId: input.matchId,
      bullJobId: input.bullJobId ?? null,
      status: 'completed',
      attempts: 1,
      completedAt: new Date(),
    });

    await this.storage.delete(input.videoKey).catch(() => {});

    return {
      reportId,
      overallAssessment: msg,
      moments: [],
      topIssues: [],
      positiveHighlights: [],
      drills: [],
      vlmCostUsd: 0,
      processingTimeMs: Date.now() - start,
    };
  }

  /** Complete a report as rejected (video is not Valorant). */
  private async completeAsRejection(
    reportId: string,
    jobId: string,
    input: DeepAnalyzeInput,
    msg: string,
    costUsd: number,
    result: any,
    start: number,
  ): Promise<DeepAnalyzeResult> {
    await this.db
      .update(coachingReports)
      .set({
        status: 'completed',
        report: {
          rejected: true,
          rejectionReason: msg,
          gameMode: 'unknown',
          deathCoaching: [],
          matchVerdict: msg,
          priorityIssue: null,
          secondaryIssues: [],
          strengths: [],
          sessionFocus: null,
          moments: [],
          positiveHighlights: [],
          drills: [],
        },
        overallAssessment: msg,
        vlmModel: this.vlm.modelId,
        vlmCostUsd: costUsd,
        tokensInput: result.tokensUsed.input,
        tokensOutput: result.tokensUsed.output,
        processingTimeMs: Date.now() - start,
        completedAt: new Date(),
      })
      .where(eq(coachingReports.id, reportId));

    await this.db
      .update(coachingJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(coachingJobs.id, jobId));

    await this.storage.delete(input.videoKey).catch(() => {});

    return {
      reportId,
      overallAssessment: msg,
      moments: [],
      topIssues: [],
      positiveHighlights: [],
      drills: [],
      vlmCostUsd: costUsd,
      processingTimeMs: Date.now() - start,
    };
  }

  private async enrichContext(
    _matchId: string,
    _userId: string,
    base: GameContext,
  ): Promise<GameContext> {
    return base;
  }

  // ── Coaching Memory ───────────────────────────────────────────────────────

  private async buildCoachingHistory(userId: string): Promise<CoachingHistory | null> {
    const pastReports = await this.db
      .select({
        report: coachingReports.report,
        createdAt: coachingReports.createdAt,
      })
      .from(coachingReports)
      .where(
        and(
          eq(coachingReports.userId, userId),
          eq(coachingReports.status, 'completed'),
          eq(coachingReports.type, 'game_analysis'),
        ),
      )
      .orderBy(desc(coachingReports.createdAt))
      .limit(10);

    if (pastReports.length === 0) return null;

    const categoryCount: Record<string, number> = {};
    const recentCategoryCount: Record<string, number> = {};

    for (let i = 0; i < pastReports.length; i++) {
      const r = pastReports[i].report as any;
      if (!r || r.rejected) continue;

      const categories = new Set<string>();

      const pri = r.priorityIssue ?? r.priority_pattern;
      if (pri?.category) categories.add(pri.category);

      const secs = r.secondaryIssues ?? r.secondary_patterns ?? [];
      for (const s of secs) {
        if (s?.category) categories.add(s.category);
      }

      for (const cat of categories) {
        categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
        if (i < 3) {
          recentCategoryCount[cat] = (recentCategoryCount[cat] ?? 0) + 1;
        }
      }
    }

    const patterns: CoachingPatternEntry[] = Object.entries(categoryCount)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => {
        const recent = recentCategoryCount[category] ?? 0;
        let trend: 'improving' | 'recurring' | 'new';
        if (count === 2 && recent <= 1) {
          trend = 'new';
        } else if (recent <= 0) {
          trend = 'improving';
        } else {
          trend = 'recurring';
        }
        return { category, count, recentCount: recent, trend };
      });

    const lastReport = pastReports[0].report as any;
    const lastFocus = lastReport?.sessionFocus ?? lastReport?.session_focus ?? null;
    const lastDrill = lastFocus?.drill_name ?? lastFocus?.drillName ?? null;
    const lastCue = lastFocus?.in_game_cue ?? lastFocus?.inGameCue ?? null;

    const lastPriority =
      lastReport?.priorityIssue ??
      lastReport?.priority_issue ??
      lastReport?.priority_pattern ??
      null;
    const lastChallenge = lastPriority?.title
      ? {
          title: lastPriority.title as string,
          category: (lastPriority.category as string) ?? 'unknown',
        }
      : null;

    return {
      sessionNumber: pastReports.length + 1,
      patterns,
      lastDrill,
      lastCue,
      lastChallenge,
    };
  }
}
