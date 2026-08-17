/**
 * Environment variable validation.
 * All required env vars are validated at startup.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.string().default('3001').transform(Number).pipe(z.number().int().min(1).max(65535)),
  HOST: z.string().default('0.0.0.0'),

  // Database (optional in dev — server can start without it)
  DATABASE_URL: z.string().optional(),

  // Redis (optional in dev)
  REDIS_URL: z.string().optional(),

  // VLM
  GEMINI_API_KEY: z.string().optional(),
  VLM_MODEL: z.string().default('gemini-2.5-flash-lite'),
  VLM_MEDIA_RESOLUTION: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('LOW'),
  VLM_VIDEO_FPS: z.string().default('1').transform(Number).pipe(z.number().min(0.1).max(60)),
  // Stage 2 synthesis model — text-only coaching call over the per-death fact
  // JSONs. Defaults to Gemini 2.5 Flash (with thinking) because coaching is a
  // reasoning task where capability matters more than per-call cost (~$0.005
  // per match with thinking enabled at typical input/output sizes).
  SYNTHESIS_MODEL: z.string().default('gemini-2.5-flash'),
  SYNTHESIS_THINKING_BUDGET: z
    .string()
    .default('4096')
    .transform(Number)
    .pipe(z.number().int().min(0).max(24576)),
  // If the primary synthesis model persistently fails (e.g. Gemini Flash 503
  // overload), the service falls back to this second model before giving up
  // and using the deterministic fact-based report. Gemma 3 27B is text-only,
  // free, and far less rate-limited than Flash — a reliable safety net.
  SYNTHESIS_FALLBACK_MODEL: z.string().default('gemma-3-27b-it'),
  FACT_VERIFICATION_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  FACT_VERIFICATION_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform(Number)
    .pipe(z.number().int().min(0)),

  // Auth
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_ULTRA_PRICE_ID: z.string().optional(),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default('scrima-temp'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Error tracking
  SENTRY_DSN: z.string().optional(),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
export type Env = typeof env;
