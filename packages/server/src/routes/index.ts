import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.routes.js';
import { coachingRoutes } from './coaching.routes.js';
import { deviceAuthRoutes } from './device-auth.routes.js';
import { healthRoutes } from './health.routes.js';
import { matchesRoutes } from './matches.routes.js';
import { webhookRoutes } from './webhooks.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(matchesRoutes, { prefix: '/api/v1' });
  await app.register(coachingRoutes, { prefix: '/api/v1' });
  await app.register(webhookRoutes, { prefix: '/api/v1' });
  await app.register(deviceAuthRoutes, { prefix: '/api/v1' });
}
