/**
 * Sentry error tracking integration.
 *
 * Lazily initialises Sentry when SENTRY_DSN is provided.
 * No-ops gracefully if @sentry/node is not installed.
 */

import { env } from '../config/env.js';
import { logger } from './logger.js';

interface SentryApi {
  init(options: { dsn: string; environment: string; tracesSampleRate: number }): void;
  captureException(error: unknown, hint?: { extra: Record<string, unknown> }): void;
  captureMessage(message: string, level: 'info' | 'warning' | 'error'): void;
}

let sentryInstance: SentryApi | null = null;

export async function initSentry() {
  if (!env.SENTRY_DSN) return;

  try {
    // Dynamic import — won't fail the build if @sentry/node isn't installed
    const Sentry = await (Function('return import("@sentry/node")')() as Promise<SentryApi>);
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
    });
    sentryInstance = Sentry;
    logger.info('Sentry initialised');
  } catch {
    logger.info('Sentry SDK not installed — error tracking disabled');
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (sentryInstance) {
    sentryInstance.captureException(err, context ? { extra: context } : undefined);
  }
}

export function captureMessage(msg: string, level: 'info' | 'warning' | 'error' = 'info') {
  if (sentryInstance) {
    sentryInstance.captureMessage(msg, level);
  }
}
