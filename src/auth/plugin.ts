import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';

export type Role = 'user' | 'admin';

export interface AuthUser {
  /** users.id. PostgreSQL BIGINT is carried as a string to avoid precision loss. */
  sub: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid Bearer token and sets request.user. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler: requires a valid Bearer token whose role is admin. */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: app.config.JWT_SECRET,
    sign: { algorithm: 'HS256', expiresIn: app.config.JWT_EXPIRES_IN },
    verify: { algorithms: ['HS256'] },
  });

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing, invalid or expired access token');
    }
  };

  app.decorate('authenticate', authenticate);
  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    await authenticate(request);
    if (request.user.role !== 'admin') {
      throw new HttpError(403, 'FORBIDDEN', 'Admin role required');
    }
  });
}
