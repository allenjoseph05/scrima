import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Minimum client version required by this server.
 * Bump this when a breaking API change is deployed.
 */
const MIN_CLIENT_VERSION = '0.0.1';

/**
 * Parse a semver string into comparable parts.
 * Returns [major, minor, patch] or null if invalid.
 */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)];
}

function isVersionSufficient(clientVersion: string, minVersion: string): boolean {
  const cv = parseSemver(clientVersion);
  const mv = parseSemver(minVersion);
  if (!cv || !mv) return true; // Don't block on unparseable versions

  for (let i = 0; i < 3; i++) {
    if (cv[i] > mv[i]) return true;
    if (cv[i] < mv[i]) return false;
  }
  return true; // Equal
}

/**
 * Fastify preHandler hook that checks X-Client-Version header.
 * Returns 426 Upgrade Required if the client is too old.
 */
export async function checkClientVersion(req: FastifyRequest, reply: FastifyReply) {
  const clientVersion = req.headers['x-client-version'] as string | undefined;

  // Allow requests without version header (web clients, curl, etc.)
  if (!clientVersion) return;

  if (!isVersionSufficient(clientVersion, MIN_CLIENT_VERSION)) {
    return reply.code(426).send({
      error: 'Client update required',
      code: 'UPDATE_REQUIRED',
      minVersion: MIN_CLIENT_VERSION,
      currentVersion: clientVersion,
    });
  }
}
