import { describe, expect, it } from 'vitest';
import { secretEnvironment, supportsSecretEnvironment } from '../../src/secret-environment.js';

describe('shared process secret environment', () => {
  it('applies ordered overrides and checks final effective limits', () => {
    expect(
      secretEnvironment([
        ['TOKEN', 'node'],
        ['TOKEN', 'personal']
      ])
    ).toEqual({ TOKEN: 'personal' });
    expect(Object.hasOwn(secretEnvironment([['__proto__', 'literal-value']]), '__proto__')).toBe(
      true
    );
    expect(() =>
      secretEnvironment(Array.from({ length: 129 }, (_, i) => [`KEY_${i}`, 'value'] as const))
    ).toThrow('SECRET_ENVIRONMENT_LIMIT_EXCEEDED');
    expect(() => secretEnvironment([['KEY', 'x'.repeat(65536)]])).toThrow(
      'SECRET_ENVIRONMENT_LIMIT_EXCEEDED'
    );
  });
  it('requires a known stable Node version supporting environment injection', () => {
    for (const version of ['0.1.4', '0.9.63', '1.0.0'])
      expect(supportsSecretEnvironment(JSON.stringify({ nodeAppVersion: version }))).toBe(true);
    for (const metadata of [
      undefined,
      '{}',
      '{',
      '{"nodeAppVersion":"0.1.3"}',
      '{"nodeAppVersion":"1.0.0-beta"}'
    ])
      expect(supportsSecretEnvironment(metadata)).toBe(false);
  });
});
