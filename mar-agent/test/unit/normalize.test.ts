import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../../src/agent-core/model/contracts.js';
import { normalizeMessagesForModel } from '../../src/agent-core/runtime/context/normalize.js';

const image = { mimeType: 'image/png', dataBase64: 'AAAA' };

describe('normalizeMessagesForModel', () => {
  it('moves interleaved user notes behind complete tool results without changing stored history', () => {
    const messages: ModelMessage[] = [
      { role: 'tool_call', content: '', callId: 'a', name: 'read' },
      { role: 'tool_call', content: '', callId: 'b', name: 'read' },
      { role: 'user', content: 'note one' },
      { role: 'tool', content: 'a result', callId: 'a' },
      { role: 'user', content: 'note two' },
      { role: 'tool', content: 'b result', callId: 'b' }
    ];
    const result = normalizeMessagesForModel(messages, { supportsImages: false });
    expect(result.map((message) => message.content)).toEqual([
      '',
      '',
      'a result',
      'b result',
      'note one',
      'note two'
    ]);
    expect(messages[2]!.content).toBe('note one');
  });

  it('synthesizes a placeholder result for an orphaned tool_call', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool_call', content: '', callId: 'orphan-1', name: 'read' }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    const placeholder = normalized.findLast((message) => message.role === 'tool');
    expect(placeholder).toMatchObject({ role: 'tool', callId: 'orphan-1' });
    expect(placeholder?.content).toContain('orphan-1');
    expect(placeholder?.content).toContain('interrupted');
    // The placeholder is model-visible only and never mutates the source history.
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('synthesizes a placeholder for orphaned provider function and custom tool calls', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'function_call', call_id: 'fc-1', name: 'read' }
      },
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'custom_tool_call', call_id: 'cc-1', name: 'apply_patch' }
      }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    const placeholders = normalized.filter((message) => message.role === 'tool');
    expect(placeholders.map((message) => message.callId)).toEqual(['fc-1', 'cc-1']);
    expect(placeholders.every((message) => message.content.includes('interrupted'))).toBe(true);
  });

  it('leaves answered calls untouched and never duplicates a placeholder', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool_call', content: '', callId: 'done-1', name: 'read' },
      { role: 'tool', content: 'result-1', callId: 'done-1' }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    expect(normalized).toHaveLength(3);
    expect(normalized.filter((message) => message.callId === 'done-1')).toHaveLength(2);
    expect(
      normalized.filter((message) => message.role === 'tool' && message.callId === 'done-1')
    ).toHaveLength(1);
  });

  it('does not synthesize a placeholder when the result precedes the call', () => {
    const messages: ModelMessage[] = [
      { role: 'tool', content: 'result', callId: 'ahead-1' },
      { role: 'tool_call', content: '', callId: 'ahead-1', name: 'read' }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    expect(normalized).toHaveLength(2);
    expect(normalized.filter((message) => message.callId === 'ahead-1')).toHaveLength(2);
  });

  it('ignores provider items without a call id', () => {
    const messages: ModelMessage[] = [
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'function_call', name: 'read' }
      },
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'reasoning', id: 'r-1' }
      }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    expect(normalized).toHaveLength(2);
    expect(normalized.some((message) => message.role === 'tool')).toBe(false);
  });

  it('strips unsupported images without mutating the source message', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'see', images: [image] },
      { role: 'tool', content: 'viewed', callId: 'c', images: [image] },
      { role: 'user', content: 'no image' }
    ];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: false });
    expect(normalized[0]).not.toHaveProperty('images');
    expect(normalized[1]).not.toHaveProperty('images');
    expect(normalized[2]).not.toHaveProperty('images');
    expect(normalized[0]).toMatchObject({ role: 'user', content: 'see' });
    // Stripping only shapes the model request; the source history keeps the images.
    expect(messages[0]?.images).toEqual([image]);
    expect(messages[1]?.images).toEqual([image]);
  });

  it('preserves images when the model supports image input', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'see', images: [image] }];
    const normalized = normalizeMessagesForModel(messages, { supportsImages: true });
    expect(normalized[0]?.images).toEqual([image]);
  });
});
