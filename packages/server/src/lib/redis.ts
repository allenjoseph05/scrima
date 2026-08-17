import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';

let redisInstance: Redis | null = null;

export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    redisInstance.on('error', (err: Error & { code?: string }) => {
      if (err?.code !== 'ECONNREFUSED') {
        logger.error({ err }, '[redis] error');
      }
    });
  }
  return redisInstance;
}

export async function disconnectRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
