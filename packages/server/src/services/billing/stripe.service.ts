import { AppError } from '@scrima/shared';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { env } from '../../config/env.js';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';

const STRIPE_PRICE_IDS: Record<string, string> = {
  pro: env.STRIPE_PRO_PRICE_ID ?? '',
  ultra: env.STRIPE_ULTRA_PRICE_ID ?? '',
};

if (!STRIPE_PRICE_IDS.pro || !STRIPE_PRICE_IDS.ultra) {
  console.warn('[stripe] Warning: Stripe price IDs not configured. Checkout will fail.');
}

export class StripeService {
  private stripe: Stripe | null;

  constructor(private db: Db) {
    this.stripe = env.STRIPE_SECRET_KEY
      ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' })
      : null;
  }

  private get client(): Stripe {
    if (!this.stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
    return this.stripe;
  }

  async createCheckoutSession(
    userId: string,
    tier: 'pro' | 'ultra',
    successUrl: string,
    cancelUrl: string,
  ) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new Error('User not found');

    const session = await this.client.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email ?? undefined,
      client_reference_id: userId,
      line_items: [
        {
          price: STRIPE_PRICE_IDS[tier],
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, tier },
    });

    return { url: session.url };
  }

  async createPortalSession(userId: string, returnUrl: string) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user?.stripeCustomerId) throw new Error('No Stripe customer found');

    const session = await this.client.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new AppError('Stripe webhook secret not configured', 'STRIPE_CONFIG_ERROR', 'high');
    }
    const event = this.client.webhooks.constructEvent(payload, signature, webhookSecret);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier;
        if (userId && tier) {
          await this.db
            .update(users)
            .set({
              subscriptionTier: tier,
              subscriptionStatus: 'active',
              stripeCustomerId:
                typeof session.customer === 'string'
                  ? session.customer
                  : (session.customer?.id ?? null),
              stripeSubscriptionId:
                typeof session.subscription === 'string'
                  ? session.subscription
                  : (session.subscription?.id ?? null),
            })
            .where(eq(users.id, userId));
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const status = sub.status === 'active' ? 'active' : sub.status;
        const priceId = sub.items?.data?.[0]?.price?.id;
        let tier = 'free';
        if (priceId === STRIPE_PRICE_IDS.ultra) tier = 'ultra';
        else if (priceId === STRIPE_PRICE_IDS.pro) tier = 'pro';
        await this.db
          .update(users)
          .set({ subscriptionStatus: status, subscriptionTier: tier })
          .where(eq(users.stripeSubscriptionId, sub.id));
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await this.db
          .update(users)
          .set({
            subscriptionTier: 'free',
            subscriptionStatus: 'active',
            stripeSubscriptionId: null,
          })
          .where(eq(users.stripeSubscriptionId, sub.id));
        break;
      }
    }
  }
}
