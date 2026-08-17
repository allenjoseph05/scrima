/**
 * Scrima API Server — Entry Point
 *
 * Fastify-based stateless API server.
 * Forwards video clips to Gemini VLM and stores only JSON results.
 */

import crypto from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { initKnowledgePipeline, shutdownJobs } from './jobs/index.js';
import { registerErrorHandler } from './middleware/error.middleware.js';
import { checkClientVersion } from './middleware/version.middleware.js';
import { registerRoutes } from './routes/index.js';
import { logger } from './shared/logger.js';
import { initSentry } from './shared/sentry.js';

async function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:mm:ss',
                ignore: 'pid,hostname',
              },
            },
          }
        : true,
    // Store raw body for Stripe webhook signature verification
    bodyLimit: 200 * 1024 * 1024, // 200 MB (full-game analysis copies can be 100+ MB)
    // Generate a short correlation ID for each request
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 12),
    requestIdHeader: 'x-request-id',
  });

  // Needed for Stripe webhook raw body — only store rawBody for webhook routes
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    if (req.url?.includes('/webhooks')) {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
    }
    try {
      done(null, JSON.parse(body.toString()));
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(cors, {
    origin: env.NODE_ENV !== 'production',
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.userId ?? req.ip,
    errorResponseBuilder: () => ({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      statusCode: 429,
    }),
  });

  // Route-specific tighter rate limits
  app.addHook('onRoute', (routeOptions) => {
    const key = `${routeOptions.method} ${routeOptions.url}`;
    // Apply stricter limits for expensive endpoints
    if (key.includes('/coaching/deep-analyze') && routeOptions.method === 'POST') {
      routeOptions.config = { ...routeOptions.config, rateLimit: { max: 3, timeWindow: '1 hour' } };
    } else if (key.includes('/matches') && routeOptions.method === 'POST') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: { max: 5, timeWindow: '1 minute' },
      };
    }
  });

  // Echo request ID back in response
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Version negotiation — reject outdated clients
  app.addHook('preHandler', checkClientVersion);

  registerErrorHandler(app);
  await registerRoutes(app);

  return app;
}

async function start() {
  try {
    await initSentry();
    const app = await buildApp();

    // Initialize knowledge pipeline before accepting traffic
    await initKnowledgePipeline();

    await app.listen({ port: env.PORT, host: env.HOST });

    logger.info(`Scrima API running on http://${env.HOST}:${env.PORT}`);
    logger.info(`Environment: ${env.NODE_ENV}`);

    // Cleanup stale Gemini uploaded files from previous runs.
    // Leaked files consume API quota and cause 503 errors on multimodal calls.
    if (env.GEMINI_API_KEY) {
      try {
        const { GeminiProvider } = await import('./services/vlm/gemini.provider.js');
        const vlm = new GeminiProvider('gemini-2.5-flash-lite');
        const files = await vlm.listUploadedFiles?.().catch(() => null);
        if (files && files.length > 0) {
          for (const f of files) {
            await vlm.deleteVideoFile(f.name).catch(() => {});
          }
          logger.info(`Cleaned up ${files.length} stale Gemini uploaded files`);
        }
      } catch {
        /* Gemini cleanup is best-effort */
      }
    }

    // Job workers start automatically on import (if REDIS_URL is set)

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      await shutdownJobs();
      const { disconnectRedis } = await import('./lib/redis.js');
      await disconnectRedis();
      const { pool } = await import('./db/index.js');
      await pool.end();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

start();
