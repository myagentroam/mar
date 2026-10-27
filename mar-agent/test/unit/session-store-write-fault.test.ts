import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';
import { LocalAgentHost } from '../../src/host.js';
import {
  SecretValue,
  type Agent,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';

type Fault = 'partial' | 'sync' | 'close' | 'write-close' | 'open';
const io = vi.hoisted(() => ({
  path: '',
  fault: 'partial' as Fault,
  injected: false,
  writes: 0,
  opens: 0,
  indexPath: '',
  indexFailures: 0,
  indexGate: undefined as
    { entered: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> } | undefined,
  historyFault: undefined as
    | {
        primary: Error;
        indexFailed: boolean;
        readFailure?: 'io' | 'missing';
        restoreFailure?: boolean;
        readGate?: { entered: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
        laterCommit?: PromiseWithResolvers<void>;
      }
    | undefined,
  journalCleanupFailure: undefined as Error | undefined,
  failure: Object.assign(new Error('Simulated session disk failure.'), { code: 'ENOSPC' })
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: (async (...args: Parameters<typeof fs.rm>) => {
      if (
        typeof args[0] === 'string' &&
        args[0].endsWith('/storage-transaction.json') &&
        io.journalCleanupFailure
      ) {
        const failure = io.journalCleanupFailure;
        io.journalCleanupFailure = undefined;
        throw failure;
      }
      return fs.rm(...args);
    }) as typeof fs.rm,
    readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      const fault = io.historyFault;
      if (args[0] === io.indexPath && fault?.indexFailed && fault.readGate) {
        const gate = fault.readGate;
        fault.readGate = undefined;
        gate.entered.resolve();
        await gate.resume.promise;
      }
      if (args[0] === io.indexPath && fault?.indexFailed && fault.readFailure) {
        const code = fault.readFailure === 'missing' ? 'ENOENT' : 'EIO';
        fault.readFailure = undefined;
        throw Object.assign(new Error('Secondary index read failed.'), { code });
      }
      return fs.readFile(...args);
    }) as typeof fs.readFile,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const fault = io.historyFault;
      if (args[1] === io.indexPath && fault && !fault.indexFailed) {
        fault.indexFailed = true;
        throw fault.primary;
      }
      if (
        fault?.indexFailed &&
        fault.restoreFailure &&
        typeof args[0] === 'string' &&
        args[0].includes('.clear-backup') &&
        typeof args[1] === 'string' &&
        args[1].endsWith('.jsonl')
      ) {
        fault.restoreFailure = false;
        throw Object.assign(new Error('Secondary segment restore failed.'), { code: 'EIO' });
      }
      if (args[1] === io.indexPath && io.indexGate) {
        const gate = io.indexGate;
        io.indexGate = undefined;
        gate.entered.resolve();
        await gate.resume.promise;
      }
      if (args[1] === io.indexPath && io.injected && io.indexFailures === 0) {
        io.indexFailures++;
        throw Object.assign(new Error('Simulated secondary index persistence failure.'), {
          code: 'EIO'
        });
      }
      const result = await fs.rename(...args);
      if (args[1] === io.indexPath && fault?.indexFailed) fault.laterCommit?.resolve();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== io.path || args[1] !== 'a') return fs.open(...args);
      io.opens++;
      if (io.fault === 'open' && !io.injected) {
        io.injected = true;
        throw io.failure;
      }
      const handle = await fs.open(...args);
      const write = handle.write.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      let partial = false;
      let failed = false;
      handle.write = (async (buffer: Buffer, offset: number, length: number, position?: number) => {
        io.writes++;
        if (!io.injected && (io.fault === 'partial' || io.fault === 'write-close')) {
          if (!partial) {
            partial = true;
            return write(buffer, offset, 13, position);
          }
          io.injected = failed = true;
          throw io.failure;
        }
        return write(buffer, offset, length, position);
      }) as typeof handle.write;
      handle.sync = async () => {
        if (!io.injected && io.fault === 'sync') {
          io.injected = failed = true;
          throw io.failure;
        }
        return sync();
      };
      handle.close = async () => {
        await close();
        if (!io.injected && io.fault === 'close') {
          io.injected = true;
          throw io.failure;
        }
        if (failed && io.fault === 'write-close')
          throw Object.assign(new Error('Simulated secondary close failure.'), { code: 'EIO' });
      };
      return handle;
    }
  };
});

const homes: string[] = [];
const stores: JsonlSessionStore[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  io.indexGate?.resume.resolve();
  io.indexGate = undefined;
  io.historyFault = undefined;
  io.journalCleanupFailure = undefined;
  io.path = '';
  io.indexPath = '';
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function openStore(home: string) {
  const store = await JsonlSessionStore.open(home);
  stores.push(store);
  return store;
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-session-write-fault-'));
  homes.push(home);
  const store = await openStore(home);
  const session = await store.createSession({ workspace: home, title: 'Write fault' });
  const path = join(await activeSessionDirectory(home, session.id), 'events-000001.jsonl');
  return { home, store, session, path };
}

it('keeps a newly opened Store usable when the last close is flushing its index', async () => {
  const { home, store, session } = await fixture();
  await store.append(session.id, { type: 'test.record', payload: { value: 1 } });
  io.indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  const disk = JSON.parse(await readFile(io.indexPath, 'utf8'));
  delete disk.sessions[0].resume.firstUserMessageIndexed;
  await writeFile(io.indexPath, JSON.stringify(disk));
  await store.firstUserMessagePreview(session.id);
  io.injected = false;
  const gate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  io.indexGate = gate;
  const closing = store.close();
  try {
    await gate.entered.promise;
    const reopening = openStore(home);
    gate.resume.resolve();
    await closing;
    const reopened = await reopening;
    const record = await reopened.append(session.id, {
      type: 'test.record',
      payload: { value: 2 }
    });
    expect((await reopened.read(session.id)).at(-1)?.recordId).toBe(record.recordId);
  } finally {
    gate.resume.resolve();
    await closing;
  }
});

it('restores the previous transaction identity after a definitely uncommitted clear', async () => {
  const { home, store, session } = await fixture();
  await store.clearSession(session.id);
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'keep' }, turnId: 't1' });
  const holding = await store.acquireSessionMaintenance(session.id, 'clear');
  const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  const before = JSON.parse(await readFile(indexPath, 'utf8'));
  const previous = before.sessions.find(
    (item: { id: string }) => item.id === session.id
  ).storageTransactionId;
  expect(previous).toEqual(expect.any(String));
  const primary = new Error('Index commit failed.');
  io.indexPath = indexPath;
  io.historyFault = { primary, indexFailed: false };
  try {
    await expect(store.clearSession(session.id, holding)).rejects.toBe(primary);
  } finally {
    io.historyFault = undefined;
    await holding.release();
  }
  const after = JSON.parse(await readFile(indexPath, 'utf8'));
  expect(
    after.sessions.find((item: { id: string }) => item.id === session.id).storageTransactionId
  ).toBe(previous);
  expect((await store.read(session.id)).some((record) => record.turnId === 't1')).toBe(true);
});

it('preserves the original rollback failure and both turns after an uncommitted index write', async () => {
  const { home, store, session } = await fixture();
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'one' }, turnId: 't1' });
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'two' }, turnId: 't2' });
  const primary = new Error('Rollback index commit failed.');
  io.indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  io.historyFault = { primary, indexFailed: false };
  try {
    await expect(store.rollbackSession(session.id, { boundaryTurnId: 't1' })).rejects.toBe(primary);
  } finally {
    io.historyFault = undefined;
  }
  expect(
    (await store.read(session.id))
      .filter((record) => record.type === 'turn.user')
      .map((record) => record.turnId)
  ).toEqual(['t1', 't2']);
});

it.each(['io', 'missing'] as const)(
  'preserves the first failure and prevents writes when transaction outcome is unknown (%s)',
  async (readFailure) => {
    const { home, store, session } = await fixture();
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'keep' },
      turnId: 't1'
    });
    const holding = await store.acquireSessionMaintenance(session.id, 'clear');
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const journal = join(
      await activeSessionDirectory(home, session.id),
      'storage-transaction.json'
    );
    const primary = new Error('Index commit failed.');
    io.indexPath = indexPath;
    io.historyFault = { primary, indexFailed: false, readFailure };
    try {
      await expect(store.clearSession(session.id, holding)).rejects.toBe(primary);
      await expect(store.append(session.id, { type: 'test.blocked', payload: {} })).rejects.toBe(
        primary
      );
      await expect(store.read(session.id)).rejects.toBe(primary);
      await expect(store.readExecutionState(session.id)).rejects.toBe(primary);
      await expect(store.writeContextualWorldState(session.id, { blocked: true })).rejects.toBe(
        primary
      );
      expect(JSON.parse(await readFile(journal, 'utf8')).kind).toBe('clear');
    } finally {
      io.historyFault = undefined;
      await holding.release();
    }
    const release = await store.acquireSessionLease(session.id);
    try {
      expect((await store.read(session.id)).some((record) => record.turnId === 't1')).toBe(true);
      expect((await store.read(session.id)).some((record) => record.type === 'test.blocked')).toBe(
        false
      );
    } finally {
      await release();
    }
  }
);

it('retains the first commit error when segment restoration also fails', async () => {
  const { home, store, session } = await fixture();
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'keep' }, turnId: 't1' });
  const holding = await store.acquireSessionMaintenance(session.id, 'clear');
  const primary = new Error('Index commit failed.');
  io.indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  io.historyFault = { primary, indexFailed: false, restoreFailure: true };
  try {
    await expect(store.clearSession(session.id, holding)).rejects.toBe(primary);
    await expect(store.append(session.id, { type: 'test.blocked', payload: {} })).rejects.toBe(
      primary
    );
  } finally {
    io.historyFault = undefined;
    await holding.release();
  }
  const release = await store.acquireSessionLease(session.id);
  try {
    expect((await store.read(session.id)).some((record) => record.turnId === 't1')).toBe(true);
  } finally {
    await release();
  }
});

it('keeps a committed clear after post-commit journal cleanup fails', async () => {
  const { store, session } = await fixture();
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'clear' }, turnId: 't1' });
  const holding = await store.acquireSessionMaintenance(session.id, 'clear');
  const failure = new Error('Journal cleanup failed.');
  io.journalCleanupFailure = failure;
  try {
    await expect(store.clearSession(session.id, holding)).rejects.toBe(failure);
    await expect(store.append(session.id, { type: 'test.blocked', payload: {} })).rejects.toBe(
      failure
    );
    await expect(store.read(session.id)).rejects.toBe(failure);
  } finally {
    io.journalCleanupFailure = undefined;
    await holding.release();
  }
  const release = await store.acquireSessionLease(session.id);
  try {
    expect((await store.read(session.id)).some((record) => record.turnId === 't1')).toBe(false);
    await store.append(session.id, { type: 'test.after-recovery', payload: {} });
  } finally {
    await release();
  }
});

it('does not publish an unconfirmed transaction through another Session index flush', async () => {
  const { home, store, session } = await fixture();
  await store.append(session.id, { type: 'turn.user', payload: { prompt: 'keep' }, turnId: 't1' });
  const other = await store.createSession({ workspace: home });
  const otherLease = await store.acquireSessionLease(other.id);
  await store.append(other.id, { type: 'test.other', payload: { ok: true } });
  const holding = await store.acquireSessionMaintenance(session.id, 'clear');
  const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
  const before = JSON.parse(await readFile(indexPath, 'utf8'));
  const previous = before.sessions.find(
    (item: { id: string }) => item.id === session.id
  ).storageTransactionId;
  const primary = new Error('Index commit failed.');
  const gate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  const laterCommit = Promise.withResolvers<void>();
  io.indexPath = indexPath;
  io.historyFault = { primary, indexFailed: false, readGate: gate, laterCommit };
  const clearing = store.clearSession(session.id, holding);
  let releasing: Promise<void> | undefined;
  try {
    await gate.entered.promise;
    releasing = otherLease();
    await Promise.race([
      laterCommit.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 250))
    ]);
    const during = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(
      during.sessions.find((item: { id: string }) => item.id === session.id).storageTransactionId
    ).toBe(previous);
  } finally {
    gate.resume.resolve();
    await expect(clearing).rejects.toBe(primary);
    await releasing;
    io.historyFault = undefined;
    await holding.release();
  }
  expect((await store.read(session.id)).some((record) => record.turnId === 't1')).toBe(true);
});

function arm(path: string, fault: Fault) {
  Object.assign(io, { path, fault, injected: false, writes: 0, opens: 0 });
  io.failure = Object.assign(new Error(`Simulated ${fault} session disk failure.`), {
    code: 'ENOSPC'
  });
  return io.failure;
}

const input = { type: 'test.record', payload: { value: 'durable' } };

describe('Session writer uncertain append failure', () => {
  it('rejects already queued appends across shared handles, isolates Sessions and recovers on a new lease', async () => {
    const { home, store, session, path } = await fixture();
    const other = await store.createSession({ workspace: home });
    const shared = await openStore(home);
    const release = await store.acquireSessionLease(session.id);
    const before = await readFile(path);
    const error = arm(path, 'partial');
    try {
      const outcomes = await Promise.allSettled([
        store.append(session.id, input),
        shared.append(session.id, input),
        store.append(session.id, input)
      ]);
      expect(outcomes).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error }
      ]);
      expect(io.writes).toBe(2);
      expect(io.opens).toBe(1);
      const damaged = await readFile(path);
      expect(damaged.subarray(0, before.length)).toEqual(before);
      expect(damaged.length).toBe(before.length + 13);
      const releaseOther = await shared.acquireSessionLease(other.id);
      try {
        await expect(shared.append(other.id, input)).resolves.toMatchObject({ sequence: 2 });
      } finally {
        await releaseOther();
      }
    } finally {
      await release();
    }
    const recovered = await shared.acquireSessionLease(session.id);
    try {
      await expect(shared.append(session.id, input)).resolves.toMatchObject({ sequence: 2 });
      expect((await shared.read(session.id)).map((record) => record.sequence)).toEqual([1, 2]);
    } finally {
      await recovered();
    }
  });

  it('keeps the fault through warm Execution release and native write acquisition until every retained reference releases', async () => {
    const { store, session, path } = await fixture();
    const owner = {};
    const release = await store.acquireSessionLease(session.id, owner);
    const retained = await store.retainSessionLease(session.id, owner);
    const native = await store.acquireSessionWriteLease(session.id, owner);
    const error = arm(path, 'partial');
    try {
      await expect(store.append(session.id, input)).rejects.toBe(error);
      await release();
      expect(store.hasRetainedSessionLease(session.id, owner)).toBe(true);
      const damaged = await readFile(path);
      await expect(store.acquireSessionLease(session.id, owner)).rejects.toBe(error);
      await expect(store.acquireSessionWriteLease(session.id, owner)).rejects.toBe(error);
      await expect(store.acquireSessionLease(session.id, {})).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      await retained();
      await expect(store.append(session.id, input)).rejects.toBe(error);
      expect(await readFile(path)).toEqual(damaged);
      expect(io.opens).toBe(1);
    } finally {
      await retained();
      await native();
      await release();
    }
    await expect(readFile(join(dirname(path), 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await store.acquireSessionLease(session.id, owner);
    try {
      await expect(store.append(session.id, input)).resolves.toMatchObject({ sequence: 2 });
    } finally {
      await recovered();
    }
  });

  it('does not poison the writer on serialization or record input validation failure', async () => {
    const { store, session, path } = await fixture();
    const release = await store.acquireSessionLease(session.id);
    try {
      const before = await readFile(path);
      await expect(store.append(session.id, { ...input, payload: 1n })).rejects.toBeInstanceOf(
        TypeError
      );
      const cancelled = new AbortController();
      cancelled.abort(new Error('Cancelled before append admission.'));
      await expect(store.append(session.id, input, { signal: cancelled.signal })).rejects.toBe(
        cancelled.signal.reason
      );
      expect(await readFile(path)).toEqual(before);
      await expect(store.append(session.id, input)).resolves.toMatchObject({ sequence: 2 });
    } finally {
      await release();
    }
  });

  it('does not poison the writer when opening the append handle fails before any write', async () => {
    const { store, session, path } = await fixture();
    const release = await store.acquireSessionLease(session.id);
    const error = arm(path, 'open');
    try {
      await expect(store.append(session.id, input)).rejects.toBe(error);
      await expect(store.append(session.id, input)).resolves.toMatchObject({ sequence: 2 });
      expect(io.writes).toBe(1);
    } finally {
      await release();
    }
  });

  it.each(['sync', 'close'] as const)(
    'preserves a complete record after %s failure and resumes without duplicate sequences after reopening',
    async (fault) => {
      const { home, store, session, path } = await fixture();
      const release = await store.acquireSessionLease(session.id);
      const error = arm(path, fault);
      let committed: Buffer;
      try {
        await expect(store.append(session.id, input)).rejects.toBe(error);
        committed = await readFile(path);
        const records = committed
          .toString()
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(records.map((record) => record.sequence)).toEqual([1, 2]);
        expect(records[1]).toMatchObject(input);
        await expect(store.append(session.id, input)).rejects.toBe(error);
        expect(await readFile(path)).toEqual(committed);
      } finally {
        await release();
      }
      await store.close();
      const reopened = await openStore(home);
      const recovered = await reopened.acquireSessionLease(session.id);
      try {
        expect(await readFile(path)).toEqual(committed!);
        await expect(reopened.append(session.id, input)).resolves.toMatchObject({ sequence: 3 });
        expect((await reopened.read(session.id)).map((record) => record.sequence)).toEqual([
          1, 2, 3
        ]);
      } finally {
        await recovered();
      }
    }
  );

  it('keeps the original write failure when closing the same handle also fails', async () => {
    const { store, session, path } = await fixture();
    const release = await store.acquireSessionLease(session.id);
    const error = arm(path, 'write-close');
    try {
      await expect(store.append(session.id, input)).rejects.toBe(error);
      await expect(store.append(session.id, input)).rejects.toBe(error);
      expect(io.writes).toBe(2);
    } finally {
      await release();
    }
  });

  it.each([
    { cancel: false, indexFault: false },
    { cancel: true, indexFault: false },
    { cancel: false, indexFault: true },
    { cancel: true, indexFault: true }
  ])(
    'settles SDK failure cleanup without publishing an unpersisted terminal (cancel=$cancel, indexFault=$indexFault)',
    async ({ cancel, indexFault }) => {
      const { home, store, session, path } = await fixture();
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const model: AgentModelConfiguration = {
        id: 'fake',
        name: 'Fake',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test/v1',
        apiKey: new SecretValue('unused'),
        modelId: 'fake',
        contextWindowTokens: 100_000,
        maxOutputTokens: 4096,
        reasoningEfforts: [],
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        hostedWebSearch: false,
        enabled: true
      };
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const emit = vi.spyOn(host, 'emit');
      const start = vi.fn(async function* () {
        yield { type: 'text.completed' as const, itemId: 'answer', text: 'Done' };
        yield { type: 'completed' as const, reason: 'completed' as const };
      });
      const agent = await createAgentWithAdapter(
        {
          mode: 'normal',
          host,
          models: [model]
        },
        () => ({ configuration: model, start })
      );
      agents.push(agent);
      const sdkSession = await agent.openSession(session.id);
      const before = await readFile(path);
      const error = arm(path, 'partial');
      io.indexFailures = 0;
      if (indexFault) io.indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
      const append = store.append;
      const attempted: string[] = [];
      const spy = vi
        .spyOn(JsonlSessionStore.prototype, 'append')
        .mockImplementation(async function (this: JsonlSessionStore, id, record, options) {
          attempted.push(record.type);
          try {
            return await append.call(this, id, record, options);
          } catch (failure) {
            if (cancel) handle.cancel();
            throw failure;
          }
        });
      const handle = sdkSession.run({ prompt: 'Write failure' });
      try {
        const expected = cancel
          ? { status: 'cancelled' }
          : {
              status: 'failed',
              errorCode: 'ENOSPC',
              errorMessage: error.message
            };
        // A secondary release failure must not replace the first outcome or leave the stream open.
        if (indexFault) await expect(handle.result()).resolves.toMatchObject(expected);
        const events: AgentEvent[] = [];
        for await (const event of handle) events.push(event);
        await expect(handle.result()).resolves.toMatchObject(expected);
        expect(io.indexFailures).toBe(indexFault ? 1 : 0);
        expect(handle.persistedEvents).toBe(false);
        expect(attempted).toContain(cancel ? 'execution.cancelled' : 'execution.failed');
        expect(
          events.some((event) => ['execution.failed', 'execution.cancelled'].includes(event.type))
        ).toBe(false);
        expect(
          emit.mock.calls.some(([event]) =>
            ['execution.failed', 'execution.cancelled'].includes(event.type)
          )
        ).toBe(false);
        expect(start).not.toHaveBeenCalled();
        expect((await readFile(path)).length).toBe(before.length + 13);
        expect(io.opens).toBe(1);
        await expect(readFile(join(dirname(path), 'lock'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
      } finally {
        spy.mockRestore();
      }
      await expect(sdkSession.run({ prompt: 'Recovered input' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      const records = await store.read(session.id);
      expect(records.map((record) => record.sequence)).toEqual(
        records.map((_, index) => index + 1)
      );
      expect(records.filter((record) => record.executionId === handle.executionId)).toEqual([]);
    }
  );
});
