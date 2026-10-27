import { describe, expect, it, vi } from 'vitest';
import { commitExecutionCompaction } from '../../src/sdk/execution-compact-commit.js';
import type { SessionRecord } from '../../src/session/record-contract.js';
import type { SessionModelMessage } from '../../src/session/model-request.js';

describe('execution compact commit', () => {
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
