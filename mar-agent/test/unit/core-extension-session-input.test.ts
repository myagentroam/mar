import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  SessionInputCoordinator,
  type CoreSessionAction
} from '../../src/agent-core/extensions/session-input.js';
import type { CoreOperationContext } from '../../src/agent-core/extensions/operation.js';

const source = (signal = new AbortController().signal): CoreOperationContext => ({
  operationId: 'operation',
  sessionId: 'session',
  sessionEpoch: 1,
  ownerInstanceId: 'owner',
  extensionId: 'extension',
  executionId: 'old-execution',
  turnId: 'old-turn',
  actor: 'extension',
  entry: 'native-api',
  signal
});
const action: CoreSessionAction = (request, call, next) => next(request, call);

describe('Session input coordination', () => {
  it('commits immediate records without consuming or reordering the default FIFO', async () => {
    const inputs = new SessionInputCoordinator();
    const seen: string[] = [];
    for (const content of ['first', 'second'])
      inputs.accept({ kind: 'append', input: { content } }, source(), action, 'queued');
    const leaf = async (_entry: unknown, request: Parameters<CoreSessionAction>[0]) => {
      if (request.kind !== 'append') throw new Error('Unexpected request');
      seen.push(request.input.content);
      return { changed: true, recordId: request.input.content };
    };
    expect(
      await inputs.performAppend(
        { content: 'immediate', delivery: 'immediate' },
        source(),
        action,
        leaf
      )
    ).toMatchObject({ status: 'committed', recordId: 'immediate' });
    expect(seen).toEqual(['immediate']);
    await inputs.drain(leaf);
    expect(seen).toEqual(['immediate', 'first', 'second']);
  });

  it('joins physical immediate work on idle and retirement without accepting later writes', async () => {
    const inputs = new SessionInputCoordinator();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = inputs.performAppend(
      { content: 'note', delivery: 'immediate' },
      source(),
      action,
      async () => {
        started.resolve();
        await release.promise;
        return { changed: true, recordId: 'stored' };
      }
    );
    await started.promise;
    let idle = false,
      retired = false;
    const waiting = inputs.idle().then(() => {
      idle = true;
    });
    const retiring = inputs.retire().then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect([idle, retired]).toEqual([false, false]);
    release.resolve();
    expect(await pending).toMatchObject({ status: 'committed', recordId: 'stored' });
    await Promise.all([waiting, retiring]);
    await expect(
      inputs.performAppend(
        { content: 'late', delivery: 'immediate' },
        source(),
        action,
        async () => ({ changed: true })
      )
    ).rejects.toThrow();
  });

  it('reports handled and failed immediate attempts without inventing record identities', async () => {
    const inputs = new SessionInputCoordinator();
    let writes = 0;
    const leaf = async () => {
      writes++;
      throw new Error('writer failed');
    };
    expect(
      await inputs.performAppend(
        { content: 'handled' },
        source(),
        async () => ({ changed: false }),
        leaf
      )
    ).toMatchObject({ status: 'handled' });
    const failed = await inputs.performAppend({ content: 'failed' }, source(), action, leaf);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'MAR_AGENT_SESSION_INPUT_FAILED' });
    expect(failed.recordId).toBeUndefined();
    expect(writes).toBe(1);
  });

  it('keeps an immediate physical commit when its Hook fails or is cancelled afterwards', async () => {
    for (const cancel of [false, true]) {
      const inputs = new SessionInputCoordinator();
      const controller = new AbortController();
      const receipt = await inputs.performAppend(
        { content: 'note' },
        source(controller.signal),
        async (request, call, next) => {
          await next(request, call);
          if (cancel) controller.abort();
          throw new Error('after commit');
        },
        async () => ({ changed: true, recordId: 'physical-record' })
      );
      expect(receipt).toMatchObject({
        status: cancel ? 'cancelled' : 'failed',
        changed: true,
        recordId: 'physical-record'
      });
    }
  });

  it('keeps notice-only model change facts when middleware wraps the committed result', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept(
      { kind: 'append', input: { content: 'notice', visibility: 'transcript' } },
      source(),
      async (request, call, next) => {
        await next(request, call);
        return { changed: true, recordId: 'not-the-writer' };
      },
      'queued'
    );
    expect(
      await inputs.drain(async () => ({
        changed: true,
        modelChanged: false,
        recordId: 'stored-notice'
      }))
    ).toBe(false);
    expect(inputs.inspect()[0]).toMatchObject({
      status: 'committed',
      changed: true,
      recordId: 'stored-notice'
    });
  });

  it('bounds committed append receipts without evicting a live submitted execution', async () => {
    const inputs = new SessionInputCoordinator();
    const submit = inputs.accept(
      { kind: 'submit', input: { text: 'running' } },
      source(),
      action,
      'accepted'
    );
    await inputs.drain(async () => ({ changed: true, executionId: 'still-running' }));
    for (let index = 0; index < 220; index++) {
      inputs.accept(
        { kind: 'append', input: { content: `note-${index}` } },
        source(),
        action,
        'queued'
      );
      await inputs.drain(async () => ({ changed: true, recordId: `record-${index}` }));
    }
    const receipts = inputs.inspect();
    expect(receipts).toHaveLength(200);
    expect(receipts[0]).toMatchObject({
      sequence: submit.receipt.sequence,
      kind: 'submit',
      status: 'committed'
    });
    expect(receipts.at(-1)).toHaveProperty('recordId', 'record-219');
    inputs.settleExecution('still-running', 'completed');
    expect(inputs.inspect()[0]).toHaveProperty('status', 'completed');
  });

  it('keeps actual commit facts if a middleware returns a different result', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept(
      { kind: 'append', input: { content: 'actual' } },
      source(),
      async (request, call, next) => {
        await next(request, call);
        return { changed: false, executionId: 'not-the-writer' };
      },
      'queued'
    );
    expect(await inputs.drain(async () => ({ changed: true, executionId: 'writer' }))).toBe(true);
    expect(inputs.inspect()[0]).toMatchObject({
      changed: true,
      executionId: 'writer',
      status: 'committed'
    });
  });

  it('retains compaction commits when the real compact hook fails afterwards', async () => {
    const inputs = new SessionInputCoordinator();
    await expect(
      inputs.performCompact({}, source(), async (commit) => {
        commit({ changed: true, executionId: 'compact-writer' });
        throw new Error('after compact');
      })
    ).rejects.toThrow('after compact');
    expect(inputs.inspect()[0]).toMatchObject({
      status: 'failed',
      changed: true,
      executionId: 'compact-writer'
    });
  });
  it('keeps independent FIFO requests and replaces stale execution identity at dispatch', async () => {
    const inputs = new SessionInputCoordinator();
    const requests = [
      { kind: 'compact', input: { focus: 'first' } },
      { kind: 'append', input: { content: 'middle' } },
      { kind: 'compact', input: { focus: 'last' } }
    ] as const;
    requests.forEach((request) => inputs.accept(request, source(), action, 'queued'));
    const order: string[] = [];
    expect(
      await inputs.drain(
        async (_entry, request, call) => {
          expect(call.executionId).toBe('current');
          expect(call.turnId).toBe('turn');
          order.push(request.kind);
          return { changed: true };
        },
        { executionId: 'current', turnId: 'turn', signal: source().signal }
      )
    ).toBe(true);
    expect(order).toEqual(['compact', 'append', 'compact']);
    expect(inputs.inspect().map((entry) => entry.status)).toEqual([
      'completed',
      'committed',
      'completed'
    ]);
    expect(inputs.inspect().map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it('joins a current drain without waiting on itself, and returns the active compact receipt', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept(
      { kind: 'compact', input: {} },
      source(),
      async (request, call, next) => {
        expect(inputs.currentCompact()?.status).toBe('in-progress');
        expect(await inputs.drain(async () => ({ changed: false }))).toBe(false);
        return next(request, call);
      },
      'queued'
    );
    await inputs.drain(async () => ({ changed: true }));
    expect(inputs.currentCompact()).toBeUndefined();
  });

  it('cancels queued requests and removes abort listeners after terminal dispatch', async () => {
    const inputs = new SessionInputCoordinator();
    const controller = new AbortController();
    const cancelled = inputs.accept(
      { kind: 'append', input: { content: 'cancel' } },
      source(controller.signal),
      action,
      'queued'
    );
    controller.abort();
    await cancelled.terminal;
    const signal = source().signal;
    inputs.accept(
      { kind: 'append', input: { content: 'write' } },
      source(signal),
      action,
      'queued'
    );
    let writes = 0;
    await inputs.drain(async () => {
      writes++;
      return { changed: true };
    });
    expect(writes).toBe(1);
    expect(inputs.inspect()[0]?.status).toBe('cancelled');
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('ignores cancelled heads without letting later boundary input overtake a live idle prompt', async () => {
    const inputs = new SessionInputCoordinator();
    const cancelled = new AbortController();
    inputs.accept(
      { kind: 'submit', input: { text: 'cancelled', delivery: 'idle' } },
      source(cancelled.signal),
      action,
      'accepted'
    );
    cancelled.abort();
    expect(inputs.hasBoundaryPending).toBe(false);
    const idle = new AbortController();
    inputs.accept(
      { kind: 'submit', input: { text: 'idle', delivery: 'idle' } },
      source(idle.signal),
      action,
      'accepted'
    );
    inputs.accept({ kind: 'append', input: { content: 'after' } }, source(), action, 'queued');
    expect(inputs.hasBoundaryPending).toBe(false);
    idle.abort();
    expect(inputs.hasBoundaryPending).toBe(true);
    const written: string[] = [];
    await inputs.drain(async (_entry, request) => {
      written.push(request.kind);
      return { changed: true };
    });
    expect(written).toEqual(['append']);
    expect(inputs.hasBoundaryPending).toBe(false);
  });

  it('retiring an owner cancels pending work without closing other owners', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept({ kind: 'append', input: { content: 'retired' } }, source(), action, 'queued');
    await inputs.retire('owner');
    inputs.accept(
      { kind: 'append', input: { content: 'live' } },
      { ...source(), ownerInstanceId: 'other' },
      action,
      'queued'
    );
    const written: string[] = [];
    await inputs.drain(async (_entry, request, call) => {
      expect(call.executionId).toBeUndefined();
      if (request.kind === 'append') written.push(request.input.content);
      return { changed: true };
    });
    expect(written).toEqual(['live']);
    await inputs.retire();
    expect(() => inputs.accept({ kind: 'compact', input: {} }, source(), action, 'queued')).toThrow(
      /CLOSED/
    );
  });

  it('preserves committed effects when middleware fails after a successful leaf', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept(
      { kind: 'append', input: { content: 'written' } },
      source(),
      async (request, call, next) => {
        await next(request, call);
        throw new Error('post write failure');
      },
      'queued'
    );
    expect(
      await inputs.drain(async () => ({
        changed: true,
        executionId: 'actual',
        recordId: 'actual-row'
      }))
    ).toBe(true);
    expect(inputs.inspect()[0]).toMatchObject({
      status: 'failed',
      changed: true,
      executionId: 'actual',
      recordId: 'actual-row'
    });
  });

  it('retains early execution completion instead of leaving submit committed forever', async () => {
    const inputs = new SessionInputCoordinator();
    inputs.accept({ kind: 'submit', input: { text: 'go' } }, source(), action, 'accepted');
    await inputs.drain(async () => {
      inputs.settleExecution('instant', 'completed');
      return { changed: true, executionId: 'instant' };
    });
    expect(inputs.inspect()[0]).toMatchObject({ status: 'completed', executionId: 'instant' });
  });

  it('rejects malformed kinds and optional attribution without accepting work', () => {
    const inputs = new SessionInputCoordinator();
    for (const request of [
      { kind: 'unknown', input: {} },
      { kind: 'append', input: { content: 'x', attribution: 7 } },
      { kind: 'submit', input: { text: 'x', provenance: [] } },
      { kind: 'submit', input: { text: 'x', modelAttribution: 'plugin' } }
    ]) {
      expect(() => inputs.accept(request as never, source(), action, 'queued')).toThrow(/INVALID/);
    }
    expect(inputs.inspect()).toEqual([]);
  });
});
