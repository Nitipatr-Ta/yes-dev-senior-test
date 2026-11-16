import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { byIp, hashKey } from '../rate-limit/plugin.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Role } from './plugin.js';

const PG_UNIQUE_VIOLATION = '23505';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

const registerBody = z.strictObject({
  email,
  // The upper bound caps the CPU cost of hashing attacker-supplied input.
  password: z.string().min(8).max(128),
});

const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(128),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === PG_UNIQUE_VIOLATION
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Verified when the email is unknown, so both login failures cost one scrypt run
  // and response time does not reveal which emails are registered.
  const dummyHash = await hashPassword('dummy-password-for-timing');

  const issueToken = (user: Pick<UserRow, 'id' | 'role'>) => ({
    accessToken: app.jwt.sign({ sub: user.id, role: user.role }),
    tokenType: 'Bearer' as const,
    expiresIn: app.config.JWT_EXPIRES_IN,
  });

  const authLimit = app.rateLimit('auth', byIp);
  // Keyed by the email being tried, so guessing one account's password from many IPs is
  // still limited. A body that is not a valid login is left for validation to reject.
  const loginEmailLimit = app.rateLimit('loginEmail', (request) => {
    const parsed = loginBody.safeParse(request.body);
    return parsed.success ? hashKey(parsed.data.email) : undefined;
  });

  app.post('/auth/register', { preHandler: authLimit }, async (request, reply) => {
    const body = registerBody.parse(request.body);
    const passwordHash = await hashPassword(body.password);

    let user: Pick<UserRow, 'id' | 'email' | 'role'> | undefined;
    try {
      const result = await app.db.query<Pick<UserRow, 'id' | 'email' | 'role'>>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role`,
        [body.email, passwordHash],
      );
      user = result.rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'Email is already registered');
      }
      throw error;
    }
    if (!user) throw new Error('INSERT INTO users returned no row');

    return reply.code(201).send({ user, ...issueToken(user) });
  });

  app.post('/auth/login', { preHandler: [authLimit, loginEmailLimit] }, async (request) => {
    const body = loginBody.parse(request.body);
    const result = await app.db.query<UserRow>(
      `SELECT id, email, password_hash, role FROM users WHERE email = $1`,
      [body.email],
    );
    const user = result.rows[0];
    const passwordMatches = await verifyPassword(body.password, user?.password_hash ?? dummyHash);
    if (!user || !passwordMatches) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    return {
      user: { id: user.id, email: user.email, role: user.role },
      ...issueToken(user),
    };
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
    const result = await app.db.query<Pick<UserRow, 'id' | 'email' | 'role'>>(
      `SELECT id, email, role FROM users WHERE id = $1`,
      [request.user.sub],
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'User no longer exists');
    return { user };
  });
}
