import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '../../src/agent-core/model/contracts.js';
import {
  contextGcMessageTokens,
  contextGcReclaimedTokens,
  contextGcCacheImpact,
  contextGcPrefixTokens
} from '../../src/agent-core/runtime/context/gc-tokens.js';
import * as tokenBudget from '../../src/agent-core/runtime/token-budget.js';

afterEach(() => vi.restoreAllMocks());

describe('GC token estimates', () => {
  const input = {
    modelId: 'coding',
    modelProtocol: 'ANTHROPIC_MESSAGES',
    system: '',
    tools: []
  };

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'uses resource identity, not media byte size, for %s framing and cache boundaries',
    (modelProtocol) => {
      const context = { ...input, modelProtocol };
      const prefix: ModelMessage = { role: 'user', content: 'Stable prefix. '.repeat(100) };
      const image: ModelMessage = {
        role: 'user',
        content: 'Observe.',
        images: [
          {
            mimeType: 'image/png',
            resourceId: 'a'.repeat(64),
            byteSize: 3 * 1_048_576
          }
        ]
      };
      expect(contextGcMessageTokens(context, [image])).toBe(
        contextGcMessageTokens(context, [
          {
            ...image,
            images: [{ ...image.images![0]!, byteSize: 100, dataBase64: 'cGl4ZWxz' }]
          }
        ])
      );
      const before = [prefix, image, { role: 'user' as const, content: 'Retain suffix.' }];
      const after = [prefix, { ...image, images: [] }, before[2]!];
      const cached = contextGcPrefixTokens(context) + contextGcMessageTokens(context, before);
      const impact = contextGcCacheImpact(
        context,
        before,
        after,
        cached,
        contextGcReclaimedTokens(context, before, after)
      );
      expect(impact.preservedCachedPrefixTokens).toBeGreaterThan(0);
      expect(impact.preservedCachedPrefixTokens).toBeLessThan(cached);
    }
  );

  it('uses the shared token estimator for projected entries', () => {
    const expected = tokenBudget.countModelTokens('{"content":"A local estimate.","role":"user"}');
    const count = vi.spyOn(tokenBudget, 'countModelTokens');
    expect(contextGcMessageTokens(input, [{ role: 'user', content: 'A local estimate.' }])).toBe(
      expected
    );
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith('{"content":"A local estimate.","role":"user"}');
  });

  it('does not count unchanged entries during the gross-recovery precheck', () => {
    const stable: ModelMessage = { role: 'user', content: 'Preserve this requirement.' };
    const count = vi.spyOn(tokenBudget, 'countModelTokens');
    expect(contextGcReclaimedTokens(input, [stable, stable], [stable, stable])).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it('matches full differences with duplicate, reordered and unchanged entries', () => {
    const stable: ModelMessage = { role: 'user', content: 'Preserve this requirement.' };
    const old: ModelMessage = { role: 'tool', callId: 'call', content: 'old output '.repeat(500) };
    const replacement = { ...old, content: 'Reclaimed output.' };
    const before = [stable, old, stable];
    const after = [stable, stable, replacement];
    const full = contextGcMessageTokens(input, before) - contextGcMessageTokens(input, after);
    expect(contextGcReclaimedTokens(input, before, after)).toBe(full);
    expect(contextGcReclaimedTokens(input, before, before)).toBe(0);
    expect(contextGcReclaimedTokens(input, after, before)).toBe(0);
  });
});
