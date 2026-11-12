import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuid } from '../../src/util/uuid.js';
import { sha256 } from '../../src/util/sha256.js';

afterEach(() => vi.unstubAllGlobals());

describe('HTTP-compatible crypto utilities', () => {
  it('generates version 4 UUIDs with native crypto and with getRandomValues alone', () => {
    for (const crypto of [
      webcrypto,
      { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
    ]) {
      vi.stubGlobal('crypto', crypto);
      const ids = Array.from({ length: 100 }, createUuid);
      expect(new Set(ids).size).toBe(100);
      for (const id of ids)
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
    }
  });

  it('preserves random bytes except for UUID version and variant bits', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) });
    expect(createUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it.each([0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 1000000])(
    'matches Node SHA-256 for %i bytes with and without SubtleCrypto',
    async (length) => {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
      const expected = createHash('sha256').update(bytes).digest('hex');
      for (const crypto of [webcrypto, undefined]) {
        vi.stubGlobal('crypto', crypto);
        expect(await sha256(bytes)).toBe(expected);
      }
    }
  );

  it('hashes the exact subarray and UTF-8 bytes without modifying the input', async () => {
    vi.stubGlobal('crypto', {});
    const bytes = new TextEncoder().encode('x你好🌍abcx').subarray(1, -1);
    const before = bytes.slice();
    expect(await sha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(bytes).toEqual(before);
  });

  it('lets browser tasks run before completing a larger fallback hash', async () => {
    vi.stubGlobal('crypto', {});
    const bytes = new Uint8Array(1024 * 1024).fill(0x61);
    let settled = false;
    const digest = sha256(bytes).then((value) => {
      settled = true;
      return value;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(await digest).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
