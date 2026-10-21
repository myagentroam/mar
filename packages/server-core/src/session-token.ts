import { createHash, timingSafeEqual } from 'node:crypto';

export function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function csrfMatches(expectedHash: string, suppliedToken: string | undefined): boolean {
  if (suppliedToken === undefined) return false;
  const expected = Buffer.from(expectedHash, 'utf8');
  const actual = Buffer.from(hashOpaque(suppliedToken), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
