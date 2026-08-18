import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthRoutes } from './health.routes.js';

describe('Health routes', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(healthRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.0.1');
    expect(body.timestamp).toBeDefined();
  });
});
