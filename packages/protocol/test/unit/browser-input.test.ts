import { describe, expect, it } from 'vitest';
import { browserPageInputSchema } from '../../src/index.js';

describe('Browser page input wire format', () => {
  it('preserves committed text separately from key transitions', () => {
    const text = { type: 'text', viewVersion: 1, text: '你好' };
    const key = { type: 'key', viewVersion: 1, edge: 'down', key: 'ArrowDown' };
    expect(browserPageInputSchema.parse(text)).toEqual(text);
    expect(browserPageInputSchema.parse(key)).toEqual(key);
    expect(browserPageInputSchema.safeParse({ ...text, viewVersion: 0 }).success).toBe(false);
  });

  it('rejects unbounded pointer input and commands outside the allowlist', () => {
    expect(browserPageInputSchema.safeParse({ type: 'evaluate', viewVersion: 1 }).success).toBe(
      false
    );
    expect(
      browserPageInputSchema.safeParse({ type: 'move', viewVersion: 1, x: 2, y: Infinity }).success
    ).toBe(false);
    expect(
      browserPageInputSchema.safeParse({
        type: 'button',
        viewVersion: 1,
        button: 'left',
        edge: 'up',
        x: 0,
        y: 0,
        url: 'https://example.test'
      }).success
    ).toBe(false);
  });
});
