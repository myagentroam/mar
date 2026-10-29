import { expect, it, vi } from 'vitest';
import { createSessionCatalog } from '../../src/session/catalog.js';

it('matches durable input and application by record identity across history pages', async () => {
  const received = {
    type: 'turn.user',
    sessionId: 'session',
    executionId: 'first-execution',
    turnId: 'first-turn',
    recordId: 'first-record',
    sequence: 1,
    timestamp: 'now',
    payload: { prompt: 'private prompt', deferred: true, clientMessageId: 'shared-id' }
  };
  const applied = {
    type: 'model.context',
    sessionId: 'session',
    executionId: 'second-execution',
    turnId: 'second-turn',
    recordId: 'application',
    sequence: 3,
    timestamp: 'now',
    payload: {
      role: 'user',
      content: 'private prompt',
      inputRef: 'first-record',
      input: received.payload
    }
  };
  const other = {
    ...applied,
    recordId: 'other-application',
    sequence: 4,
    payload: { ...applied.payload, inputRef: 'other-record' }
  };
  const readPage = vi.fn(async (_id: string, input: { beforeSequence?: number }) =>
    input.beforeSequence === undefined
      ? { records: [applied, other], previousBeforeSequence: 3 }
      : { records: [received] }
  );
  const catalog = createSessionCatalog({ readPage } as never, true);
  const receipt = await catalog.inputReceipt('session', {
    clientMessageId: 'shared-id',
    executionId: 'first-execution'
  });
  expect(receipt).toEqual({
    clientMessageId: 'shared-id',
    executionId: 'first-execution',
    turnId: 'first-turn',
    status: 'applied',
    appliedExecutionId: 'second-execution',
    appliedTurnId: 'second-turn'
  });
  expect(readPage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(receipt)).not.toContain('private prompt');
  await expect(
    catalog.inputReceipt('session', { executionId: 'second-execution' })
  ).resolves.toEqual(receipt);
  await expect(
    catalog.inputReceipt('session', { executionId: 'first-execution' })
  ).resolves.toEqual(receipt);
  await expect(
    catalog.inputReceipt('session', {
      clientMessageId: 'shared-id',
      executionId: 'other-execution'
    })
  ).resolves.toBeUndefined();
  readPage.mockImplementation(async (_id, input) =>
    input.beforeSequence === undefined
      ? { records: [other], previousBeforeSequence: 3 }
      : { records: [received] }
  );
  await expect(
    catalog.inputReceipt('session', {
      clientMessageId: 'shared-id',
      executionId: 'first-execution'
    })
  ).resolves.toEqual({
    clientMessageId: 'shared-id',
    executionId: 'first-execution',
    turnId: 'first-turn',
    status: 'accepted'
  });
  readPage.mockImplementation(async () => ({
    records: [{ ...received, payload: { prompt: 'private prompt', clientMessageId: 'shared-id' } }]
  }));
  await expect(
    catalog.inputReceipt('session', {
      clientMessageId: 'shared-id',
      executionId: 'first-execution'
    })
  ).resolves.toMatchObject({ status: 'accepted' });
});

it('stops a cold receipt scan when the caller cancels during a history page read', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readPage = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { records: [], previousBeforeSequence: 2 };
  });
  const catalog = createSessionCatalog({ readPage } as never, true);
  const controller = new AbortController();
  const pending = catalog.inputReceipt('session', {
    executionId: 'execution',
    signal: controller.signal
  });
  await entered.promise;
  controller.abort(new Error('cancelled receipt scan'));
  release.resolve();
  await expect(pending).rejects.toThrow('cancelled receipt scan');
  expect(readPage).toHaveBeenCalledTimes(1);
});

it('selects only persisted inputs from the requested operation source', async () => {
  const entry = (sequence: number, clientMessageId: string, source?: object) => ({
    type: 'turn.user',
    sessionId: 'child',
    executionId: 'execution',
    turnId: 'turn',
    recordId: `record-${sequence}`,
    sequence,
    timestamp: 'now',
    payload: { clientMessageId, ...(source ? { source } : {}) }
  });
  const records = [
    entry(1, 'parent-message', { sessionId: 'parent', extensionId: 'subagent', actor: 'model' }),
    entry(2, 'another-client', {
      sessionId: 'parent',
      extensionId: 'consumer',
      actor: 'extension'
    }),
    entry(3, 'user-message'),
    entry(4, 'other-parent', { sessionId: 'other', extensionId: 'subagent', actor: 'model' })
  ];
  const catalog = createSessionCatalog({ readPage: async () => ({ records }) } as never, true);
  const source = { sessionId: 'parent', extensionId: 'subagent', actors: ['model', 'code-mode'] };
  await expect(
    catalog.inputReceipt('child', { executionId: 'execution', source })
  ).resolves.toMatchObject({ clientMessageId: 'parent-message', status: 'accepted' });
  await expect(
    catalog.inputReceipt('child', {
      executionId: 'execution',
      source: { ...source, sessionId: 'unproven' }
    })
  ).resolves.toBeUndefined();
});
