import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Parameters are stored in each hash so they can be raised later without invalidating old hashes.
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_COST = 2 ** 20;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function scryptOptions(cost: number, blockSize: number, parallelization: number): ScryptOptions {
  return {
    N: cost,
    r: blockSize,
    p: parallelization,
    // scrypt needs about 128 * N * r bytes; Node's default limit (32 MiB) is too low for N = 2^15.
    maxmem: 256 * cost * blockSize,
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(
    password,
    salt,
    KEY_LENGTH,
    scryptOptions(COST, BLOCK_SIZE, PARALLELIZATION),
  );
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, costText, blockSizeText, parallelizationText, saltText, keyText] =
    stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  const validParams =
    Number.isInteger(cost) &&
    cost > 1 &&
    cost <= MAX_COST &&
    Number.isInteger(blockSize) &&
    blockSize > 0 &&
    blockSize <= 16 &&
    Number.isInteger(parallelization) &&
    parallelization > 0 &&
    parallelization <= 4;
  if (!validParams) return false;

  const expected = Buffer.from(keyText, 'base64url');
  if (expected.length === 0) return false;

  const actual = await deriveKey(
    password,
    Buffer.from(saltText, 'base64url'),
    expected.length,
    scryptOptions(cost, blockSize, parallelization),
  );
  return timingSafeEqual(actual, expected);
}
