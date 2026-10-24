import { describe, expect, it } from 'vitest';
import { PromptPredictionAttentionService } from '../../src/service/prompt-prediction-attention-service.js';

describe('Page-local prediction attention', () => {
  it('deduplicates, bounds and expires observations without renewing them on reads', () => {
    let now = 1000;
    const service = new PromptPredictionAttentionService(() => now);
    for (let i = 0; i < 30; i++) service.record('workspace', { kind: 'FILE', path: `${i}` });
    expect(service.snapshot('workspace')).toHaveLength(20);
    service.record('workspace', { kind: 'FILE', path: '29' });
    expect(service.snapshot('workspace')).toHaveLength(20);
    now += 179999;
    expect(service.snapshot('workspace')).toHaveLength(20);
    now++;
    expect(service.snapshot('workspace')).toEqual([]);
  });
  it('isolates resource scopes and clears on opt-out', () => {
    const service = new PromptPredictionAttentionService();
    service.record('a', { kind: 'DIFF', path: 'a' });
    expect(service.snapshot('b')).toEqual([]);
    service.clear();
    expect(service.snapshot('a')).toEqual([]);
  });
});
