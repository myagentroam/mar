import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/session/store/index.js';
import { buildContextGcProtection } from '../../src/session/context-gc-protection.js';

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
