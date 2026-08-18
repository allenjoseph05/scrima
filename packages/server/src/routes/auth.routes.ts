import { SUBSCRIPTION_TIERS } from '@scrima/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, users } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { StripeService } from '../services/billing/stripe.service.js';
import { UsageService } from '../services/billing/usage.service.js';

const checkoutBodySchema = z.object({
  tier: z.enum(['pro', 'ultra']),
  successUrl: z
    .string()
    .url()
    .refine((url) => {
      try {
        return ['http:', 'https:'].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    }, 'Must be an HTTP(S) URL'),
  cancelUrl: z
    .string()
    .url()
    .refine((url) => {
      try {
        return ['http:', 'https:'].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    }, 'Must be an HTTP(S) URL'),
});

const portalBodySchema = z.object({
  returnUrl: z
    .string()
    .url()
    .refine((url) => {
      try {
        return ['http:', 'https:'].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    }, 'Must be an HTTP(S) URL'),
});

const stripe = new StripeService(db);
const usage = new UsageService(db);

export async function authRoutes(app: FastifyInstance) {
  // GET /user/profile
  app.get('/user/profile', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, req.userId) });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const tier = user.subscriptionTier as keyof typeof SUBSCRIPTION_TIERS;
    return reply.send({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      subscriptionTier: user.subscriptionTier,
      subscriptionStatus: user.subscriptionStatus,
      limits: SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free,
    });
  });

  // GET /user/usage
  app.get('/user/usage', { preHandler: [requireAuth] }, async (req, reply) => {
    const records = await usage.getCurrentUsage(req.userId);
    const analysesUsed = records
      .filter((r) => r.operation === 'game_analysis')
      .reduce((s, r) => s + r.count, 0);
    return reply.send({ analysesUsed });
  });

  // POST /subscription/create-checkout
  app.post('/subscription/create-checkout', { preHandler: [requireAuth] }, async (req, reply) => {
    const { tier, successUrl, cancelUrl } = checkoutBodySchema.parse(req.body);

    const result = await stripe.createCheckoutSession(req.userId, tier, successUrl, cancelUrl);
    return reply.send(result);
  });

  // POST /subscription/portal
  app.post('/subscription/portal', { preHandler: [requireAuth] }, async (req, reply) => {
    const { returnUrl } = portalBodySchema.parse(req.body);
    const result = await stripe.createPortalSession(req.userId, returnUrl);
    return reply.send(result);
  });
}
