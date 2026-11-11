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
    f.attempt('SUCCEEDED', 'COMPACT');
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
      if (i < 3) f.item('OPENAI_RESPONSES', { type: 'reasoning', id: `old-${i}` });
      f.attempt('SUCCEEDED');
    }
    const header = f.add('execution.header', next);
    f.attempt('STARTED');
    for (let i = 0; i < 3; i++)
      f.add('model.context', {
        role: 'provider',
        provider: 'OPENAI_RESPONSES',
        providerModelId: next.modelId,
        item: { type: 'reasoning', id: `new-${i}` }
      });
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
    expect(current.after(compact)).toEqual({ rollouts: 1, thinking: 3 });
    expect(contextGcProtectionMature(current.after(compact))).toBe(false);
    const previous = buildContextGcProtection(records, 'm', 10000);
    expect(previous.after(compact)).toEqual({ rollouts: 10, thinking: 3 });
    expect(contextGcProtectionMature(previous.after(compact))).toBe(true);
  });

  it('requires ten successful rollouts and three independent complete blocks', () => {
    expect(contextGcProtectionMature({ rollouts: 9, thinking: 30 })).toBe(false);
    expect(contextGcProtectionMature({ rollouts: 10, thinking: 2 })).toBe(false);
    expect(contextGcProtectionMature({ rollouts: 10, thinking: 3 })).toBe(true);
    expect(contextGcProtectionMature({ rollouts: 6, thinking: 3 })).toBe(false);
  });
  it.each([
    ['OPENAI_RESPONSES', { type: 'reasoning', id: 'native' }],
    ['ANTHROPIC_MESSAGES', { type: 'thinking' }],
    ['ANTHROPIC_MESSAGES', { type: 'redacted_thinking' }]
  ] as const)(
    'counts persisted complete %s %s items without inspecting their payload',
    (provider, item) => {
      const f = fixture();
      f.attempt('STARTED');
      f.item(provider, {
        ...item,
        get thinking() {
          throw new Error('GC must not inspect thinking content');
        },
        get signature() {
          throw new Error('GC must not inspect signatures');
        },
        get data() {
          throw new Error('GC must not inspect redacted content');
        },
        get encrypted_content() {
          throw new Error('GC must not inspect encrypted content');
        }
      });
      f.attempt('SUCCEEDED');
      expect(buildContextGcProtection(f.records, 'm', 10000).after(0)).toEqual({
        rollouts: 1,
        thinking: 1
      });
    }
  );

  it('does not let concurrent compaction replace or finish an execution attempt', () => {
    const f = fixture();
    const anchor = f.add('model.context', { role: 'tool', content: 'target' });
    f.attempt('STARTED');
    f.attempt('STARTED', 'COMPACTION');
    f.attempt('SUCCEEDED', 'COMPACTION');
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'native',
      encrypted_content: 'opaque',
      summary: []
    });
    f.attempt('SUCCEEDED');
    expect(buildContextGcProtection(f.records, 'm', 10000).after(anchor)).toEqual({
      rollouts: 1,
      thinking: 1
    });
  });
  it('counts only persisted complete native items, deduplicated within failed attempts', () => {
    const f = fixture();
    const anchor = f.add('model.context', { role: 'tool', content: 'target' });
    f.attempt('STARTED');
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'one',
      encrypted_content: 'opaque',
      summary: []
    });
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'one',
      encrypted_content: 'opaque',
      summary: []
    });
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'two',
      encrypted_content: 'opaque',
      summary: []
    });
    f.add('reasoning.completed', { kind: 'summary', text: 'not a native item' });
    f.add('reasoning.delta', { text: 'partial' });
    f.add('usage.updated', { inputTokens: 1 });
    f.attempt('FAILED');
    expect(buildContextGcProtection(f.records, 'm', 10000).after(anchor)).toEqual({
      rollouts: 0,
      thinking: 2
    });
  });
  it('keeps rollout and complete-block thresholds independent and ignores partial blocks', () => {
    const { records: values, add, attempt } = fixture();
    for (let i = 0; i < 6; i++) {
      attempt('STARTED');
      if (i < 2)
        add('model.context', {
          role: 'provider',
          provider: 'ANTHROPIC_MESSAGES',
          providerModelId: 'm',
          item: { type: 'thinking', thinking: 'private', signature: `s${i}` }
        });
      if (i === 2) add('reasoning.delta', { text: 'partial' });
      attempt('SUCCEEDED');
    }
    let index = buildContextGcProtection(values, 'm', 10000);
    expect(index.after(0)).toEqual({ rollouts: 6, thinking: 2 });
    const beforeLastRequest = values[values.length - 2]!.sequence;
    expect(index.after(beforeLastRequest)).toEqual({ rollouts: 0, thinking: 0 });
    attempt('STARTED');
    add('model.context', {
      role: 'provider',
      provider: 'ANTHROPIC_MESSAGES',
      providerModelId: 'm',
      item: { type: 'redacted_thinking', data: 'opaque' }
    });
    attempt('FAILED');
    index = buildContextGcProtection(values, 'm', 10000);
    expect(index.after(0)).toEqual({ rollouts: 6, thinking: 3 });
  });

  it('counts successful requests and independent complete native blocks after their common anchor', () => {
    const f = fixture();
    const anchor = f.add('model.context', { role: 'tool', content: 'target' });
    f.attempt('STARTED');
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'a',
      encrypted_content: 'opaque',
      summary: []
    });
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'a',
      encrypted_content: 'opaque',
      summary: []
    });
    f.item('OPENAI_RESPONSES', {
      type: 'reasoning',
      id: 'b',
      encrypted_content: 'opaque',
      summary: []
    });
    f.item('ANTHROPIC_MESSAGES', { type: 'redacted_thinking', data: 'opaque' });
    f.attempt('FAILED');
    for (let i = 0; i < 6; i++) {
      f.attempt('STARTED');
      f.attempt('SUCCEEDED');
    }
    const protection = buildContextGcProtection(f.records, 'm', 10000);
    expect(protection.after(anchor)).toEqual({ rollouts: 6, thinking: 3 });
    expect(protection.after(anchor + 1)).toEqual({ rollouts: 6, thinking: 0 });
  });
});
