import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_LENGTH = 32;
export const INITIAL_ADMIN_PASSWORD = 'EanlRffYBYYo70pigl4y';

interface EncodedPassword {
  readonly salt: Buffer;
  readonly digest: Buffer;
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < 8 || password.length > 1024) {
    throw new Error('PASSWORD_POLICY_VIOLATION');
  }
}

/** Local reset may restore the documented initial password; all other values use the normal policy. */
export function assertResetPasswordPolicy(password: string): void {
  if (password === INITIAL_ADMIN_PASSWORD) return;
  assertPasswordPolicy(password);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism: ARGON2_PARALLELISM,
    tagLength: ARGON2_TAG_LENGTH,
    memory: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES
  });

  return [
    'argon2id',
    'v=19',
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`,
    salt.toString('base64url'),
    Buffer.from(digest).toString('base64url')
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parsed = parseEncodedPassword(encoded);
  if (parsed === undefined) {
    return false;
  }

  const derived = argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: parsed.salt,
    parallelism: ARGON2_PARALLELISM,
    tagLength: ARGON2_TAG_LENGTH,
    memory: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES
  });
  const candidate = Buffer.from(derived);

  return candidate.length === parsed.digest.length && timingSafeEqual(candidate, parsed.digest);
}

function parseEncodedPassword(encoded: string): EncodedPassword | undefined {
  const parts = encoded.split('$');
  if (
    parts.length !== 5 ||
    parts[0] !== 'argon2id' ||
    parts[1] !== 'v=19' ||
    parts[2] !== `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`
  ) {
    return undefined;
  }

  try {
    const salt = Buffer.from(parts[3] ?? '', 'base64url');
    const digest = Buffer.from(parts[4] ?? '', 'base64url');
    if (salt.length !== 16 || digest.length !== ARGON2_TAG_LENGTH) {
      return undefined;
    }
    return { salt, digest };
  } catch {
    return undefined;
  }
}
