import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarAgentWithAdapter } from '../../src/agent-core/sdk/agent.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import {
  LocalAgentHost,
  SecretValue,
  type MarAgent,
  type MarAgentEvent,
  type MarAgentModelConfiguration
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
  failure: Object.assign(new Error('Simulated session disk failure.'), { code: 'ENOSPC' })
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === io.indexPath && io.injected && io.indexFailures === 0) {
        io.indexFailures++;
        throw Object.assign(new Error('Simulated secondary index persistence failure.'), {
          code: 'EIO'
        });
      }
      return fs.rename(...args);
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
const agents: MarAgent[] = [];
afterEach(async () => {
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
  const path = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
  return { home, store, session, path };
}

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
      const model: MarAgentModelConfiguration = {
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
      const agent = await createMarAgentWithAdapter({
        mode: 'normal',
        host,
        models: [model],
        adapterFactory: () => ({ configuration: model, start })
      });
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
              errorMessage: `ENOSPC: ${error.message}`
            };
        // A secondary release failure must not replace the first outcome or leave the stream open.
        if (indexFault) await expect(handle.result()).resolves.toMatchObject(expected);
        const events: MarAgentEvent[] = [];
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
