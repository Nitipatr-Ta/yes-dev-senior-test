import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a_secret_that_is_at_least_32_characters_long',
};

describe('loadConfig', () => {
  it('applies defaults when only the required variables are set', () => {
    expect(loadConfig(valid)).toEqual({
      ...valid,
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      JWT_EXPIRES_IN: 3600,
      RATE_LIMIT_ENABLED: true,
      TRUST_PROXY: false,
    });
  });

  it('converts numbers and flags from their string form', () => {
    const config = loadConfig({
      ...valid,
      PORT: '8080',
      JWT_EXPIRES_IN: '900',
      RATE_LIMIT_ENABLED: 'false',
      TRUST_PROXY: 'true',
    });

    expect(config.PORT).toBe(8080);
    expect(config.JWT_EXPIRES_IN).toBe(900);
    expect(config.RATE_LIMIT_ENABLED).toBe(false);
    expect(config.TRUST_PROXY).toBe(true);
  });

  it('normalises the admin email', () => {
    const config = loadConfig({
      ...valid,
      ADMIN_EMAIL: '  Admin@Example.COM ',
      ADMIN_PASSWORD: 'long-enough',
    });

    expect(config.ADMIN_EMAIL).toBe('admin@example.com');
  });

  it.each([
    ['a missing DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['a missing REDIS_URL', { REDIS_URL: undefined }, 'REDIS_URL'],
    ['a missing JWT_SECRET', { JWT_SECRET: undefined }, 'JWT_SECRET'],
    ['a JWT_SECRET shorter than 32 characters', { JWT_SECRET: 'too-short' }, 'JWT_SECRET'],
    ['a DATABASE_URL that is not a URL', { DATABASE_URL: 'not a url' }, 'DATABASE_URL'],
    ['a PORT out of range', { PORT: '70000' }, 'PORT'],
    ['a PORT that is not a number', { PORT: 'abc' }, 'PORT'],
    ['a zero JWT_EXPIRES_IN', { JWT_EXPIRES_IN: '0' }, 'JWT_EXPIRES_IN'],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    ['a flag that is not true or false', { RATE_LIMIT_ENABLED: 'yes' }, 'RATE_LIMIT_ENABLED'],
    ['an invalid ADMIN_EMAIL', { ADMIN_EMAIL: 'nope' }, 'ADMIN_EMAIL'],
    ['a short ADMIN_PASSWORD', { ADMIN_PASSWORD: 'short' }, 'ADMIN_PASSWORD'],
  ])('refuses to start with %s, naming the variable', (_name, overrides, variable) => {
    expect(() => loadConfig({ ...valid, ...overrides })).toThrow(
      new RegExp(`Invalid environment configuration: .*${variable}`),
    );
  });

  it('does not put the secret in the error message', () => {
    try {
      loadConfig({ ...valid, JWT_SECRET: 'leak-me', PORT: 'abc' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('leak-me');
    }
  });
});
