import { AppError } from '@scrima/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../shared/logger.js';
import { captureException } from '../shared/sentry.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: error.errors,
      });
    }

    // Our custom app errors
    if (error instanceof AppError) {
      const statusCode = error.severity === 'low' ? 400 : error.severity === 'medium' ? 422 : 500;
      return reply.status(statusCode).send({
        error: error.userMessage ?? error.message,
        code: error.code,
        statusCode,
      });
    }

    // Fastify errors with statusCode — forward the original status
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return reply.code(error.statusCode).send({
        error: error.message,
        statusCode: error.statusCode,
      });
    }

    // Unexpected errors — log internally, return generic message
    logger.error({ err: error }, 'Unhandled error');
    captureException(error, { route: request.url, method: request.method });
    return reply.status(500).send({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      error: 'Route not found',
      code: 'ROUTE_NOT_FOUND',
      statusCode: 404,
    });
  });
}
