import { createClerkClient, verifyToken } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { db, sessionTokens, users } from '../db/index.js';

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY ?? '' });

// Stable dev user ID — same across restarts so DB rows stay consistent
const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

async function ensureDevUser(): Promise<void> {
  const existing = await db.query.users.findFirst({ where: eq(users.id, DEV_USER_ID) });
  if (!existing) {
    await db
      .insert(users)
      .values({
        id: DEV_USER_ID,
        externalAuthId: 'dev',
        email: 'dev@scrima.local',
        displayName: 'Dev User',
      })
      .onConflictDoNothing();
  }
}

/**
 * Try to authenticate via a long-lived session token (UUID format).
 * These are issued by the device auth flow for desktop app login.
 * Returns the user's internal ID if valid, null otherwise.
 */
async function authenticateSessionToken(token: string): Promise<string | null> {
  // Session tokens are UUIDs — quick format check
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(token)) return null;

  const row = await db.query.sessionTokens.findFirst({
    where: eq(sessionTokens.token, token),
  });

  if (!row) return null;
  if (new Date() > row.expiresAt) return null;

  // Update lastUsed timestamp (fire-and-forget)
  db.update(sessionTokens)
    .set({ lastUsed: new Date() })
    .where(eq(sessionTokens.id, row.id))
    .catch(() => {});

  return row.userId;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // ── Dev bypass ─────────────────────────────────────────────────────────────
  // Active only when CLERK_SECRET_KEY is absent AND NODE_ENV is development.
  if (!env.CLERK_SECRET_KEY && env.NODE_ENV === 'development') {
    await ensureDevUser();
    req.userId = DEV_USER_ID;
    return;
  }

  // ── Bearer token (session token OR Clerk JWT) ─────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  const token = authHeader.slice(7);

  // Try session token first (desktop app long-lived tokens)
  const sessionUserId = await authenticateSessionToken(token);
  if (sessionUserId) {
    req.userId = sessionUserId;
    return;
  }

  // Fall back to Clerk JWT verification (website / short-lived tokens)
  try {
    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY ?? '' });
    const externalId = payload.sub;

    let user = await db.query.users.findFirst({ where: eq(users.externalAuthId, externalId) });

    if (!user) {
      const clerkUser = await clerk.users.getUser(externalId);
      const [inserted] = await db
        .insert(users)
        .values({
          id: uuidv4(),
          externalAuthId: externalId,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          displayName: `${clerkUser.firstName ?? ''} ${clerkUser.lastName ?? ''}`.trim() || null,
          avatarUrl: clerkUser.imageUrl,
        })
        .returning();
      user = inserted;
    }

    req.userId = user!.id;
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  }
}
