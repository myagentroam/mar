import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '../../src/agent-core/model/contracts.js';
import {
  contextGcMessageTokens,
  contextGcReclaimedTokens
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
