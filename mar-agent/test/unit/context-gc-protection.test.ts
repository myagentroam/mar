import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/session/store/index.js';
import {
  countSuccessfulNormalRollouts,
  successfulRolloutsAfter
} from '../../src/runtime/context/gc-candidates.js';
import {
  buildContextGcProtection,
  contextGcProtectionMature
} from '../../src/session/context-gc-protection.js';

function fixture() {
  const records: SessionRecord[] = [];
  const add = (type: string, payload: unknown) => {
    const sequence = records.length + 1;
    records.push({
      recordId: `r${sequence}`,
      sequence,
      timestamp: '',
      sessionId: 's',
      executionId: 'e',
      turnId: 't',
      type,
      payload
    });
    return sequence;
  };
  add('execution.header', { modelId: 'm', contextWindowTokens: 10000 });
  const attempt = (state: string, purpose = 'EXECUTION') =>
    add('model.attempt', { purpose, state });
  const item = (provider: string, value: unknown) =>
    add('model.context', { role: 'provider', provider, providerModelId: 'm', item: value });
  return { records, add, attempt, item };
}

describe('GC protection evidence', () => {
  it.each([
    { modelId: 'other', contextWindowTokens: 10000 },
    { modelId: 'm', contextWindowTokens: 20000 }
  ])('preserves Compact configuration when counting rollouts after a switch: %j', (next) => {
    const f = fixture();
    const compact = f.add('compact.completed', { modelId: 'm', contextWindowTokens: 10000 });
    const anchor = f.add('model.context', { role: 'tool', content: 'retained target' });
    f.attempt('SUCCEEDED');
    f.add('execution.header', next);
    f.attempt('FAILED');
    f.attempt('SUCCEEDED', 'COMPACTION');
    f.attempt('SUCCEEDED');
    const records = f.records.filter((record) => record.sequence >= compact);
    expect(countSuccessfulNormalRollouts(records, next.modelId, next.contextWindowTokens)).toBe(1);
    expect(successfulRolloutsAfter(records, anchor, next.modelId, next.contextWindowTokens)).toBe(
      1
    );
    expect(countSuccessfulNormalRollouts(records, 'm', 10000)).toBe(1);
  });

  it.each([
    { modelId: 'other', contextWindowTokens: 10000 },
    { modelId: 'm', contextWindowTokens: 20000 }
  ])('keeps Compact-era text protection scoped to its original configuration: %j', (next) => {
    const f = fixture();
    const compact = f.add('compact.completed', { modelId: 'm', contextWindowTokens: 10000 });
    for (let i = 0; i < 10; i++) {
      f.attempt('STARTED');
      f.attempt('SUCCEEDED');
    }
    const header = f.add('execution.header', next);
    f.attempt('STARTED');
    f.attempt('SUCCEEDED');
    const records = f.records
      .filter((record) => record.sequence >= compact)
      .map((record) => {
        const { executionId, ...rest } = record;
        return record.type === 'compact.completed'
          ? rest
          : { ...rest, executionId: record.sequence >= header ? 'next' : executionId };
      });
    const current = buildContextGcProtection(records, next.modelId, next.contextWindowTokens);
    expect(current.after(compact)).toBe(1);
    expect(contextGcProtectionMature(current.after(compact))).toBe(false);
    const previous = buildContextGcProtection(records, 'm', 10000);
    expect(previous.after(compact)).toBe(10);
    expect(contextGcProtectionMature(previous.after(compact))).toBe(true);
  });

  it('matures after ten successful normal requests even without thinking blocks', () => {
    const f = fixture();
    f.attempt('STARTED');
    const anchor = f.add('model.context', { role: 'tool', content: 'target' });
    // Finishing after the anchor is not enough: the request must start after it.
    f.attempt('SUCCEEDED');
    for (let i = 0; i < 9; i++) {
      f.attempt('STARTED');
      f.attempt('SUCCEEDED');
    }
    f.attempt('STARTED');
    f.item('OPENAI_RESPONSES', { type: 'reasoning', id: 'in-failed-attempt' });
    f.attempt('FAILED');
    f.attempt('STARTED', 'COMPACTION');
    f.attempt('SUCCEEDED', 'COMPACTION');
    f.attempt('STARTED');
    const before = buildContextGcProtection(f.records, 'm', 10000).after(anchor);
    expect(before).toBe(9);
    expect(contextGcProtectionMature(before)).toBe(false);
    f.attempt('SUCCEEDED');
    const after = buildContextGcProtection(f.records, 'm', 10000).after(anchor);
    expect(after).toBe(10);
    expect(contextGcProtectionMature(after)).toBe(true);
  });

  it('does not let concurrent compaction replace or finish an execution attempt', () => {
    const f = fixture();
    const anchor = f.add('model.context', { role: 'tool', content: 'target' });
    f.attempt('STARTED');
    f.attempt('STARTED', 'COMPACTION');
    f.attempt('SUCCEEDED', 'COMPACTION');
    expect(buildContextGcProtection(f.records, 'm', 10000).after(anchor)).toBe(0);
    f.attempt('SUCCEEDED');
    expect(buildContextGcProtection(f.records, 'm', 10000).after(anchor)).toBe(1);
  });
});
