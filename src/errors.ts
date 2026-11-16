import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** An error the client is allowed to see. Anything else is reported as a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }

    // Errors raised by Fastify itself, such as malformed JSON or an oversized body.
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      const message = error instanceof Error ? error.message : 'Bad request';
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message } });
    }

    request.log.error(error, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );
}
