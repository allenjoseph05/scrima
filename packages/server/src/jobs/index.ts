import { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { coachingJobs } from '../db/schema.js';
import { gameRegistry } from '../games/registry.js';
import { UsageService } from '../services/billing/usage.service.js';
import { CoachingCreditsService } from '../services/coaching/coaching-credits.service.js';
import { ConsolidationService } from '../services/coaching/consolidation.service.js';
import { CvAnalysisService } from '../services/coaching/cv-analysis.service.js';
import { DeepAnalysisService } from '../services/coaching/deep-analysis.service.js';
import { WeeklyReportService } from '../services/coaching/weekly-report.service.js';
import { GameKnowledgeService } from '../services/knowledge/game-knowledge.service.js';
import { seedKnowledgeFromStatic } from '../services/knowledge/seed.js';
import { KnowledgeSyncService } from '../services/knowledge/sync/knowledge-sync.service.js';
import { ValorantSyncAdapter } from '../services/knowledge/sync/valorant-sync.adapter.js';
import { TempStorageService } from '../services/storage/temp-storage.service.js';
import { logger } from '../shared/logger.js';

// ── Redis availability ────────────────────────────────────────────────────────
// Queues and workers only start when REDIS_URL is set. This prevents idle
// polling from burning through Upstash free-tier request limits and lets
// the server start in dev mode without Redis.

const redisAvailable = !!env.REDIS_URL;
const connection = env.REDIS_URL ? { url: env.REDIS_URL } : { url: '' };

// ── Queues (only created when Redis is available) ─────────────────────────────

export const analysisQueue: Queue | null = redisAvailable
  ? new Queue('tier3-deep-coaching', { connection })
  : null;

export const weeklyQueue: Queue | null = redisAvailable
  ? new Queue('weekly-report', { connection })
  : null;

export const knowledgeSyncQueue: Queue | null = redisAvailable
  ? new Queue('knowledge-sync', { connection })
  : null;

export const consolidationQueue: Queue | null = redisAvailable
  ? new Queue('consolidation-sweep', { connection })
  : null;

// Re-export under old name for any remaining references
export { analysisQueue as tier3Queue };

// ── Services ──────────────────────────────────────────────────────────────────

const storage = new TempStorageService();
const usage = new UsageService(db);
const credits = new CoachingCreditsService(db);

const cvAnalysis = new CvAnalysisService(db, storage, usage, credits);
const deepAnalysis = new DeepAnalysisService(db, storage, usage, credits);
const weeklyReport = new WeeklyReportService(db, credits);

// ── Knowledge Pipeline ───────────────────────────────────────────────────────

export const knowledgeService = new GameKnowledgeService(db);
const knowledgeSyncService = new KnowledgeSyncService(knowledgeService, db);
knowledgeSyncService.registerAdapter(new ValorantSyncAdapter());

/** Initialize the knowledge pipeline: seed DB, warm cache, inject into game registry. */
export async function initKnowledgePipeline(): Promise<void> {
  try {
    await seedKnowledgeFromStatic(db);
    await knowledgeService.warmCache('valorant');
    gameRegistry.setKnowledgeService(knowledgeService);
    logger.info('Knowledge pipeline initialized');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'Knowledge pipeline init failed — using static fallback',
    );
  }

  // Fire-and-forget startup sync (non-blocking)
  knowledgeSyncService.syncAll('startup').catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Startup knowledge sync failed');
  });
}

// ── Workers (only created when Redis is available) ────────────────────────────

let analysisWorker: Worker | null = null;
let weeklyWorker: Worker | null = null;
let knowledgeSyncWorker: Worker | null = null;
let consolidationWorker: Worker | null = null;

if (redisAvailable && connection) {
  // Game analysis worker — drainDelay 15s (default 5s) to reduce idle polling
  analysisWorker = new Worker(
    'tier3-deep-coaching',
    async (job) => {
      logger.info({ jobId: job.id, matchId: job.data.matchId }, 'Game analysis starting');

      const jobInput = { ...job.data, bullJobId: job.id ?? undefined };

      // Try CV-powered analysis first (cheaper). Fall back to VLM if CV returns null.
      let result = await cvAnalysis.analyzeGame(jobInput);
      if (!result) {
        logger.info({ jobId: job.id }, 'CV analysis returned null, falling back to VLM');
        result = await deepAnalysis.analyzeGame(jobInput);
      }

      logger.info(
        {
          jobId: job.id,
          reportId: result.reportId,
          cost: result.vlmCostUsd,
          timeMs: result.processingTimeMs,
        },
        'Game analysis done',
      );

      return result;
    },
    { connection, concurrency: 2, drainDelay: 15_000 },
  );

  analysisWorker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Game analysis job failed');

    if (job?.data?.matchId) {
      try {
        await db
          .update(coachingJobs)
          .set({ status: 'failed', errorMsg: err.message, updatedAt: new Date() })
          .where(eq(coachingJobs.bullJobId, job.id ?? ''));
      } catch {
        /* best-effort */
      }
    }
  });

  // Weekly report worker — drainDelay 60s (runs once a week, no need to poll fast)
  weeklyWorker = new Worker(
    'weekly-report',
    async (job) => {
      logger.info({ jobId: job.id }, 'Weekly report generation starting');
      await weeklyReport.generateForAllPaidUsers();
      logger.info({ jobId: job.id }, 'Weekly report generation done');
    },
    { connection, concurrency: 1, drainDelay: 60_000 },
  );

  weeklyWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'Weekly report job failed'),
  );

  // Register the weekly cron
  weeklyQueue!
    .add(
      'weekly-aggregate',
      {},
      {
        repeat: { pattern: '0 23 * * 0' },
        jobId: 'weekly-aggregate-cron',
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    )
    .catch((err) => logger.error({ err }, 'Failed to register weekly cron'));

  // Knowledge sync worker — runs every 6 hours to auto-discover new agents/maps
  knowledgeSyncWorker = new Worker(
    'knowledge-sync',
    async (job) => {
      logger.info({ jobId: job.id }, 'Knowledge sync starting');
      const results = await knowledgeSyncService.syncAll('scheduled');
      const summary: Record<string, string> = {};
      for (const [gameId, result] of results) {
        summary[gameId] =
          `${result.status} (+${result.added} ~${result.updated} -${result.removed})`;
      }
      logger.info({ jobId: job.id, results: summary }, 'Knowledge sync done');
      return summary;
    },
    { connection, concurrency: 1, drainDelay: 60_000 },
  );

  knowledgeSyncWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'Knowledge sync job failed'),
  );

  // Register the knowledge sync cron — every 6 hours
  knowledgeSyncQueue!
    .add(
      'knowledge-sync',
      {},
      {
        repeat: { pattern: '0 */6 * * *' },
        jobId: 'knowledge-sync-cron',
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    )
    .catch((err) => logger.error({ err }, 'Failed to register knowledge sync cron'));

  // Consolidation sweep — runs daily 03:00 UTC. Catches idle users so their
  // graph nodes decay/prune even when they stop uploading. Active users get
  // consolidation post-enrichment already; this only touches users whose
  // last completed report was >24h ago.
  consolidationWorker = new Worker(
    'consolidation-sweep',
    async (job) => {
      logger.info({ jobId: job.id }, 'Consolidation sweep starting');
      const consolidation = new ConsolidationService(db);
      const result = await consolidation.consolidateStaleUsers(500);
      logger.info({ jobId: job.id, ...result }, 'Consolidation sweep done');
      return result;
    },
    { connection, concurrency: 1, drainDelay: 60_000 },
  );

  consolidationWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'Consolidation sweep job failed'),
  );

  consolidationQueue!
    .add(
      'consolidation-sweep',
      {},
      {
        repeat: { pattern: '0 3 * * *' }, // 03:00 UTC daily
        jobId: 'consolidation-sweep-cron',
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    )
    .catch((err) => logger.error({ err }, 'Failed to register consolidation sweep cron'));

  logger.info(
    'BullMQ workers initialized (game analysis drainDelay=15s, weekly drainDelay=60s, knowledge sync drainDelay=60s, consolidation sweep daily 03:00 UTC)',
  );
} else {
  logger.warn(
    'REDIS_URL not set — BullMQ queues/workers disabled. Game analysis runs inline in dev mode.',
  );
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

export async function shutdownJobs() {
  await Promise.all(
    [
      analysisWorker?.close(),
      weeklyWorker?.close(),
      knowledgeSyncWorker?.close(),
      consolidationWorker?.close(),
    ].filter(Boolean),
  );
}
