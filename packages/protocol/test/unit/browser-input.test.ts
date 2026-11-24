import { describe, expect, it } from 'vitest';
import { browserAttachmentMessageSchema, browserPageInputSchema } from '../../src/index.js';

describe('Browser page input wire format', () => {
  it('accepts odd CSS viewport sizes and rejects invalid dimensions', () => {
    const message = { type: 'viewport.resize', width: 391, height: 655 };
    expect(browserAttachmentMessageSchema.parse(message)).toEqual(message);
    expect(browserAttachmentMessageSchema.safeParse({ ...message, height: 0 }).success).toBe(false);
    expect(browserAttachmentMessageSchema.safeParse({ ...message, width: 100_000 }).success).toBe(
      false
    );
  });

  it('preserves committed text separately from key transitions', () => {
    const text = { type: 'text', viewVersion: 1, text: '你好' };
    const key = { type: 'key', viewVersion: 1, edge: 'down', key: 'ArrowDown' };
    expect(browserPageInputSchema.parse(text)).toEqual(text);
    expect(browserPageInputSchema.parse(key)).toEqual(key);
    expect(browserPageInputSchema.safeParse({ ...text, viewVersion: 0 }).success).toBe(false);
  });

  it('accepts single-contact touch phases and checks the version and CSS coordinates', () => {
    const contact = { type: 'touch', viewVersion: 2, x: 140, y: 82 };
    for (const phase of ['start', 'move', 'end', 'cancel']) {
      expect(browserPageInputSchema.parse({ ...contact, phase })).toEqual({ ...contact, phase });
    }
    expect(browserPageInputSchema.safeParse({ ...contact, phase: 'down' }).success).toBe(false);
    expect(browserPageInputSchema.safeParse({ ...contact, phase: 'move', x: -1 }).success).toBe(
      false
    );
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
