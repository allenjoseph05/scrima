import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Webhook } from 'svix';
import { env } from '../config/env.js';
import { db, users } from '../db/index.js';
import { StripeService } from '../services/billing/stripe.service.js';

const stripe = new StripeService(db);

// Fastify stores the raw body on the request when we use the custom content-type parser
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export async function webhookRoutes(app: FastifyInstance) {
  // ── Stripe webhooks ────────────────────────────────────────────────────────
  app.post('/webhooks/stripe', async (req: RawBodyRequest, reply) => {
    const sig = req.headers['stripe-signature'];
    const signature = Array.isArray(sig) ? sig[0] : sig;
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

    try {
      await stripe.handleWebhook(body, signature);
      return reply.send({ received: true });
    } catch (err: unknown) {
      req.log.error({ err }, 'Stripe webhook error');
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Stripe webhook processing failed' });
    }
  });

  // ── Clerk webhooks ─────────────────────────────────────────────────────────
  // Handles user lifecycle events. All user data tables use ON DELETE CASCADE,
  // so deleting from `users` automatically removes matches, reports,
  // credits, and usage records.
  app.post('/webhooks/clerk', async (req: RawBodyRequest, reply) => {
    if (!env.CLERK_WEBHOOK_SECRET) {
      req.log.warn('CLERK_WEBHOOK_SECRET not set — skipping webhook verification');
      return reply.code(500).send({ error: 'Webhook not configured' });
    }

    const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const svixId = req.headers['svix-id'] as string;
    const svixTimestamp = req.headers['svix-timestamp'] as string;
    const svixSignature = req.headers['svix-signature'] as string;

    if (!svixId || !svixTimestamp || !svixSignature) {
      return reply.code(400).send({ error: 'Missing svix headers' });
    }

    let event: { type: string; data: { id: string } };
    try {
      const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
      event = wh.verify(body.toString(), {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      }) as typeof event;
    } catch (err: unknown) {
      req.log.error({ err }, 'Clerk webhook verification failed');
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    req.log.info({ type: event.type, clerkId: event.data.id }, 'Clerk webhook received');

    if (event.type === 'user.deleted') {
      const clerkId = event.data.id;
      const deleted = await db
        .delete(users)
        .where(eq(users.externalAuthId, clerkId))
        .returning({ id: users.id });

      if (deleted.length > 0) {
        req.log.info({ userId: deleted[0].id, clerkId }, 'User cascade-deleted');
      } else {
        req.log.warn({ clerkId }, 'User not found for deletion');
      }
    }

    return reply.send({ received: true });
  });
}
