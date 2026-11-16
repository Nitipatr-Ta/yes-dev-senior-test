import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureAdmin } from '../src/auth/bootstrap.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { buildTestApp } from './helpers.js';

const EMAIL_DOMAIN = `auth-${randomUUID()}.test`;
const uniqueEmail = () => `${randomUUID()}@${EMAIL_DOMAIN}`;
const PASSWORD = 'correct horse battery';

describe('password hashing', () => {
  it('verifies the original password and rejects others', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
  });
});

describe('auth API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    // Routes that exist only to exercise the guards.
    app.get('/test/admin-only', { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  });

  afterAll(async () => {
    await app.db.query('DELETE FROM users WHERE email LIKE $1', [`%@${EMAIL_DOMAIN}`]);
    await app.close();
  });

  const register = (body: unknown) =>
    app.inject({ method: 'POST', url: '/auth/register', payload: body as object });
  const login = (body: unknown) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: body as object });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('registers a user, stores a hash and returns a usable token', async () => {
    const email = uniqueEmail();
    const response = await register({ email, password: PASSWORD });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user).toEqual({ id: expect.any(String), email, role: 'user' });
    expect(body.tokenType).toBe('Bearer');
    expect(JSON.stringify(body)).not.toContain('password');

    const stored = await app.db.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(stored.rows[0].password_hash).toMatch(/^scrypt\$/);

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(body.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toEqual(body.user);
  });

  it('treats email as case-insensitive and rejects duplicates with 409', async () => {
    const email = uniqueEmail();
    expect((await register({ email, password: PASSWORD })).statusCode).toBe(201);

    const duplicate = await register({ email: email.toUpperCase(), password: PASSWORD });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('never lets a client choose its own role', async () => {
    const response = await register({ email: uniqueEmail(), password: PASSWORD, role: 'admin' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['missing body', undefined],
    ['invalid email', { email: 'not-an-email', password: PASSWORD }],
    ['short password', { email: 'a@example.com', password: 'short' }],
    ['password too long', { email: 'a@example.com', password: 'x'.repeat(129) }],
    ['non-string password', { email: 'a@example.com', password: 12345678 }],
  ])('rejects registration with %s', async (_name, body) => {
    const response = await register(body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('logs in with the right password', async () => {
    const email = uniqueEmail();
    await register({ email, password: PASSWORD });

    const response = await login({ email, password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toEqual(expect.any(String));
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const email = uniqueEmail();
    await register({ email, password: PASSWORD });

    const wrongPassword = await login({ email, password: 'wrong password' });
    const unknownEmail = await login({ email: uniqueEmail(), password: PASSWORD });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('rejects requests without a valid token', async () => {
    const forged = app.jwt.sign({ sub: '1', role: 'admin' }).slice(0, -3) + 'abc';
    const expired = app.jwt.sign({ sub: '1', role: 'user' }, { expiresIn: -10 });

    for (const headers of [{}, { authorization: 'Bearer nonsense' }, bearer(forged), bearer(expired)]) {
      const response = await app.inject({ method: 'GET', url: '/auth/me', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: '1', role: 'admin' })}.`;

    const response = await app.inject({
      method: 'GET',
      url: '/test/admin-only',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows only admins through requireAdmin', async () => {
    const userToken = (await register({ email: uniqueEmail(), password: PASSWORD })).json()
      .accessToken;

    const adminEmail = uniqueEmail();
    const config = { ...app.config, ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: PASSWORD };
    expect(await ensureAdmin(app.db, config)).toBe(true);
    expect(await ensureAdmin(app.db, config)).toBe(false);
    const adminToken = (await login({ email: adminEmail, password: PASSWORD })).json().accessToken;

    const call = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/test/admin-only', headers });

    expect((await call({})).statusCode).toBe(401);
    expect((await call(bearer(userToken))).statusCode).toBe(403);
    expect((await call(bearer(adminToken))).statusCode).toBe(200);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
