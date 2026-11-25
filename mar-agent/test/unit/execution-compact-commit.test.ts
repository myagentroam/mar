import { describe, expect, it, vi } from 'vitest';
import { commitExecutionCompaction } from '../../src/sdk/execution-compact-commit.js';
import { restoreCompactTail } from '../../src/runtime/compaction/retained-context.js';
import {
  MCP_DISCOVERY_DELIVERED,
  restorePendingMcpDiscovery
} from '../../src/session/mcp-discovery.js';
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
  messageSources = new WeakMap<SessionModelMessage, SessionRecord>(),
  pending = new Map<string, string>()
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
    generation: 'generation',
    messageSources,
    draft: () => ({ summary: 'summary' }),
    checkpoint: () => ({ version: 1 }),
    withProjection: (action) => action(),
    pendingDiscoveryNames: (message) =>
      message.mcpDiscovery?.names.filter(
        (name) => pending.get(name) === message.mcpDiscovery!.id
      ) ?? [],
    currentGeneration: () => 'generation',
    recordCommit: () => {},
    replace
  });
  return { result, compact, replace };
}

describe('execution compact commit', () => {
  it('restores only pending names from a retained receipt and ignores acknowledgements for older receipts', async () => {
    const { result } = await commitMessages(
      [{ role: 'user', content: '', mcpDiscovery: { id: 'current', names: ['one', 'two'] } }],
      1,
      undefined,
      new Map([['two', 'current']])
    );
    expect(result?.retained.flatMap((message) => message.mcpDiscovery?.names ?? [])).toEqual([
      'two'
    ]);
    const checkpoint = result!.record;
    const saved = (checkpoint.payload as SessionStoreCompactInput).retainedModelContext!;
    expect(
      saved.flatMap((message) => restoreCompactTail(message)?.mcpDiscovery?.names ?? [])
    ).toEqual(['two']);
    const delivered = (id: string, sequence: number): SessionRecord => ({
      ...checkpoint,
      recordId: `delivered-${id}`,
      sequence,
      type: MCP_DISCOVERY_DELIVERED,
      payload: { receipts: [{ id, names: ['two'] }] }
    });
    expect(restorePendingMcpDiscovery([checkpoint, delivered('older', 2)])).toEqual(
      new Map([['two', 'current']])
    );
    expect(restorePendingMcpDiscovery([checkpoint, delivered('current', 2)]).size).toBe(0);
  });

  it('retains delivered definitions in the live tail without marking them as pending', async () => {
    const receipt = { id: 'current', names: ['one', 'two'] };
    const { result } = await commitMessages(
      [
        { role: 'user', content: 'old' },
        { role: 'user', content: '', mcpDiscovery: receipt }
      ],
      1,
      undefined,
      new Map([['two', 'current']])
    );
    expect(result?.retained[0]?.mcpDiscovery).toEqual(receipt);
    expect(restorePendingMcpDiscovery([result!.record])).toEqual(new Map([['two', 'current']]));
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'retains the complete live suffix, but no native items in the closed snapshot (%s)',
    async (protocol) => {
      const prefix: SessionModelMessage[] = [
        { role: 'user', content: 'old input' },
        thinking(0, protocol),
        { role: 'assistant', content: 'old answer' }
      ];
      const tail: SessionModelMessage[] = [
        { role: 'user', content: 'live input', contextKind: 'contextual' },
        thinking(1, protocol),
        { role: 'tool_call', content: '', callId: 'read', name: 'read', arguments: {} },
        { role: 'tool', content: 'evidence', callId: 'read' }
      ];
      const { result, compact, replace } = await commitMessages(
        [...prefix, ...tail],
        prefix.length
      );
      expect(result?.retained).toEqual(tail);
      expect(compact.mock.calls[0]?.[1].retainedModelContext?.map(restoreCompactTail)).toEqual(
        tail
      );
      expect(replace).toHaveBeenCalledWith(tail);
    }
  );

  it('preserves live image references durably and keeps bytes only in the live projection', async () => {
    const image = {
      mimeType: 'image/png' as const,
      resourceId: 'resource',
      dataBase64: 'aW1hZ2U='
    };
    const tail: SessionModelMessage[] = [
      { role: 'user', content: 'live input', images: [image] },
      { role: 'tool_call', content: '', callId: 'image', name: 'view_image', arguments: {} },
      { role: 'tool', content: 'image result', callId: 'image', images: [image] }
    ];
    const { result, compact } = await commitMessages(
      [{ role: 'user', content: 'old' }, ...tail],
      1
    );
    expect(result?.retained).toEqual(tail);
    const persisted = compact.mock.calls[0]?.[1].retainedModelContext;
    expect(persisted?.flatMap((message) => message.images ?? [])).toEqual([
      { mimeType: 'image/png', resourceId: 'resource' },
      { mimeType: 'image/png', resourceId: 'resource' }
    ]);
  });

  it('does not submit a checkpoint without a replaceable prefix', async () => {
    const { result, compact, replace } = await commitMessages(
      [{ role: 'user', content: 'live' }],
      0
    );
    expect(result).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
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
        generation: 'generation',
        messageSources: new WeakMap(),
        draft: () => ({ summary: 'summary' }),
        checkpoint: () => ({ version: 1 }),
        withProjection: (action) => action(),
        pendingDiscoveryNames: () => [],
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
