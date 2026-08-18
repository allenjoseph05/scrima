/**
 * Device Auth Flow — Desktop app login via Clerk
 *
 * Flow:
 *   1. Desktop app calls POST /auth/device-code → gets { userCode, deviceCode }
 *   2. Desktop app opens browser to GET /auth/device?code=XXXX-XXXX
 *   3. User signs in with Clerk on that page
 *   4. Page calls POST /auth/device-verify with { deviceCode, clerkToken }
 *   5. Desktop app polls POST /auth/device-token with { deviceCode }
 *   6. When verified → returns { sessionToken, userId, email, tier }
 *   7. Desktop app stores sessionToken, uses it for all API calls
 */

import crypto from 'node:crypto';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import { db, sessionTokens, users } from '../db/index.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY ?? '' });

// In-memory store for device codes (short-lived, 10-min TTL)
// For single-instance server this is fine. Move to Redis for multi-instance.
interface DeviceCodeEntry {
  userCode: string;
  deviceCode: string;
  userId?: string; // set after Clerk verification
  sessionToken?: string; // set after Clerk verification
  email?: string;
  displayName?: string;
  tier?: string;
  status: 'pending' | 'verified' | 'expired';
  expiresAt: number; // Unix ms
}

const deviceCodes = new Map<string, DeviceCodeEntry>();

// Clean expired entries every 5 minutes
const cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of deviceCodes) {
      if (now > entry.expiresAt) deviceCodes.delete(key);
    }
  },
  5 * 60 * 1000,
);
cleanupInterval.unref();

function generateUserCode(): string {
  // 8-char alphanumeric, formatted as XXXX-XXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I for readability
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function deviceAuthRoutes(app: FastifyInstance) {
  // ── Step 1: Generate device code ─────────────────────────────────────────
  app.post('/auth/device-code', async (_req, reply) => {
    const userCode = generateUserCode();
    const deviceCode = uuidv4();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    deviceCodes.set(deviceCode, {
      userCode,
      deviceCode,
      status: 'pending',
      expiresAt,
    });

    const host = _req.headers.host ?? _req.hostname;
    const baseUrl = `${_req.protocol}://${host}`;

    return reply.send({
      userCode,
      deviceCode,
      verifyUrl: `${baseUrl}/api/v1/auth/device?code=${userCode}`,
      expiresIn: 600, // seconds
    });
  });

  // ── Step 2: Serve sign-in page ───────────────────────────────────────────
  app.get('/auth/device', async (req, reply) => {
    const code = (req.query as { code?: string }).code ?? '';

    // Serve a minimal HTML page with Clerk sign-in
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scrima — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #050810;
      color: #E8EFFF;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      max-width: 420px;
      padding: 2rem;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2rem;
      letter-spacing: 0.15em;
      color: #7C3AED;
      margin: 1rem 0;
    }
    .subtitle { color: #7A8BAD; font-size: 0.9rem; margin-bottom: 2rem; }
    #clerk-mount { margin: 1.5rem 0; }
    .success {
      background: #0D1221;
      border: 1px solid #22c55e;
      border-radius: 8px;
      padding: 1.5rem;
      margin-top: 1.5rem;
    }
    .success h2 { color: #22c55e; margin-bottom: 0.5rem; }
    .error { color: #ef4444; margin-top: 1rem; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Scrima</h1>
    <p class="subtitle">Sign in to connect your desktop app</p>
    <div class="code">${escapeHtml(code)}</div>

    <div id="signin-section">
      <div id="clerk-mount"></div>
    </div>

    <div id="success-section" class="success hidden">
      <h2>Connected!</h2>
      <p>You can close this tab and return to the Scrima app.</p>
    </div>

    <p id="error-msg" class="error hidden"></p>
  </div>

  <script>
    const DEVICE_CODE_MAP = {};
    const USER_CODE = '${escapeHtml(code)}';

    // Find the device code matching this user code
    async function verifyWithServer(clerkToken) {
      try {
        const res = await fetch('/api/v1/auth/device-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userCode: USER_CODE, clerkToken }),
        });
        if (res.ok) {
          document.getElementById('signin-section').classList.add('hidden');
          document.getElementById('success-section').classList.remove('hidden');
        } else {
          const data = await res.json();
          showError(data.error || 'Verification failed');
        }
      } catch (e) {
        showError('Network error. Please try again.');
      }
    }

    function showError(msg) {
      const el = document.getElementById('error-msg');
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  </script>

  ${
    env.CLERK_SECRET_KEY
      ? `
  <script
    async
    crossorigin="anonymous"
    data-clerk-publishable-key="${env.CLERK_PUBLISHABLE_KEY ?? ''}"
    src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
  ></script>
  <script>
    window.addEventListener('load', async () => {
      if (!window.Clerk) {
        showError('Auth service unavailable. Please try again later.');
        return;
      }
      await window.Clerk.load();

      if (window.Clerk.user) {
        // Already signed in — verify immediately
        const token = await window.Clerk.session.getToken();
        await verifyWithServer(token);
      } else {
        window.Clerk.mountSignIn(document.getElementById('clerk-mount'), {
          afterSignInUrl: window.location.href,
        });

        // Watch for sign-in completion
        window.Clerk.addListener(async ({ user }) => {
          if (user) {
            const token = await window.Clerk.session.getToken();
            await verifyWithServer(token);
          }
        });
      }
    });
  </script>`
      : `
  <script>
    // Dev mode — no Clerk, auto-verify
    document.getElementById('clerk-mount').innerHTML =
      '<button onclick="devVerify()" style="background:#7C3AED;color:white;border:none;padding:12px 24px;border-radius:4px;cursor:pointer;font-size:1rem;margin-top:1rem;">Dev Sign In</button>';
    async function devVerify() {
      await verifyWithServer('dev-token');
    }
  </script>`
  }
</body>
</html>`;

    return reply.type('text/html').send(html);
  });

  // ── Step 3: Verify device code after Clerk sign-in ───────────────────────
  app.post('/auth/device-verify', async (req, reply) => {
    const { userCode, clerkToken } = req.body as { userCode: string; clerkToken: string };

    if (!userCode || !clerkToken) {
      return reply.code(400).send({ error: 'Missing userCode or clerkToken' });
    }

    // Find the device code entry by userCode
    let entry: DeviceCodeEntry | undefined;
    let entryKey: string | undefined;
    for (const [key, e] of deviceCodes) {
      if (e.userCode === userCode && e.status === 'pending') {
        entry = e;
        entryKey = key;
        break;
      }
    }

    if (!entry || !entryKey) {
      return reply.code(404).send({ error: 'Invalid or expired code' });
    }

    if (Date.now() > entry.expiresAt) {
      deviceCodes.delete(entryKey);
      return reply.code(410).send({ error: 'Code expired' });
    }

    // Verify Clerk token (or accept dev token in dev mode)
    let externalId: string;
    if (clerkToken === 'dev-token' && !env.CLERK_SECRET_KEY && env.NODE_ENV === 'development') {
      externalId = 'dev';
    } else if (env.CLERK_SECRET_KEY) {
      try {
        const payload = await verifyToken(clerkToken, { secretKey: env.CLERK_SECRET_KEY });
        externalId = payload.sub;
      } catch {
        return reply.code(401).send({ error: 'Invalid Clerk token' });
      }
    } else {
      return reply.code(500).send({ error: 'Auth not configured' });
    }

    // Find or create user
    let user = await db.query.users.findFirst({ where: eq(users.externalAuthId, externalId) });

    if (!user) {
      if (externalId === 'dev') {
        const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
        const [inserted] = await db
          .insert(users)
          .values({
            id: DEV_USER_ID,
            externalAuthId: 'dev',
            email: 'dev@scrima.local',
            displayName: 'Dev User',
          })
          .onConflictDoNothing()
          .returning();
        user =
          inserted ?? (await db.query.users.findFirst({ where: eq(users.externalAuthId, 'dev') }));
      } else {
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
    }

    if (!user) {
      return reply.code(500).send({ error: 'Failed to create user' });
    }

    // Generate long-lived session token (90 days)
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    await db.insert(sessionTokens).values({
      userId: user.id,
      token,
      label: 'desktop',
      expiresAt,
    });

    // Mark device code as verified
    entry.status = 'verified';
    entry.userId = user.id;
    entry.sessionToken = token;
    entry.email = user.email ?? undefined;
    entry.displayName = user.displayName ?? undefined;
    entry.tier = user.subscriptionTier;

    req.log.info({ userId: user.id }, 'Device auth verified');
    return reply.send({ ok: true });
  });

  // ── Step 4: Poll for session token ───────────────────────────────────────
  app.post('/auth/device-token', async (req, reply) => {
    const { deviceCode } = req.body as { deviceCode: string };
    if (!deviceCode) return reply.code(400).send({ error: 'Missing deviceCode' });

    const entry = deviceCodes.get(deviceCode);
    if (!entry) {
      return reply.code(404).send({ error: 'Invalid device code' });
    }

    if (Date.now() > entry.expiresAt) {
      deviceCodes.delete(deviceCode);
      return reply.code(410).send({ error: 'Code expired' });
    }

    if (entry.status === 'pending') {
      return reply.code(202).send({ status: 'pending' });
    }

    // Verified — return session token and clean up
    deviceCodes.delete(deviceCode);

    return reply.send({
      status: 'verified',
      sessionToken: entry.sessionToken,
      userId: entry.userId,
      email: entry.email,
      displayName: entry.displayName,
      subscriptionTier: entry.tier,
    });
  });
}
