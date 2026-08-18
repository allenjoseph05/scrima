import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let version = '0.0.1';
try {
  const pkgPath = join(__dirname, '../../../package.json');
  if (existsSync(pkgPath)) {
    version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  } else {
    const altPath = join(__dirname, '../../package.json');
    if (existsSync(altPath)) {
      version = JSON.parse(readFileSync(altPath, 'utf-8')).version;
    }
  }
} catch {}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      version,
      timestamp: new Date().toISOString(),
    });
  });
}
