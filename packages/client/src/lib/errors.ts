// Centralized user-facing error formatting.
// Goal: never leak raw stack traces, file paths, or internal Rust/server error strings into the UI.
// Every client-side error surface should go through formatUserError(err, fallback).

const NETWORK_HINTS = [
  'failed to fetch',
  'networkerror',
  'load failed',
  'fetch failed',
  'net::err',
  'econnrefused',
  'connection refused',
  'enotfound',
  'etimedout',
  'dns',
];

const TIMEOUT_HINTS = ['timeout', 'timed out', 'aborted'];

const UNAUTHORIZED_HINTS = ['unauthorized', '401', 'jwt', 'token expired', 'session expired'];

const QUOTA_HINTS = ['no credits', 'no_credits', 'quota', 'limit reached', 'rate limit'];

const OVERLOAD_HINTS = [
  'llm_overloaded',
  'ai service is busy',
  'currently experiencing high demand',
  'unavailable',
  '503',
  'overloaded',
];

function toLowerSafe(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err.toLowerCase();
  if (err instanceof Error) return err.message.toLowerCase();
  if (typeof err === 'object') {
    const e = err as { message?: unknown; error?: unknown };
    if (typeof e.message === 'string') return e.message.toLowerCase();
    if (typeof e.error === 'string') return e.error.toLowerCase();
  }
  try {
    return String(err).toLowerCase();
  } catch {
    return '';
  }
}

function extractServerMessage(err: unknown): string | null {
  // Fastify-style { error: string, code?: string } or Tauri-command rejection with a plain string.
  if (err && typeof err === 'object') {
    const e = err as { error?: unknown; userMessage?: unknown };
    if (
      typeof e.userMessage === 'string' &&
      e.userMessage.length > 0 &&
      e.userMessage.length <= 200
    ) {
      return e.userMessage;
    }
    if (typeof e.error === 'string' && e.error.length > 0 && e.error.length <= 200) {
      return e.error;
    }
  }
  return null;
}

function anyHit(haystack: string, needles: string[]): boolean {
  for (const n of needles) if (haystack.includes(n)) return true;
  return false;
}

/**
 * Convert any thrown value into a short, user-safe string.
 * Fall back to the provided copy if the error is opaque.
 */
export function formatUserError(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const lower = toLowerSafe(err);

  if (anyHit(lower, NETWORK_HINTS)) {
    return "Can't reach Scrima — check your connection and try again.";
  }
  if (anyHit(lower, TIMEOUT_HINTS)) {
    return 'That took too long. Please try again.';
  }
  if (anyHit(lower, UNAUTHORIZED_HINTS)) {
    return 'Please sign in again.';
  }
  if (anyHit(lower, QUOTA_HINTS)) {
    return "You've hit your usage limit — it'll reset soon.";
  }
  if (anyHit(lower, OVERLOAD_HINTS)) {
    return 'AI is busy right now — wait a moment and ask again.';
  }

  // Trust a short server-provided message if present.
  const server = extractServerMessage(err);
  if (server) return server;

  return fallback;
}

/**
 * Lightweight telemetry entry point. Keeps console noise in dev.
 * Future: forward to Tauri for structured server logging.
 */
export function reportError(err: unknown, context: string): void {
  if (typeof console !== 'undefined' && console.error) {
    console.error(`[${context}]`, err);
  }
}
