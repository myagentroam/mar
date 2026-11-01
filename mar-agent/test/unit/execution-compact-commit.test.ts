import { describe, expect, it, vi } from 'vitest';
import { commitExecutionCompaction } from '../../src/sdk/execution-compact-commit.js';
import type { SessionRecord } from '../../src/session/record-contract.js';
import type { SessionModelMessage } from '../../src/session/model-request.js';
import type { SessionStoreCompactInput } from '../../src/session/store/contracts.js';

function thinking(
  index: number,
  provider: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES'
): SessionModelMessage {
  return {
    role: 'provider',
    content: '',
    provider,
    providerModelId: 'model',
    ...(provider === 'ANTHROPIC_MESSAGES' ? { contextKind: 'private' as const } : {}),
    item:
      provider === 'OPENAI_RESPONSES'
        ? { type: 'reasoning', id: `reason-${index}`, encrypted_content: `opaque-${index}` }
        : { type: 'thinking', thinking: '', signature: `signed-${index}` }
  };
}

async function commitMessages(
  messages: SessionModelMessage[],
  snapshotLength: number,
  protocol: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES' = 'OPENAI_RESPONSES',
  messageSources = new WeakMap<SessionModelMessage, SessionRecord>()
) {
  const compact = vi.fn(
    async (_sessionId: string, input: SessionStoreCompactInput) =>
      ({
        recordId: 'checkpoint',
        sessionId: 'session',
        sequence: 1,
        timestamp: 'now',
        type: 'compact.completed',
        payload: input
      }) satisfies SessionRecord
  );
  const replace = vi.fn();
  const result = await commitExecutionCompaction({
    store: { compact },
    sessionId: 'session',
    signal: new AbortController().signal,
    prefix: messages.slice(0, snapshotLength),
    messages,
    model: { id: 'model', protocol },
    generation: 'generation',
    messageSources,
    draft: () => ({ summary: 'summary' }),
    checkpoint: () => ({ version: 1 }),
    withProjection: (action) => action(),
    currentGeneration: () => 'generation',
    recordCommit: () => {},
    replace
  });
  return { result, compact, replace };
}

describe('execution compact commit', () => {
  for (const protocol of ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const) {
    it.each([0, 1, 2, 3, 5])(
      `only fills the missing complete blocks behind an async tail with %s blocks (${protocol})`,
      async (count) => {
        const prefix: SessionModelMessage[] = Array.from({ length: 4 }, (_, index) => [
          { role: 'user' as const, content: `phase-${index}` },
          thinking(index, protocol),
          { role: 'assistant' as const, content: `answer-${index}` }
        ]).flat();
        const tail: SessionModelMessage[] =
          count === 0
            ? []
            : [
                { role: 'user', content: 'live input' },
                ...Array.from({ length: count }, (_, index) => thinking(index + 10, protocol)),
                { role: 'assistant', content: 'live answer' }
              ];
        const messages = [...prefix, ...tail];
        const start = count >= 3 ? prefix.length : (4 - (3 - count)) * 3 + 1;
        const { result, compact, replace } = await commitMessages(
          messages,
          prefix.length,
          protocol
        );
        expect(result?.retained).toEqual(messages.slice(start));
        expect(compact.mock.calls[0]?.[1].retainedModelContext).toEqual(messages.slice(start));
        expect(replace).toHaveBeenCalledWith(messages.slice(start));
      }
    );
  }

  it('keeps all existing blocks when fewer than three exist and leaves no-thinking histories unchanged', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      thinking(0, 'OPENAI_RESPONSES'),
      { role: 'user', content: 'later' },
      thinking(1, 'OPENAI_RESPONSES')
    ];
    expect((await commitMessages(messages, messages.length)).result?.retained).toEqual(
      messages.slice(1)
    );
    const plain: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'done' }
    ];
    expect((await commitMessages(plain, plain.length)).result?.retained).toEqual([]);
  });

  it('does not inspect the old prefix once the live suffix already has three blocks', async () => {
    const old: SessionModelMessage = {
      get role(): 'user' {
        throw new Error('The closed old prefix need not be inspected.');
      },
      content: 'old'
    };
    const messages = [
      old,
      thinking(1, 'OPENAI_RESPONSES'),
      thinking(2, 'OPENAI_RESPONSES'),
      thinking(3, 'OPENAI_RESPONSES')
    ];
    expect((await commitMessages(messages, 1)).result?.retained).toEqual(messages.slice(1));
  });

  it('does not count foreign-model or foreign-protocol items toward the three blocks', async () => {
    const prefix: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      thinking(0, 'OPENAI_RESPONSES'),
      { role: 'user', content: 'later' },
      thinking(1, 'OPENAI_RESPONSES'),
      { role: 'user', content: 'latest' },
      thinking(2, 'OPENAI_RESPONSES')
    ];
    const tail = [
      { ...thinking(3, 'OPENAI_RESPONSES'), providerModelId: 'other-model' },
      thinking(4, 'ANTHROPIC_MESSAGES'),
      thinking(5, 'ANTHROPIC_MESSAGES')
    ];
    expect((await commitMessages([...prefix, ...tail], prefix.length)).result?.retained).toEqual([
      ...prefix.slice(1),
      ...tail
    ]);
  });

  it('retains the whole assistant response and a tool call preceding the oldest protected block', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'function_call', call_id: 'read' }
      },
      { role: 'tool_call', content: '', callId: 'read', name: 'read', arguments: {} },
      { role: 'assistant', content: 'before thinking' },
      thinking(0, 'OPENAI_RESPONSES'),
      thinking(1, 'OPENAI_RESPONSES'),
      thinking(2, 'OPENAI_RESPONSES'),
      { role: 'tool', content: 'evidence', callId: 'read' }
    ];
    expect((await commitMessages(messages, messages.length)).result?.retained).toEqual(
      messages.slice(1)
    );
  });

  it('extends across a user input when a retained result depends on an earlier native call', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'old' },
      thinking(0, 'OPENAI_RESPONSES'),
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        item: { type: 'custom_tool_call', call_id: 'patch' }
      },
      { role: 'user', content: 'steer' },
      thinking(1, 'OPENAI_RESPONSES'),
      { role: 'user', content: 'phase two' },
      thinking(2, 'OPENAI_RESPONSES'),
      { role: 'user', content: 'phase three' },
      thinking(3, 'OPENAI_RESPONSES'),
      { role: 'tool', content: 'applied', callId: 'patch' }
    ];
    expect((await commitMessages(messages, messages.length)).result?.retained).toEqual(
      messages.slice(1)
    );
  });

  it('does not submit a checkpoint when the protected tail leaves no replaceable prefix', async () => {
    const messages = [
      thinking(0, 'OPENAI_RESPONSES'),
      thinking(1, 'OPENAI_RESPONSES'),
      thinking(2, 'OPENAI_RESPONSES')
    ];
    const { result, compact, replace } = await commitMessages(messages, messages.length);
    expect(result).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps distinct native items when carrying a previous checkpoint tail again', async () => {
    const messages: SessionModelMessage[] = [
      { role: 'user', content: 'previous summary', contextKind: 'summary' },
      thinking(1, 'OPENAI_RESPONSES'),
      thinking(2, 'OPENAI_RESPONSES'),
      thinking(3, 'OPENAI_RESPONSES')
    ];
    const previous = {
      type: 'compact.completed',
      payload: { retainedModelContext: messages.slice(1) }
    } as unknown as SessionRecord;
    const sources = new WeakMap(messages.map((message) => [message, previous] as const));
    const { result, compact } = await commitMessages(
      messages,
      messages.length,
      'OPENAI_RESPONSES',
      sources
    );
    expect(result!.retained).toEqual(messages.slice(1));
    expect(compact.mock.calls[0]?.[1].retainedModelContext).toEqual(messages.slice(1));
  });

  it('records a durable checkpoint before a projection failure and preserves the failure', async () => {
    const messages: SessionModelMessage[] = [{ role: 'user', content: 'old' }];
    const failure = new Error('projection failed');
    const order: string[] = [];
    const compact = vi.fn(async () => {
      order.push('commit');
      return {
        recordId: 'checkpoint',
        sessionId: 'session',
        sequence: 1,
        timestamp: 'now',
        type: 'compact.completed',
        payload: {}
      } satisfies SessionRecord;
    });
    await expect(
      commitExecutionCompaction({
        store: { compact },
        sessionId: 'session',
        signal: new AbortController().signal,
        prefix: [...messages],
        messages,
        model: { id: 'model', protocol: 'OPENAI_RESPONSES' },
        generation: 'generation',
        messageSources: new WeakMap(),
        draft: () => ({ summary: 'summary' }),
        checkpoint: () => ({ version: 1 }),
        withProjection: (action) => action(),
        currentGeneration: () => 'generation',
        recordCommit: (id) => {
          order.push(id);
        },
        replace: () => {
          order.push('projection');
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(order).toEqual(['commit', 'checkpoint', 'projection']);
    expect(compact).toHaveBeenCalledOnce();
  });
});
