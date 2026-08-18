import multipart from '@fastify/multipart';
import { GoogleGenAI } from '@google/genai';
import { GameContextSchema } from '@scrima/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { env } from '../config/env.js';
import { coachingJobs, coachingReports, db, matches, weeklyCoachingReports } from '../db/index.js';
import {
  coachingGraphNodes,
  coachingStrategies,
  playerObservations,
  playerSkillMastery,
} from '../db/schema.js';
import {
  applyVerifiedAgent,
  mergeEnrichedFacts,
  parseValorantReport,
} from '../games/valorant/parser.js';
import { tier3Queue } from '../jobs/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { UsageService } from '../services/billing/usage.service.js';
import { BottleneckCompassService } from '../services/coaching/bottleneck-compass.service.js';
import { BrainContextService } from '../services/coaching/brain-context.service.js';
import { BRAIN_CHAT_MATCH_KEY, ChatQuotaService } from '../services/coaching/chat-quota.service.js';
import { CoachingCreditsService } from '../services/coaching/coaching-credits.service.js';
import { ConsolidationService } from '../services/coaching/consolidation.service.js';
import { CvAnalysisService } from '../services/coaching/cv-analysis.service.js';
import { DeepAnalysisService } from '../services/coaching/deep-analysis.service.js';
import { EraDetectionService } from '../services/coaching/era-detection.service.js';
import { FactVerificationService } from '../services/coaching/fact-verification.service.js';
import {
  FrameAnalysisService,
  frameAnalysisJobs,
} from '../services/coaching/frame-analysis.service.js';
import { GraphService } from '../services/coaching/graph.service.js';
import { detectGameTimeline, extractHsvStats } from '../services/coaching/hsv-detector.js';
import { HypothesisGeneratorService } from '../services/coaching/hypothesis-generator.service.js';
import { ObservationService } from '../services/coaching/observation.service.js';
import { PreSessionBriefingService } from '../services/coaching/pre-session-briefing.service.js';
import { ProactiveCoachService } from '../services/coaching/proactive-coach.service.js';
import { SkillMasteryService } from '../services/coaching/skill-mastery.service.js';
import { StrategyService } from '../services/coaching/strategy.service.js';
import { WeeklyReportService } from '../services/coaching/weekly-report.service.js';
import { TempStorageService } from '../services/storage/temp-storage.service.js';
import { type GeminiModelId, GeminiProvider } from '../services/vlm/gemini.provider.js';

const storage = new TempStorageService();
const usage = new UsageService(db);
const credits = new CoachingCreditsService(db);

/**
 * Resilient brain-chat / greeting LLM call.
 *
 * Tries gemini-2.5-flash-lite first (cheapest). On 503/UNAVAILABLE retries
 * once after a brief backoff, then falls back to gemini-2.5-flash (3× more
 * expensive but typically available when lite is overloaded). On persistent
 * failure, throws — caller surfaces the OVERLOADED code to the client.
 */
async function callBrainModel(
  ai: GoogleGenAI,
  args: {
    contents: any[];
    systemInstruction: string;
    log: { warn: (...a: any[]) => void };
    maxOutputTokens?: number;
    temperature?: number;
  },
): Promise<any> {
  const { contents, systemInstruction, log } = args;
  const baseConfig = {
    systemInstruction,
    temperature: args.temperature ?? 0.7,
    maxOutputTokens: args.maxOutputTokens ?? 1024,
    thinkingConfig: { thinkingBudget: 0 },
  };

  const isOverload = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return /503|UNAVAILABLE|overloaded|currently experiencing high demand/i.test(msg);
  };

  // Attempt 1: flash-lite
  try {
    return await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents,
      config: baseConfig,
    });
  } catch (err) {
    if (!isOverload(err)) throw err;
    log.warn({ stage: 'attempt1', model: 'flash-lite' }, 'brain chat: 503, retrying after backoff');
  }

  // Attempt 2: flash-lite again after 1.5s backoff (most 503s clear quickly)
  await new Promise((r) => setTimeout(r, 1500));
  try {
    return await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents,
      config: baseConfig,
    });
  } catch (err) {
    if (!isOverload(err)) throw err;
    log.warn(
      { stage: 'attempt2', model: 'flash-lite' },
      'brain chat: 503 again, falling back to flash',
    );
  }

  // Attempt 3: full flash (more reliable, ~3× cost)
  return await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
    config: baseConfig,
  });
}

export async function coachingRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } }); // 200 MB (matches Fastify bodyLimit)

  // ══════════════════════════════════════════════════════════════════════════
  //  GAME ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /coaching/deep-analyze
   * Multipart: field "context" (JSON with matchId + trigger) + file "video" (~40 MB compressed)
   * Returns: { jobId, status: 'queued', estimatedTimeMs }
   */
  app.post('/coaching/deep-analyze', { preHandler: [requireAuth] }, async (req, reply) => {
    const parts = req.parts();
    let rawContext: unknown = null;
    let videoKey: string | null = null;

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'context') {
        rawContext = JSON.parse(part.value as string);
      } else if (part.type === 'file' && part.fieldname === 'video') {
        const key = `temp-games/${req.userId}/${uuidv4()}.mp4`;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        req.log.info(
          { sizeMb: (buf.length / 1024 / 1024).toFixed(1) },
          '[deep-analyze] received video',
        );
        await storage.upload(key, buf);
        videoKey = key;
      }
    }

    if (!rawContext || !videoKey) {
      if (videoKey) await storage.delete(videoKey).catch(() => {});
      return reply.code(400).send({ error: 'Missing context or video', code: 'BAD_REQUEST' });
    }

    const parsed = z
      .object({
        matchId: z.string().uuid(),
        trigger: z.enum(['manual', 'weekly_report']).default('manual'),
        sparseInterval: z.number().int().min(1).max(10).optional(),
        timestampsBurned: z.boolean().optional(),
        context: GameContextSchema,
      })
      .parse({
        matchId: (rawContext as any).matchId,
        trigger: (rawContext as any).trigger ?? 'manual',
        sparseInterval: (rawContext as any).sparseInterval,
        timestampsBurned: (rawContext as any).timestampsBurned,
        context: rawContext,
      });

    // Ensure match row exists
    await db
      .insert(matches)
      .values({
        id: parsed.matchId,
        userId: req.userId,
        game: parsed.context.game,
        map: parsed.context.map ?? null,
        agent: parsed.context.agent ?? null,
        rank: parsed.context.rank ?? null,
        playedAt: new Date(),
      })
      .onConflictDoNothing();

    // Credit check (fast fail)
    const balance = await credits.getCredits(req.userId);
    if (balance.remaining <= 0) {
      await storage.delete(videoKey).catch(() => {});
      return reply.code(402).send({
        error: `No coaching credits remaining. Resets ${balance.resetsAt.toISOString().slice(0, 10)}.`,
        code: 'NO_CREDITS',
        remaining: 0,
        resetsAt: balance.resetsAt,
      });
    }

    // Run inline when Redis/BullMQ is not available (dev mode or no REDIS_URL)
    if (!tier3Queue) {
      const fakeJobId = uuidv4();
      reply.code(202).send({
        jobId: fakeJobId,
        reportId: fakeJobId,
        status: 'queued',
        estimatedTimeMs: 360_000,
      });

      const analyzeInput = {
        matchId: parsed.matchId,
        userId: req.userId,
        videoKey,
        trigger: parsed.trigger,
        context: parsed.context,
        bullJobId: fakeJobId,
        sparseInterval: parsed.sparseInterval,
        timestampsBurned: parsed.timestampsBurned,
      };

      // Try CV-powered analysis first (cheaper, no video sent to VLM).
      // Falls back to VLM pipeline if CV detection fails.
      const cvService = new CvAnalysisService(db, storage, usage, credits);
      const deepService = new DeepAnalysisService(db, storage, usage, credits);

      (async () => {
        try {
          const cvResult = await cvService.analyzeGame(analyzeInput);
          if (cvResult) {
            req.log.info(
              { reportId: cvResult.reportId, cost: cvResult.vlmCostUsd },
              'CV analysis done',
            );
            return;
          }
          // CV returned null → fall back to VLM
          req.log.info('CV analysis returned null, falling back to VLM pipeline');
          const vlmResult = await deepService.analyzeGame(analyzeInput);
          req.log.info(
            { reportId: vlmResult.reportId, cost: vlmResult.vlmCostUsd },
            'VLM fallback done',
          );
        } catch (err) {
          req.log.error({ err }, 'Game analysis failed (both CV and VLM)');
        }
      })();

      return reply;
    }

    const job = await tier3Queue.add(
      'deep-coaching',
      {
        matchId: parsed.matchId,
        userId: req.userId,
        videoKey,
        trigger: parsed.trigger,
        context: parsed.context,
        sparseInterval: parsed.sparseInterval,
        timestampsBurned: parsed.timestampsBurned,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 20 },
      },
    );

    return reply.code(202).send({
      jobId: job.id,
      status: 'queued',
      estimatedTimeMs: 360_000,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  FRAME-BASED ANALYSIS (new pipeline — no video upload needed)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /coaching/analyze-frames
   * JSON body with base64 JPEG frames for each death.
   * Client extracts 1080p frames and sends them directly — no video upload,
   * no ffmpeg on server, no ONNX classification.
   */
  const analyzeFramesSchema = z.object({
    matchId: z.string().uuid(),
    gameId: z.string().default('valorant'),
    gameMode: z.string().default('competitive'),
    durationMs: z.number().int().min(0),
    map: z.string().default('unknown'),
    agent: z.string().default('unknown'),
    rank: z.string().default('unknown'),
    evidenceVersion: z.number().int().min(1).max(10).optional(),
    deaths: z
      .array(
        z.object({
          timestampSec: z.number(),
          frames: z
            .array(
              z.object({
                offsetSec: z.number(),
                // 2 MB base64 (~1.5 MB JPEG) — covers high-quality 1080p frames in
                // visually busy scenes (explosions/particles). Raised from 500K after
                // hitting the cap on NVENC-recorded Valorant action frames. Total
                // upload is still bounded by Fastify's 200 MB body limit (set in
                // index.ts), which fits ~20 deaths × 15 frames comfortably.
                base64Jpeg: z.string().max(2_000_000),
              }),
            )
            .max(15),
          // Optional zoomed-in crop of the ability bar at the decision-time frame.
          // Dramatically improves Gemma's LIT/DIMMED ability-slot read. 1 MB cap —
          // a crop is smaller than a full frame.
          abilityBarCropBase64: z.string().max(1_000_000).optional(),
          typedCrops: z
            .object({
              decisionAbilityBar: z.string().max(1_000_000).optional(),
              decisionWeaponHud: z.string().max(1_000_000).optional(),
              contactWeaponHud: z.string().max(1_000_000).optional(),
              decisionMinimap: z.string().max(1_000_000).optional(),
              decisionHpShield: z.string().max(1_000_000).optional(),
              decisionCrosshair: z.string().max(1_000_000).optional(),
              contactCrosshair: z.string().max(1_000_000).optional(),
              deathKillfeed: z.string().max(1_000_000).optional(),
              deathTopHud: z.string().max(1_000_000).optional(),
            })
            .optional(),
          fightPacket: z
            .object({
              version: z.number().int().min(4).max(10).default(4),
              phaseFrames: z
                .array(
                  z.object({
                    offsetSec: z.number(),
                    phase: z.string().max(40),
                    role: z.enum(['pre_outcome', 'outcome']).default('pre_outcome'),
                  }),
                )
                .max(15)
                .default([]),
              focusCropRefs: z
                .array(
                  z.object({
                    kind: z.string().max(60),
                    phase: z.string().max(40),
                    offsetSec: z.number(),
                    typedCropKey: z.string().max(60),
                  }),
                )
                .max(12)
                .default([]),
            })
            .optional(),
          localEvidence: z
            .object({
              candidateTimestampSec: z.number().optional(),
              refinedTimestampSec: z.number().optional(),
              decisionAnchorSec: z.number().optional(),
              detectorFrameIndex: z.number().int().optional(),
              detectorConfidence: z.number().min(0).max(1).optional(),
              onsetConfidence: z.number().min(0).max(1).optional(),
              refinementQuality: z.enum(['high', 'medium', 'low', 'fallback']).optional(),
              lastAliveSec: z.number().nullable().optional(),
              firstDeathSec: z.number().nullable().optional(),
              postDeathDecisionFramesExcluded: z.boolean().optional(),
            })
            .optional(),
          // ONNX classifier confidence for this detected death. When >10 deaths
          // are uploaded we prioritize higher-confidence detections.
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .max(20),
    // Legacy single-frame context. Kept for backwards compatibility with older
    // clients that predate the multi-frame identification vote.
    gameContextFrame: z.string().max(2_000_000).optional(),
    // Multiple context frames (buy-phase, early rounds) for multi-frame
    // consensus vote on agent + map identification.
    gameContextFrames: z.array(z.string().max(2_000_000)).max(5).optional(),
    roundCount: z.number().int().default(0),
    buyPhaseTimestamps: z.array(z.number()).default([]),
    clientVersion: z.string().optional(),
  });

  app.post(
    '/coaching/analyze-frames',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const input = analyzeFramesSchema.parse(req.body);

      req.log.info(
        {
          matchId: input.matchId,
          deaths: input.deaths.length,
          frames: input.deaths.reduce((sum, d) => sum + d.frames.length, 0),
          clientVersion: input.clientVersion,
        },
        '[analyze-frames] request received',
      );

      // Credit check (fast fail)
      const creditResult = await credits.checkAndDecrement(req.userId);
      if (!creditResult.allowed) {
        const balance = await credits.getCredits(req.userId);
        return reply.code(402).send({
          error: `No coaching credits remaining. Resets ${balance.resetsAt.toISOString().slice(0, 10)}.`,
          code: 'NO_CREDITS',
          remaining: 0,
          resetsAt: balance.resetsAt,
        });
      }

      // Start async analysis — returns immediately
      try {
        const service = new FrameAnalysisService();
        const { jobId, reportId } = await service.startAnalysis(input, req.userId);
        return reply.code(202).send({ jobId, reportId, status: 'processing' });
      } catch (err) {
        req.log.error({ err, matchId: input.matchId }, '[analyze-frames] failed to start analysis');
        await credits.refund(req.userId);
        throw err;
      }
    },
  );

  /**
   * GET /coaching/analyze-frames/:jobId/status
   * Poll frame analysis job progress.
   */
  app.get(
    '/coaching/analyze-frames/:jobId/status',
    {
      preHandler: [requireAuth],
    },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const job = frameAnalysisJobs.get(jobId);

      if (!job || job.userId !== req.userId) {
        return reply.code(404).send({ error: 'Job not found' });
      }

      return reply.send({
        status: job.status,
        reportId: job.status === 'completed' ? job.reportId : undefined,
        error: job.status === 'failed' ? job.error : undefined,
        progress: {
          current: job.current,
          total: job.total,
          succeeded: job.succeeded,
          failed: job.failed,
          stage: job.stage,
        },
      });
    },
  );

  /**
   * POST /coaching/debug-hsv
   * Upload a video and get raw HSV detection analysis.
   * For testing/calibrating the HSV detector before integrating into the main pipeline.
   */
  app.post('/coaching/debug-hsv', { preHandler: [requireAuth] }, async (req, reply) => {
    const parts = req.parts();
    let videoBuffer: Buffer | null = null;
    let mode: 'timeline' | 'raw' = 'timeline';

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'video') {
        videoBuffer = await part.toBuffer();
      } else if (part.type === 'field' && part.fieldname === 'mode') {
        mode = (part.value as string) === 'raw' ? 'raw' : 'timeline';
      }
    }

    if (!videoBuffer) {
      return reply.code(400).send({ error: 'Missing video file', code: 'BAD_REQUEST' });
    }

    try {
      if (mode === 'raw') {
        const result = await extractHsvStats(videoBuffer);
        return reply.send({
          numFrames: result.numFrames,
          processingMs: result.processingMs,
          frames: result.frames,
        });
      }
      const timeline = await detectGameTimeline(videoBuffer);
      return reply.send(timeline);
    } catch (err) {
      req.log.error({ err }, 'HSV debug failed');
      return reply.code(500).send({ error: 'HSV detection failed', code: 'HSV_ERROR' });
    }
  });

  /**
   * GET /coaching/jobs/:jobId
   * Poll job status.
   */
  app.get('/coaching/jobs/:jobId', { preHandler: [requireAuth] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };

    const dbJob = await db.query.coachingJobs.findFirst({
      where: and(eq(coachingJobs.bullJobId, jobId), eq(coachingJobs.userId, req.userId)),
    });

    if (dbJob) {
      return reply.send({
        jobId,
        status: dbJob.status,
        reportId: dbJob.reportId ?? null,
        error: dbJob.errorMsg ?? null,
      });
    }

    if (!tier3Queue) {
      return reply.code(404).send({ error: 'Job not found', code: 'NOT_FOUND' });
    }

    const bullJob = await tier3Queue.getJob(jobId);
    if (!bullJob) {
      return reply.code(404).send({ error: 'Job not found', code: 'NOT_FOUND' });
    }

    const state = await bullJob.getState();
    return reply.send({ jobId, status: state, reportId: null, error: null });
  });

  /**
   * GET /coaching/reports/:reportId
   */
  app.get('/coaching/reports/:reportId', { preHandler: [requireAuth] }, async (req, reply) => {
    const { reportId } = req.params as { reportId: string };

    const report = await db.query.coachingReports.findFirst({
      where: and(eq(coachingReports.id, reportId), eq(coachingReports.userId, req.userId)),
    });

    if (!report) {
      return reply.code(404).send({ error: 'Report not found', code: 'NOT_FOUND' });
    }

    if (report.status === 'processing') {
      return reply.code(202).send({ status: 'processing', reportId });
    }

    if (report.status === 'failed') {
      return reply
        .code(500)
        .send({ status: 'failed', error: 'Analysis failed. Credit was refunded.' });
    }

    const r = (report.report as any) ?? {};
    return reply.send({
      id: report.id,
      matchIds: report.matchIds,
      type: report.type,
      trigger: report.trigger,
      overallAssessment: report.overallAssessment,
      gameMode: r.gameMode ?? r.game_mode ?? null,
      rejected: r.rejected ?? false,
      rejectionReason: r.rejectionReason ?? r.rejection_reason ?? null,
      match_verdict: r.matchVerdict ?? r.match_verdict ?? report.overallAssessment ?? '',
      priority_issue: r.priorityIssue ?? r.priority_issue ?? null,
      secondary_issues: r.secondaryIssues ?? r.secondary_issues ?? [],
      strengths: r.strengths ?? [],
      session_focus: r.sessionFocus ?? r.session_focus ?? null,
      death_coaching: r.deathCoaching ?? r.death_coaching ?? [],
      coaching_history: r.coachingHistory ?? r.coaching_history ?? null,
      coaching_continuity: r.coachingContinuity ?? r.coaching_continuity ?? null,
      moments: r.moments ?? [],
      positiveHighlights: r.positiveHighlights ?? [],
      drills: r.drills ?? [],
      enrichmentStatus: r.enrichmentStatus ?? 'none',
      detectedAgent: r.detectedAgent ?? null,
      detectedMap: r.detectedMap ?? null,
      topIssues: report.topIssues ?? [],
      vlmModel: report.vlmModel,
      vlmCostUsd: report.vlmCostUsd,
      processingTimeMs: report.processingTimeMs,
      createdAt: report.createdAt,
      completedAt: report.completedAt,
    });
  });

  /**
   * POST /coaching/reports/:reportId/enrich
   * Accept high-fps frames from client for enhanced enrichment.
   * Runs enrichment on uploaded frames and updates the report in-place.
   */
  app.post(
    '/coaching/reports/:reportId/enrich',
    {
      preHandler: [requireAuth],
    },
    async (req, reply) => {
      const { reportId } = req.params as { reportId: string };

      // Parse frames from JSON body
      let body: { frames: { label: string; base64: string; timestampSec: number }[] };
      try {
        body = z
          .object({
            frames: z
              .array(
                z.object({
                  label: z.string(),
                  base64: z.string(),
                  timestampSec: z.number(),
                }),
              )
              .min(1)
              .max(1000),
          })
          .parse(req.body);
      } catch (zodErr: any) {
        req.log.error(
          {
            zodErr: zodErr.errors ?? zodErr.message,
            reportId,
            frameCount: (req.body as any)?.frames?.length ?? 'no-frames',
          },
          'Enrich Zod validation failed',
        );
        throw zodErr; // re-throw so the global error handler returns 400
      }

      req.log.info({ reportId, frameCount: body.frames.length }, 'Enrich request received');

      // Load report — verify ownership + completion
      const report = await db.query.coachingReports.findFirst({
        where: and(eq(coachingReports.id, reportId), eq(coachingReports.userId, req.userId)),
      });

      if (!report) {
        req.log.warn({ reportId }, 'Enrich: report not found');
        return reply.code(404).send({ error: 'Report not found', code: 'NOT_FOUND' });
      }

      if (report.status !== 'completed') {
        req.log.warn({ reportId, status: report.status }, 'Enrich: report not ready');
        return reply.code(400).send({ error: 'Report not ready', code: 'REPORT_NOT_READY' });
      }

      const r = (report.report as any) ?? {};

      // Idempotency — already-enhanced is a hard short-circuit.
      if (r.enrichmentStatus === 'enhanced') {
        return reply.send({ enriched: false, already: true, deathsUpdated: 0 });
      }

      // Lock TTL: an in-progress claim that's older than 10 minutes is treated
      // as stale (worker crashed mid-update). The atomic UPDATE below re-claims
      // it; a fresh in-progress claim short-circuits like before.
      const ENRICHMENT_LOCK_TTL_MS = 10 * 60 * 1000;
      if (r.enrichmentStatus === 'in_progress') {
        const lockedAt = r.enrichmentLockedAt ? new Date(r.enrichmentLockedAt) : null;
        const stale =
          !lockedAt ||
          Number.isNaN(lockedAt.getTime()) ||
          Date.now() - lockedAt.getTime() > ENRICHMENT_LOCK_TTL_MS;
        if (!stale) {
          return reply.send({ enriched: false, already: true, deathsUpdated: 0 });
        }
        req.log.warn(
          { reportId, lockedAt: lockedAt?.toISOString() ?? null },
          'Recovering stale enrichment lock',
        );
      }

      // Atomic claim: match either the normal `pending` state or a stale
      // `in_progress` lock. Re-checks the timestamp inside the UPDATE so two
      // concurrent recovery attempts can't both win.
      const claimed = await db
        .update(coachingReports)
        .set({
          report: sql`${coachingReports.report} || jsonb_build_object(
          'enrichmentStatus',   'in_progress',
          'enrichmentLockedAt', to_jsonb(NOW()::text)
        )`,
        })
        .where(
          and(
            eq(coachingReports.id, reportId),
            sql`(
          ${coachingReports.report}->>'enrichmentStatus' = 'pending'
          OR (
            ${coachingReports.report}->>'enrichmentStatus' = 'in_progress'
            AND (
              ${coachingReports.report}->>'enrichmentLockedAt' IS NULL
              OR (${coachingReports.report}->>'enrichmentLockedAt')::timestamptz < NOW() - INTERVAL '10 minutes'
            )
          )
        )`,
          ),
        )
        .returning({ id: coachingReports.id });

      if (claimed.length === 0) {
        // Another request already claimed it — idempotency guard
        return reply.send({ enriched: false, already: true, deathsUpdated: 0 });
      }

      // Helper: reset enrichmentStatus to 'pending' (and clear lock) so user can retry.
      const resetClaim = () =>
        db
          .update(coachingReports)
          .set({
            report: sql`${coachingReports.report} || jsonb_build_object(
          'enrichmentStatus',   'pending',
          'enrichmentLockedAt', 'null'::jsonb
        )`,
          })
          .where(eq(coachingReports.id, reportId));

      const deathCoaching = r.deathCoaching ?? r.death_coaching ?? [];
      if (deathCoaching.length === 0) {
        await resetClaim();
        return reply.send({ enriched: false, deathsUpdated: 0, error: 'no_deaths' });
      }

      try {
        // ── Cap deaths + filter frames to reduce VLM cost ─────────────────────
        const MAX_ENRICHMENT_DEATHS = 10;
        // Keep ALL temporal frames — 7s before death captures the full decision-making context.
        const KEEP_OFFSETS = new Set([
          '-7.0',
          '-6.5',
          '-6.0',
          '-5.5',
          '-5.0',
          '-4.5',
          '-4.0',
          '-3.5',
          '-3.0',
          '-2.5',
          '-2.0',
          '-1.5',
          '-1.0',
          '-0.5',
          '+0.0',
          '+0.5',
          '+1.0',
          '+1.5',
        ]);
        const KEEP_CROPS = new Set([
          'crop_center',
          'crop_deathbanner',
          'crop_weapon_hud',
          'crop_ability_bar',
          'crop_killfeed',
          'crop_minimap',
        ]);

        // Sort deaths by coaching_priority (highest first), then take top N.
        // Falls back to original order if coaching_priority is missing (backwards compat).
        const sortedDeaths = [...deathCoaching].sort((a: any, b: any) => {
          const pa = a.coaching_priority ?? 3;
          const pb = b.coaching_priority ?? 3;
          return pb - pa; // highest priority first
        });
        const cappedDeaths = sortedDeaths.slice(0, MAX_ENRICHMENT_DEATHS);
        const cappedDeathNums = new Set(cappedDeaths.map((d: any) => d.death_number ?? 0));

        const clipImages = body.frames
          .map((f) => ({
            label: f.label,
            base64: f.base64,
            mimeType: 'image/jpeg' as const,
            originalTimestampSec: f.timestampSec,
          }))
          .filter((f) => {
            // Keep agent_id frames — Pass 2 has high-res crops and can verify/correct the agent
            if (f.label.startsWith('agent_id')) return true;
            const dm = f.label.match(/^death_(\d+)/);
            if (!dm) return false;
            if (!cappedDeathNums.has(Number.parseInt(dm[1]))) return false;
            const om = f.label.match(/t([+-]\d+\.\d)/);
            if (om && KEEP_OFFSETS.has(om[1])) return true;
            if ([...KEEP_CROPS].some((c) => f.label.includes(c))) return true;
            // Accept utility context frames (death_N_util_K_*)
            if (f.label.includes('_util_')) return true;
            return false;
          });

        req.log.info(
          {
            reportId,
            rawFrames: body.frames.length,
            filteredFrames: clipImages.length,
            deaths: cappedDeaths.length,
          },
          'Enrichment frames filtered',
        );

        const vlm = new GeminiProvider(env.VLM_MODEL as GeminiModelId);
        const verifier = new FactVerificationService(vlm);

        // Extract death timestamps + utility context for full coaching prompt
        const deathTimestamps = cappedDeaths.map((d: any) => ({
          death_number: d.death_number ?? 0,
          approximate_time: d.approximate_time ?? '',
          round_utility_events: Array.isArray(d.round_utility_events) ? d.round_utility_events : [],
        }));

        const gameMode = r.gameMode ?? 'competitive';
        const coachingHistory = r.coachingHistory ?? null;
        const rank = r.rank ?? undefined;

        // Assemble brain context for coaching prompt injection
        let playerMemoryContext = '';
        try {
          const brain = new BrainContextService(db);
          playerMemoryContext = await brain.assembleContext(req.userId);
          if (playerMemoryContext) {
            req.log.info({ reportId }, 'Brain context assembled for coaching');
          }
        } catch {
          /* non-fatal — coaching works without brain context */
        }

        // Try full coaching first (produces entire coaching report from high-res frames)
        const fullResult = await verifier.fullCoach(
          clipImages,
          deathTimestamps,
          gameMode,
          coachingHistory,
          rank,
          r.detectedAgent ?? undefined,
          r.detectedMap ?? undefined,
          playerMemoryContext || undefined,
        );

        if (fullResult && fullResult.deathCoaching.length > 0) {
          // Full coaching succeeded — replace entire coaching content.
          //
          // Agent lock: if the primary analysis already produced a concrete agent
          // (user-selected or VLM-detected), we TRUST IT and reject the Pass 2
          // VLM guess. Pass 2 high-res frames can include spectated teammates
          // after death, which previously led to the VLM "reidentifying" the
          // agent incorrectly on every pass. Only defer to Pass 2 if Pass 1
          // genuinely returned unknown.
          const pass1Agent = r.detectedAgent;
          const pass2Agent = fullResult.playerAgent?.name;
          let verifiedAgent: string;
          if (pass1Agent && pass1Agent !== 'unknown') {
            verifiedAgent = pass1Agent;
            if (pass2Agent && pass2Agent !== pass1Agent) {
              req.log.warn(
                { reportId, pass1Agent, pass2Agent },
                'Pass 2 VLM disagreed with locked agent — rejecting VLM guess',
              );
            }
          } else {
            verifiedAgent = pass2Agent ?? 'unknown';
          }
          const verifiedMap = fullResult.verifiedMap ?? r.detectedMap ?? 'unknown';

          // Parse through the Valorant parser for consistent field mapping
          const parsed = parseValorantReport({
            death_coaching: fullResult.deathCoaching,
            priority_pattern: fullResult.priorityPattern,
            secondary_patterns: fullResult.secondaryPatterns,
            strengths: fullResult.strengths,
            session_focus: fullResult.sessionFocus,
            match_verdict: fullResult.matchVerdict,
            coaching_continuity: fullResult.coachingContinuity,
          });

          const updatedReport = {
            ...r,
            deathCoaching: parsed.deathCoaching,
            matchVerdict: parsed.matchVerdict ?? fullResult.matchVerdict,
            priorityIssue: parsed.priorityIssue,
            secondaryIssues: parsed.secondaryIssues,
            strengths: parsed.strengths,
            sessionFocus: parsed.sessionFocus,
            coachingContinuity: parsed.coachingContinuity,
            detectedAgent: verifiedAgent,
            detectedMap: verifiedMap,
            enrichmentStatus: 'enhanced',
          };

          const existingCost = report.vlmCostUsd ?? 0;
          await db
            .update(coachingReports)
            .set({
              report: updatedReport,
              overallAssessment: fullResult.matchVerdict || (report.overallAssessment ?? ''),
              topIssues: parsed.topIssues ?? [],
              vlmCostUsd: existingCost + fullResult.costUsd,
            })
            .where(eq(coachingReports.id, reportId));

          req.log.info(
            {
              reportId,
              deaths: fullResult.deathCoaching.length,
              cost: fullResult.costUsd,
              mode: 'full_coaching',
            },
            'Full coaching enrichment applied',
          );

          // Update all brain layers from enriched report (non-blocking, non-fatal)
          try {
            const brain = new BrainContextService(db);
            const brainResult = await brain.updateFromReport(
              req.userId,
              reportId,
              updatedReport,
              verifiedAgent,
              verifiedMap,
            );
            req.log.info(
              {
                reportId,
                observations: brainResult.observations,
                skills: brainResult.skills,
                graphNodes: brainResult.graphNodes,
                graphEdges: brainResult.graphEdges,
                strategies: brainResult.strategies,
                reflected: brainResult.consolidated,
              },
              'Brain updated from enrichment',
            );
          } catch (brainErr) {
            req.log.warn({ brainErr, reportId }, 'Brain update failed (non-fatal)');
          }

          return reply.send({
            enriched: true,
            deathsUpdated: fullResult.deathCoaching.length,
            costUsd: fullResult.costUsd,
          });
        }

        // Fallback: full coaching failed — try legacy fact-fixing mode
        req.log.warn({ reportId }, 'Full coaching failed, falling back to fact-fixing');
        const verified = await verifier.verifyWithClipImages(
          clipImages,
          cappedDeaths,
          r.detectedAgent ?? undefined,
          r.detectedMap ?? undefined,
        );

        if (!verified) {
          await resetClaim();
          return reply.send({ enriched: false, deathsUpdated: 0, error: 'enrichment_failed' });
        }

        const enrichedCoaching = mergeEnrichedFacts(cappedDeaths, verified.deaths);
        const verifiedAgent = applyVerifiedAgent(r, verified.playerAgent);

        const updatedReport = {
          ...r,
          deathCoaching: enrichedCoaching,
          enrichmentStatus: 'enhanced',
          detectedAgent:
            verifiedAgent !== 'unknown' ? verifiedAgent : (r.detectedAgent ?? 'unknown'),
        };

        const existingCost = report.vlmCostUsd ?? 0;
        await db
          .update(coachingReports)
          .set({
            report: updatedReport,
            vlmCostUsd: existingCost + verified.costUsd,
          })
          .where(eq(coachingReports.id, reportId));

        req.log.info(
          { reportId, deaths: verified.deaths.length, cost: verified.costUsd, mode: 'fact_fix' },
          'Fallback enrichment applied',
        );

        return reply.send({
          enriched: true,
          deathsUpdated: verified.deaths.length,
          costUsd: verified.costUsd,
        });
      } catch (err: any) {
        req.log.error({ err, reportId }, 'Enrichment failed');
        await resetClaim().catch(() => {});
        return reply.send({ enriched: false, deathsUpdated: 0, error: 'enrichment_error' });
      }
    },
  );

  /**
   * GET /coaching/reports
   */
  app.get('/coaching/reports', { preHandler: [requireAuth] }, async (req, reply) => {
    const query = req.query as { limit?: string; type?: string };
    const limit = Math.min(
      Math.max(Number.parseInt((query.limit as string) ?? '20', 10) || 20, 1),
      50,
    );

    const reports = await db
      .select({
        id: coachingReports.id,
        matchIds: coachingReports.matchIds,
        type: coachingReports.type,
        trigger: coachingReports.trigger,
        status: coachingReports.status,
        overallAssessment: coachingReports.overallAssessment,
        vlmCostUsd: coachingReports.vlmCostUsd,
        createdAt: coachingReports.createdAt,
        completedAt: coachingReports.completedAt,
      })
      .from(coachingReports)
      .where(
        and(
          eq(coachingReports.userId, req.userId),
          ...(query.type ? [eq(coachingReports.type, query.type)] : []),
        ),
      )
      .orderBy(desc(coachingReports.createdAt))
      .limit(limit);

    return reply.send({ reports });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CREDITS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/credits', { preHandler: [requireAuth] }, async (req, reply) => {
    const balance = await credits.getCredits(req.userId);
    return reply.send(balance);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  WEEKLY REPORTS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/weekly-reports/latest', { preHandler: [requireAuth] }, async (req, reply) => {
    const report = await db.query.weeklyCoachingReports.findFirst({
      where: eq(weeklyCoachingReports.userId, req.userId),
      orderBy: [desc(weeklyCoachingReports.createdAt)],
    });

    if (!report) return reply.code(404).send({ error: 'No weekly report yet', code: 'NOT_FOUND' });
    return reply.send(report);
  });

  app.get('/coaching/weekly-reports', { preHandler: [requireAuth] }, async (req, reply) => {
    const reports = await db
      .select()
      .from(weeklyCoachingReports)
      .where(eq(weeklyCoachingReports.userId, req.userId))
      .orderBy(desc(weeklyCoachingReports.createdAt))
      .limit(12);

    return reply.send({ reports });
  });

  app.post(
    '/coaching/weekly-report/request-uploads',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const weeklyService = new WeeklyReportService(db, credits);
      await weeklyService.generateForUser(req.userId);

      const latest = await db.query.weeklyCoachingReports.findFirst({
        where: eq(weeklyCoachingReports.userId, req.userId),
        orderBy: [desc(weeklyCoachingReports.createdAt)],
      });

      if (!latest || latest.status !== 'awaiting_uploads') {
        return reply.send({ message: 'No uploads needed' });
      }

      return reply.send({
        weekStart: latest.weekStart,
        weekEnd: latest.weekEnd,
        selectedMatchIds: latest.selectedMatchIds,
        message: `Please upload ${latest.selectedMatchIds.length} game recording(s) via POST /coaching/deep-analyze`,
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Q&A CHAT
  // ══════════════════════════════════════════════════════════════════════════

  const chatQuotaSvc = new ChatQuotaService(db);

  /**
   * Detect a Gemini safety block (or empty response) and return a soft-block
   * payload suitable for a 200 OK that the client renders as a coach deflection.
   *
   * Returns null if the response looks like a real answer.
   */
  function detectSoftBlock(
    response: any,
    answer: string,
  ): { answer: string; softBlock: true; tokensUsed: 0; reason: string } | null {
    const finishReason: string | undefined = response?.candidates?.[0]?.finishReason;
    const promptBlockReason: string | undefined = response?.promptFeedback?.blockReason;
    const blocked =
      finishReason === 'SAFETY' ||
      finishReason === 'RECITATION' ||
      finishReason === 'PROHIBITED_CONTENT' ||
      finishReason === 'SPII' ||
      promptBlockReason != null;

    if (blocked || answer.trim().length === 0) {
      return {
        answer:
          "I can't help with that phrasing. Try asking about a specific round, death, positioning moment, or drill you want to improve.",
        softBlock: true,
        tokensUsed: 0,
        reason: promptBlockReason ?? finishReason ?? 'EMPTY',
      };
    }
    return null;
  }

  /**
   * POST /coaching/chat
   * Ask a follow-up question about a coaching report.
   * Uses gemini-2.5-flash-lite for cost efficiency (~$0.0005/question).
   */
  app.post('/coaching/chat', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z
      .object({
        reportId: z.string(),
        question: z.string().min(1).max(2000),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            }),
          )
          .max(20)
          .default([]),
      })
      .parse(req.body);

    // Load report — verify ownership
    // Try direct lookup first, then fallback via coachingJobs.bullJobId
    // (client may send the bullJobId instead of the actual report ID)
    let report = await db.query.coachingReports.findFirst({
      where: and(eq(coachingReports.id, body.reportId), eq(coachingReports.userId, req.userId)),
    });

    if (!report) {
      // Fallback: the client might be sending bullJobId — look up via coachingJobs
      const job = await db.query.coachingJobs.findFirst({
        where: and(eq(coachingJobs.bullJobId, body.reportId), eq(coachingJobs.userId, req.userId)),
      });
      if (job?.reportId) {
        report = await db.query.coachingReports.findFirst({
          where: and(eq(coachingReports.id, job.reportId), eq(coachingReports.userId, req.userId)),
        });
      }
    }

    if (!report) {
      return reply.code(404).send({ error: 'Report not found', code: 'NOT_FOUND' });
    }

    if (report.status !== 'completed') {
      return reply.code(400).send({ error: 'Report not ready', code: 'REPORT_NOT_READY' });
    }

    // Authoritative quota check — client counter is advisory only.
    // Use the first match id if present (game_analysis reports always have exactly one);
    // fall back to the report id so the unique key in chat_quota_usage is stable.
    const quotaKey = report.matchIds?.[0] ?? report.id;
    const quotaStatus = await chatQuotaSvc.status(req.userId, quotaKey);
    if (quotaStatus.reached) {
      return reply.code(429).send({
        error: "You've used all of today's questions for this match. Come back tomorrow.",
        code: 'QUOTA_REACHED',
        limit: quotaStatus.limit,
        remaining: 0,
        resetsAt: `${quotaStatus.dayStart}T24:00:00Z`,
      });
    }

    const r = (report.report as any) ?? {};

    // Build report context — structured so the LLM can reference specifics
    const verdict = r.matchVerdict ?? r.match_verdict ?? report.overallAssessment ?? '';
    const priorityIssue = r.priorityIssue ?? r.priority_issue ?? null;
    const secondaryIssues = r.secondaryIssues ?? r.secondary_issues ?? [];
    const strengths = r.strengths ?? [];
    const sessionFocus = r.sessionFocus ?? r.session_focus ?? null;
    const deathCoaching = r.deathCoaching ?? r.death_coaching ?? [];
    const moments = r.moments ?? [];
    const positiveHighlights = r.positiveHighlights ?? [];
    const drills = r.drills ?? [];

    const contextParts: string[] = [];
    contextParts.push(`Match verdict: ${verdict}`);
    if (priorityIssue)
      contextParts.push(
        `Priority issue: ${typeof priorityIssue === 'string' ? priorityIssue : JSON.stringify(priorityIssue)}`,
      );
    if (secondaryIssues.length)
      contextParts.push(`Secondary issues: ${JSON.stringify(secondaryIssues)}`);
    if (strengths.length) contextParts.push(`Strengths: ${JSON.stringify(strengths)}`);
    if (sessionFocus)
      contextParts.push(
        `Recommended drill: ${typeof sessionFocus === 'string' ? sessionFocus : JSON.stringify(sessionFocus)}`,
      );
    if (deathCoaching.length)
      contextParts.push(
        `Death coaching (${deathCoaching.length} events): ${JSON.stringify(deathCoaching)}`,
      );
    if (moments.length)
      contextParts.push(`Key moments (${moments.length}): ${JSON.stringify(moments)}`);
    if (positiveHighlights.length)
      contextParts.push(`Positive highlights: ${JSON.stringify(positiveHighlights)}`);
    if (drills.length) contextParts.push(`Drills: ${JSON.stringify(drills)}`);

    const systemPrompt = `You are a top-tier esports coach doing a 1-on-1 VOD review session with a player. The player has already read the analysis report — they can see it on screen. Your job is NOT to repeat the report. Instead, go deeper.

RULES:
- NEVER summarize or restate the report. The player already read it.
- When they ask about something from the report, explain the UNDERLYING GAME CONCEPT — the "why behind the why."
- Give SPECIFIC, PRACTICAL advice: exact positions, timing windows, keybind habits, crosshair placement spots, angle sequences.
- Reference pro player examples or common high-elo patterns when relevant.
- If they ask about a death or mistake, diagnose the root decision error — not just "you were out of position" but exactly what info they had, what they should have read from it, and what the correct play was.
- Suggest concrete practice routines: custom game drills with specific settings, workshop maps, aim trainer scenarios, or replay review exercises.
- Be direct and conversational. No fluff, no "great question!" filler.
- Use markdown: **bold** for key terms, bullet lists for steps, \`code\` for keybinds or settings.
- Keep responses focused — 150-250 words unless the question needs more depth.

ANALYSIS REPORT (for your reference — do NOT repeat this back):
${contextParts.join('\n')}`;

    // Build conversation history for multi-turn
    const contents = [
      ...body.history.map((msg) => ({
        role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: msg.content }],
      })),
      { role: 'user' as const, parts: [{ text: body.question }] },
    ];

    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const answer =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      const softBlock = detectSoftBlock(response, answer);
      if (softBlock) {
        req.log.warn(
          { userId: req.userId, matchId: quotaKey, reason: softBlock.reason },
          'coaching chat soft-blocked',
        );
        return reply.send(softBlock);
      }

      const usageMeta = response.usageMetadata;
      const tokensUsed =
        (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.candidatesTokenCount ?? 0);

      const after = await chatQuotaSvc.record(req.userId, quotaKey);

      return reply.send({
        answer,
        tokensUsed,
        quota: { limit: after.limit, remaining: after.remaining },
      });
    } catch (err: any) {
      req.log.error({ err }, 'Coaching chat failed');
      return reply.code(500).send({
        error: 'Something went wrong generating that reply. Try again.',
        code: 'LLM_ERROR',
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  PLAYER OBSERVATIONS ("Your Coach" page data)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/observations', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const observationSvc = new ObservationService(db);
      const observations = await observationSvc.listForPlayer(req.userId);
      return reply.send(observations);
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch observations');
      return reply.send({ habits: [], strengths: [], insights: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  PRE-SESSION BRIEFING (Phase 4 — Dashboard Coach Briefing)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /coaching/pre-session-briefing
   * Assembles the "Before you play" card content from existing brain data.
   */
  app.get('/coaching/pre-session-briefing', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const service = new PreSessionBriefingService(db);
      const briefing = await service.assemble(req.userId);
      return reply.send(briefing);
    } catch (err: any) {
      req.log.error({ err }, 'Failed to assemble pre-session briefing');
      // Return a safe empty briefing rather than 500 — Dashboard must not break
      return reply.send({
        sessionNumber: 1,
        practice: null,
        lookFor: null,
        avoid: null,
        focusOptions: ['Crosshair head height', 'Utility before eyes', 'Hold angles, patience'],
        currentCommitment: null,
      });
    }
  });

  /**
   * POST /coaching/focus-commitment
   * Player commits to ONE focus for the session. Stored as a graph node of
   * type 'focus_commitment'. The latest commitment (within 24h) is injected
   * into the next report's VLM prompt.
   */
  app.post('/coaching/focus-commitment', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z
      .object({
        focus: z.string().min(1).max(120),
      })
      .parse(req.body);

    try {
      const [node] = await db
        .insert(coachingGraphNodes)
        .values({
          userId: req.userId,
          nodeType: 'focus_commitment',
          label: body.focus,
          data: { committedAt: new Date().toISOString() },
          importance: 0.8,
        })
        .returning({
          id: coachingGraphNodes.id,
          label: coachingGraphNodes.label,
          createdAt: coachingGraphNodes.createdAt,
        });

      return reply.send({
        success: true,
        commitment: {
          focus: node.label,
          committedAt: node.createdAt.toISOString(),
        },
      });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to commit focus');
      return reply.code(500).send({ error: 'Failed to commit focus' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  COACH MESSAGES (Phase 7D — Proactive coach)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/messages', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const svc = new ProactiveCoachService(db);
      const messages = await svc.listUnread(req.userId);
      return reply.send({ messages });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to list coach messages');
      return reply.send({ messages: [] });
    }
  });

  app.post(
    '/coaching/messages/:id/mark-read',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const svc = new ProactiveCoachService(db);
        const ok = await svc.markRead(req.userId, id);
        if (!ok) return reply.code(404).send({ error: 'Message not found' });
        return reply.send({ success: true });
      } catch (err: any) {
        req.log.error({ err }, 'Failed to mark message read');
        return reply.code(500).send({ error: 'Failed to mark message read' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  HYPOTHESES (Phase 7B — Living Mind belief tiers)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /coaching/hypotheses
   * Returns the player's pending hypotheses — tentative beliefs the coach is
   * "still figuring out" and inviting confirmation on.
   */
  app.get('/coaching/hypotheses', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const svc = new HypothesisGeneratorService(db);
      const items = await svc.listPending(req.userId);
      return reply.send({ hypotheses: items });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch hypotheses');
      return reply.send({ hypotheses: [] });
    }
  });

  /**
   * POST /coaching/hypotheses/:id/confirm
   * Player agrees — hypothesis promoted to a confirmed belief.
   */
  app.post(
    '/coaching/hypotheses/:id/confirm',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const svc = new HypothesisGeneratorService(db);
        const result = await svc.confirm(req.userId, id);
        if (!result) return reply.code(404).send({ error: 'Hypothesis not found' });
        return reply.send({ success: true, hypothesis: result });
      } catch (err: any) {
        req.log.error({ err }, 'Failed to confirm hypothesis');
        return reply.code(500).send({ error: 'Failed to confirm hypothesis' });
      }
    },
  );

  /**
   * POST /coaching/hypotheses/:id/reject
   * Player disagrees — hypothesis marked rejected, deprioritized.
   */
  app.post('/coaching/hypotheses/:id/reject', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const svc = new HypothesisGeneratorService(db);
      const result = await svc.reject(req.userId, id);
      if (!result) return reply.code(404).send({ error: 'Hypothesis not found' });
      return reply.send({ success: true, hypothesis: result });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to reject hypothesis');
      return reply.code(500).send({ error: 'Failed to reject hypothesis' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ERAS (Phase 5 — Living Mind chapter-based growth timeline)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /coaching/eras
   * Returns all of the player's eras, newest first. Eras are graph nodes
   * written by EraDetectionService during post-enrichment brain updates.
   */
  app.get('/coaching/eras', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const service = new EraDetectionService(db);
      const eras = await service.listForUser(req.userId);
      return reply.send({ eras });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch eras');
      return reply.send({ eras: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  BOTTLENECK COMPASS (Phase 3 — highest-leverage skill via BKT + prerequisites)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /coaching/compass?priorityCategory=utility
   * Returns the player's current bottleneck skill — the one whose improvement
   * unblocks the most downstream skills. Optional `priorityCategory` query
   * param lets the UI render an alignment badge vs the current report's issue.
   */
  app.get('/coaching/compass', { preHandler: [requireAuth] }, async (req, reply) => {
    const { priorityCategory } = req.query as { priorityCategory?: string };
    try {
      const service = new BottleneckCompassService(db);
      const result = await service.compute(req.userId, priorityCategory);
      return reply.send(result);
    } catch (err: any) {
      req.log.error({ err }, 'Bottleneck compass compute failed');
      return reply.code(500).send({ error: 'Failed to compute compass' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  COACHING BRAIN (full brain state for interactive coach UI)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/brain', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      const skillSvc = new SkillMasteryService(db);
      const graphSvc = new GraphService(db);
      const consolidation = new ConsolidationService(db);
      const strategySvc = new StrategyService(db);
      const observationSvc = new ObservationService(db);

      const [mastery, graph, strategies, observations] = await Promise.all([
        skillSvc.getMasteryProfile(req.userId),
        graphSvc.getGraphSummary(req.userId),
        strategySvc.getEffectiveStrategies(req.userId),
        observationSvc.listForPlayer(req.userId),
      ]);

      // Get reflections separately (lightweight query)
      const _reflections = await consolidation.formatReflectionsForPrompt(req.userId);

      // Parse reflections into structured data
      const reflectionList: { title: string; insight: string }[] = [];
      try {
        const reflectionNodes = await db
          .select({ label: coachingGraphNodes.label, data: coachingGraphNodes.data })
          .from(coachingGraphNodes)
          .where(
            and(
              eq(coachingGraphNodes.userId, req.userId),
              eq(coachingGraphNodes.nodeType, 'reflection'),
            ),
          )
          .orderBy(desc(coachingGraphNodes.importance))
          .limit(5);
        for (const r of reflectionNodes) {
          reflectionList.push({
            title: r.label,
            insight: (r.data as any)?.insight ?? '',
          });
        }
      } catch {
        /* non-fatal */
      }

      return reply.send({
        mastery,
        graph,
        strategies,
        observations,
        reflections: reflectionList,
      });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to fetch brain data');
      return reply.send({
        mastery: { skills: [], weakest: [], strongest: [] },
        graph: { totalNodes: 0, totalEdges: 0, patterns: [], recentGames: [] },
        strategies: { effective: [], ineffective: [] },
        observations: { habits: [], strengths: [], insights: [] },
        reflections: [],
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  BRAIN-AWARE COACH CHAT (uses full brain context, not single report)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /coaching/brain-chat
   * Chat with the coach using full brain context (all 5 layers).
   * Unlike /coaching/chat which uses a single report, this knows the player's
   * entire history, habits, mastery profile, patterns, and strategies.
   */
  app.post('/coaching/brain-chat', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = z
      .object({
        question: z.string().min(1).max(2000),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            }),
          )
          .max(20)
          .default([]),
      })
      .parse(req.body);

    // Authoritative quota check — brain chat bucket is keyed by the empty
    // string so it's independent of per-match Q&A counters.
    const quotaStatus = await chatQuotaSvc.status(req.userId, BRAIN_CHAT_MATCH_KEY);
    if (quotaStatus.reached) {
      return reply.code(429).send({
        error: "You've used all of today's coach questions. Come back tomorrow.",
        code: 'QUOTA_REACHED',
        limit: quotaStatus.limit,
        remaining: 0,
        resetsAt: `${quotaStatus.dayStart}T24:00:00Z`,
      });
    }

    try {
      const brainSvc = new BrainContextService(db);
      // Hybrid retrieval: pass the user's question so observations are scored
      // by semantic relevance to the topic, not just frequency.
      const brainContext = await brainSvc.assembleContext(req.userId, { queryText: body.question });

      // Cache-friendly layout: static role + rules first (Gemini's implicit
      // cache hits the stable prefix), dynamic per-user knowledge last.
      const systemPrompt = `You are Scrima Coach — a personal AI gaming coach who knows this player deeply through their gameplay history. You have analyzed their games, tracked their skill development, observed recurring patterns, and understand what coaching approaches work best for them.

RULES:
- Be direct, warm, and conversational — like a friend who's also a pro coach.
- Reference SPECIFIC observations, patterns, and skills from the player data below.
- Give CONCRETE, ACTIONABLE advice — exact positions, timing windows, drills with settings.
- Track improvement: acknowledge progress when data shows skill improving.
- Call out persistent issues directly but constructively.
- Use markdown: **bold** for key terms, bullet lists for steps.
- Keep responses focused — 150-300 words unless the question demands more.
- Never be generic or motivational-poster-ish. Every response should feel personalized.
- If the player asks about something you have no data on, say so honestly.
- ABILITY NAMES: Use ONLY the ability names that appear verbatim in the AGENT KIT block below. Do NOT invent or borrow ability names from other agents. If the kit isn't shown for the agent in question, refer to abilities by slot ("their C ability", "their ult") rather than guessing a name.
- PLAIN ENGLISH: never use internal jargon like "LIT" — say "ready" or "available". The player has no idea what LIT means.
- The player's PAST OBSERVATIONS may mention abilities from other agents they've played. Treat those as historical signal only — coach for the CURRENT agent (whoever is in the AGENT KIT block) and never echo other agents' ability names back.
- READ THE "PLAYER DATA ON {agent}" LINE AT THE TOP OF THE AGENT KIT BLOCK BEFORE COACHING. If it says "NONE" you must not claim any specific observations about how they play that agent — say plainly "I don't have any data on your {agent} games yet, so here's general guidance on the kit:" and then give kit-level pointers. Never write phrases like "you often", "we've seen you", "you tend to" when player data is absent. If it says "N games but 0 observations" you can mention they've played but say specific habit data hasn't been extracted yet.

YOUR KNOWLEDGE ABOUT THIS PLAYER:
${brainContext || 'No coaching data yet — this is a new player. Be welcoming and explain what you can do.'}`;

      const contents = [
        ...body.history.map((msg) => ({
          role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: [{ text: msg.content }],
        })),
        { role: 'user' as const, parts: [{ text: body.question }] },
      ];

      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' });

      // Resilient call: try flash-lite, retry once after 503, then fall back
      // to flash (3× more expensive but typically available when lite is
      // overloaded). On persistent failure, surface an explicit
      // OVERLOADED code so the client can show the right message.
      const response = await callBrainModel(ai, {
        contents,
        systemInstruction: systemPrompt,
        log: req.log,
      });

      const answer =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      const softBlock = detectSoftBlock(response, answer);
      if (softBlock) {
        req.log.warn({ userId: req.userId, reason: softBlock.reason }, 'brain chat soft-blocked');
        return reply.send(softBlock);
      }

      const usageMeta = response.usageMetadata;
      const tokensUsed =
        (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.candidatesTokenCount ?? 0);

      const after = await chatQuotaSvc.record(req.userId, BRAIN_CHAT_MATCH_KEY);

      return reply.send({
        answer,
        tokensUsed,
        quota: { limit: after.limit, remaining: after.remaining },
      });
    } catch (err: any) {
      // Distinguish upstream overload from genuine bugs so the client UI
      // can show a "try again in a moment" message instead of the generic
      // failure toast.
      const msg = err instanceof Error ? err.message : String(err);
      const isOverload = /503|UNAVAILABLE|overloaded|currently experiencing high demand/i.test(msg);
      if (isOverload) {
        req.log.warn({ err: msg }, 'Brain chat upstream overloaded');
        return reply.code(503).send({
          error: 'AI service is busy right now. Wait a moment and ask again.',
          code: 'LLM_OVERLOADED',
        });
      }
      req.log.error({ err }, 'Brain chat failed');
      return reply.code(500).send({
        error: 'Something went wrong generating that reply. Try again.',
        code: 'LLM_ERROR',
      });
    }
  });

  /**
   * GET /coaching/brain-chat/greeting
   * Generate a personalized greeting using the player's brain context.
   * Cached for 10 minutes per user to avoid repeated LLM calls.
   */
  const greetingCache = new Map<string, { text: string; expiresAt: number }>();

  app.get('/coaching/brain-chat/greeting', { preHandler: [requireAuth] }, async (req, reply) => {
    // Check cache
    const cached = greetingCache.get(req.userId);
    if (cached && cached.expiresAt > Date.now()) {
      return reply.send({ greeting: cached.text });
    }

    try {
      const brainSvc = new BrainContextService(db);
      const brainContext = await brainSvc.assembleContext(req.userId);

      if (!brainContext) {
        const greeting =
          "Welcome to Scrima. Play a game and I'll start learning how you play. Once I've analyzed a few matches, I'll know your habits, strengths, and what to work on.";
        greetingCache.set(req.userId, { text: greeting, expiresAt: Date.now() + 600_000 });
        if (greetingCache.size > 1000) {
          const firstKey = greetingCache.keys().next().value;
          if (firstKey) greetingCache.delete(firstKey);
        }
        return reply.send({ greeting });
      }

      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: 'Generate greeting' }] }],
        config: {
          systemInstruction: `You are Scrima Coach. Generate a 2-3 sentence personalized greeting for this player based on their coaching data. Reference something specific — a recent improvement, a persistent habit, or a skill trend. Be warm but direct. No generic motivational fluff. No "hey there" or "welcome back" — start with something they'll recognize from their gameplay.

PLAYER DATA:
${brainContext}`,
          temperature: 0.8,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const greeting =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        'Hey — ready to review your gameplay? Ask me anything about your skills, habits, or what to work on next.';

      greetingCache.set(req.userId, { text: greeting, expiresAt: Date.now() + 600_000 });
      if (greetingCache.size > 1000) {
        const firstKey = greetingCache.keys().next().value;
        if (firstKey) greetingCache.delete(firstKey);
      }
      return reply.send({ greeting });
    } catch (err: any) {
      req.log.error({ err }, 'Brain greeting failed');
      return reply.send({
        greeting:
          'Hey — ready to review your gameplay? Ask me anything about your skills, habits, or what to work on next.',
      });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  BRAIN DATA MANAGEMENT (player controls their data)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /coaching/observations/:id/dismiss
   * Archive a single observation so it no longer influences coaching.
   */
  app.post(
    '/coaching/observations/:id/dismiss',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      try {
        // Bi-temporal retire: sets valid_until = now() so the observation
        // stays queryable for historical lookups but drops out of active reads.
        // The legacy `archived` flag is also flipped for backwards compat.
        const observationSvc = new ObservationService(db);
        const ok = await observationSvc.supersede(id, req.userId);
        if (!ok) {
          return reply.code(404).send({ error: 'Observation not found' });
        }

        return reply.send({ success: true });
      } catch (err: any) {
        req.log.error({ err }, 'Failed to dismiss observation');
        return reply.code(500).send({ error: 'Failed to dismiss observation' });
      }
    },
  );

  /**
   * POST /coaching/observations/:id/agree
   * Player confirms the observation is accurate. Sets confidence=1.0.
   * The observation weighs heavily in future coaching prompts.
   */
  app.post(
    '/coaching/observations/:id/agree',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        // Agreeing on a previously-dismissed observation must un-retire it,
        // otherwise the row sits at confidence=1.0 AND validUntil=now, which is
        // a contradiction (the read path filters validUntil IS NULL, so the
        // belief would be high-confidence yet invisible).
        const result = await db
          .update(playerObservations)
          .set({
            confidence: 1.0,
            confirmedAt: new Date(),
            disagreedAt: null,
            archived: false,
            validUntil: null,
            supersededBy: null,
          })
          .where(and(eq(playerObservations.id, id), eq(playerObservations.userId, req.userId)))
          .returning({ id: playerObservations.id });

        if (result.length === 0) {
          return reply.code(404).send({ error: 'Observation not found' });
        }
        return reply.send({ success: true });
      } catch (err: any) {
        req.log.error({ err }, 'Failed to agree with observation');
        return reply.code(500).send({ error: 'Failed to record agreement' });
      }
    },
  );

  /**
   * POST /coaching/observations/:id/disagree
   * Player rejects the observation. Sets confidence=0.0.
   * The observation is filtered out of future coaching prompts (confidence < 0.3 excluded).
   */
  app.post(
    '/coaching/observations/:id/disagree',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const result = await db
          .update(playerObservations)
          .set({ confidence: 0.0, disagreedAt: new Date(), confirmedAt: null })
          .where(and(eq(playerObservations.id, id), eq(playerObservations.userId, req.userId)))
          .returning({ id: playerObservations.id });

        if (result.length === 0) {
          return reply.code(404).send({ error: 'Observation not found' });
        }
        return reply.send({ success: true });
      } catch (err: any) {
        req.log.error({ err }, 'Failed to disagree with observation');
        return reply.code(500).send({ error: 'Failed to record disagreement' });
      }
    },
  );

  /**
   * POST /coaching/brain/reset
   * Completely wipe the player's coaching brain — observations, skills, graph, strategies.
   * Requires deliberate action from the player.
   */
  app.post('/coaching/brain/reset', { preHandler: [requireAuth] }, async (req, reply) => {
    try {
      // Delete graph nodes (edges cascade-delete via FK)
      await db.delete(coachingGraphNodes).where(eq(coachingGraphNodes.userId, req.userId));
      await db.delete(playerObservations).where(eq(playerObservations.userId, req.userId));
      await db.delete(playerSkillMastery).where(eq(playerSkillMastery.userId, req.userId));
      await db.delete(coachingStrategies).where(eq(coachingStrategies.userId, req.userId));

      // Clear greeting cache
      greetingCache.delete(req.userId);

      req.log.info('Brain reset complete for user %s', req.userId);
      return reply.send({ success: true });
    } catch (err: any) {
      req.log.error({ err }, 'Failed to reset brain');
      return reply.code(500).send({ error: 'Failed to reset brain' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  USAGE
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/coaching/usage', { preHandler: [requireAuth] }, async (req, reply) => {
    const balance = await credits.getCredits(req.userId);
    return reply.send({ credits: balance });
  });
}
