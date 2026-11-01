import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { openAgentSessionCatalog } from '../../src/sdk/session-catalog.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-gc-count-'));
  homes.push(home);
  const store = await JsonlSessionStore.open(home);
  const session = await store.createSession({ workspace: home });
  await recordUsage(store, session.id);
  return { home, store, id: session.id };
}

async function recordUsage(
  store: JsonlSessionStore,
  id: string,
  tokens = 500,
  options: { contextInputTokens?: number; purpose?: 'compact' } = {}
) {
  return store.append(id, {
    type: 'usage.updated',
    payload: {
      type: 'usage.updated',
      eventId: 'usage',
      sequence: 1,
      timestamp: new Date().toISOString(),
      sessionId: id,
      executionId: 'execution',
      inputTokens: tokens,
      ...options
    }
  });
}

async function recordGc(
  store: JsonlSessionStore,
  id: string,
  generation: number,
  before: number,
  after?: number
) {
  const usage = await recordUsage(store, id, before);
  await store.append(id, {
    type: 'context.gc.completed',
    payload: {
      generation,
      trigger: { usageSequence: usage.sequence, contextInputTokens: before, modelId: 'model' },
      metrics: { reclaimedTokens: 99999 }
    }
  });
  if (after !== undefined) await recordUsage(store, id, after);
}

async function gcCount(store: JsonlSessionStore, id: string) {
  return (await gcUsage(store, id))?.gcCount;
}

async function gcUsage(store: JsonlSessionStore, id: string) {
  const catalog = await openAgentSessionCatalog({ sessionStore: store });
  try {
    return await catalog.contextUsage(id);
  } finally {
    await catalog.close();
  }
}

describe('Session GC count', () => {
  it('sums measured input decreases using the first post-GC usage in the current Compact window', async () => {
    const { home, store, id } = await fixture();
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 500,
      gcCount: 0,
      gcReclaimedTokens: 0
    });
    await store.append(id, {
      type: 'context.gc.completed',
      payload: { generation: 1, metrics: { reclaimedTokens: 9000 } }
    });
    await store.compact(id, { summary: 'A new statistics window.' });
    await recordGc(store, id, 1, 5000, 3800);
    await recordUsage(store, id, 3000);
    await recordGc(store, id, 2, 3000, 2200);
    await recordUsage(store, id, 1999);
    await store.append(id, { type: 'compact.failed', payload: {} });
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 1999,
      gcCount: 2,
      gcReclaimedTokens: 2000
    });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    expect((await gcUsage(reopened, id))?.gcReclaimedTokens).toBe(2000);
    await reopened.compact(id, { summary: 'Reset statistics.' });
    expect(await gcUsage(reopened, id)).toEqual({
      inputTokens: 1999,
      gcCount: 0,
      gcReclaimedTokens: 0
    });
    await reopened.close();
  });

  it('does not return partial measurements or fall back to the token estimator', async () => {
    const { store, id } = await fixture();
    await recordGc(store, id, 1, 5000, 3800);
    await store.append(id, {
      type: 'context.gc.completed',
      payload: { generation: 2, metrics: { reclaimedTokens: 800 } }
    });
    await recordUsage(store, id);
    expect(await gcUsage(store, id)).toEqual({ inputTokens: 500, gcCount: 2 });
    await store.close();
  });

  it.each([-1, '800'])('keeps invalid pre-GC usage unknown: %s', async (tokens) => {
    const { store, id } = await fixture();
    await store.append(id, {
      type: 'context.gc.completed',
      payload: {
        generation: 1,
        trigger: { usageSequence: 1, contextInputTokens: tokens },
        metrics: { reclaimedTokens: 99999 }
      }
    });
    await recordUsage(store, id);
    expect(await gcUsage(store, id)).toEqual({ inputTokens: 500, gcCount: 1 });
    await store.close();
  });

  it('waits for real main-request usage, ignores Compact usage, and includes cached input', async () => {
    const { store, id } = await fixture();
    await recordGc(store, id, 1, 5000);
    expect(await gcUsage(store, id)).toEqual({ inputTokens: 5000, gcCount: 1 });
    await recordUsage(store, id, 100, { purpose: 'compact' });
    expect(await gcUsage(store, id)).toEqual({ inputTokens: 5000, gcCount: 1 });
    await recordUsage(store, id, 100, { contextInputTokens: 3800 });
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 3800,
      gcCount: 1,
      gcReclaimedTokens: 1200
    });
    await store.close();
  });

  it('reports zero net decrease when intervening additions exceed the GC reduction', async () => {
    const { store, id } = await fixture();
    await recordGc(store, id, 1, 500, 600);
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 600,
      gcCount: 1,
      gcReclaimedTokens: 0
    });
    await store.close();
  });

  it('uses the last input update of the first request rather than an initial streaming placeholder', async () => {
    const { store, id } = await fixture();
    await recordGc(store, id, 1, 5000);
    await store.append(id, {
      type: 'model.attempt',
      payload: { purpose: 'EXECUTION', state: 'STARTED', requestId: 'first-after-gc' }
    });
    await recordUsage(store, id, 0);
    await store.append(id, {
      type: 'model.attempt',
      payload: { purpose: 'COMPACT', state: 'STARTED', requestId: 'background-compact' }
    });
    await recordUsage(store, id, 50, { purpose: 'compact' });
    await recordUsage(store, id, 100, { contextInputTokens: 3800 });
    await store.append(id, {
      type: 'model.attempt',
      payload: { purpose: 'EXECUTION', state: 'SUCCEEDED', requestId: 'first-after-gc' }
    });
    await store.append(id, {
      type: 'model.attempt',
      payload: { purpose: 'EXECUTION', state: 'STARTED', requestId: 'later-request' }
    });
    await recordUsage(store, id, 1000);
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 1000,
      gcCount: 1,
      gcReclaimedTokens: 1200
    });
    await store.close();
  });

  it.each(['model', 'other'])(
    'does not compare different models across executions: %s',
    async (modelId) => {
      const { store, id } = await fixture();
      await recordGc(store, id, 1, 5000);
      await store.append(id, { type: 'execution.header', payload: { modelId } });
      await recordUsage(store, id, 3800);
      expect(await gcUsage(store, id)).toEqual({
        inputTokens: 3800,
        gcCount: 1,
        ...(modelId === 'model' ? { gcReclaimedTokens: 1200 } : {})
      });
      await store.close();
    }
  );

  it('does not double count consecutive GC checkpoints without intervening measured usage', async () => {
    const { store, id } = await fixture();
    const usage = await recordUsage(store, id, 5000);
    for (const generation of [1, 2])
      await store.append(id, {
        type: 'context.gc.completed',
        payload: {
          generation,
          trigger: { usageSequence: usage.sequence, contextInputTokens: 5000, modelId: 'model' }
        }
      });
    await recordUsage(store, id, 3000);
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 3000,
      gcCount: 2
    });
    await store.close();
  });
  it('counts only durable completions since the latest Compact and preserves them on reopen', async () => {
    const { home, store, id } = await fixture();
    expect(await gcCount(store, id)).toBe(0);
    await store.append(id, { type: 'context.gc.skipped', payload: {} });
    await store.append(id, { type: 'context.gc.completed', payload: { generation: 1 } });
    await store.append(id, { type: 'compact.failed', payload: {} });
    expect(await gcCount(store, id)).toBe(1);
    await store.compact(id, { summary: 'Continue the task.' });
    expect(await gcCount(store, id)).toBe(0);
    await store.append(id, { type: 'context.gc.completed', payload: { generation: 1 } });
    expect(await gcCount(store, id)).toBe(1);
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    expect(await gcCount(reopened, id)).toBe(1);
    await reopened.clearSession(id);
    expect(await gcCount(reopened, id)).toBeUndefined();
    await recordUsage(reopened, id);
    expect(await gcCount(reopened, id)).toBe(0);
    await reopened.close();
  });

  it('exposes the full count with bounded usage history, including repeated reads', async () => {
    const { store, id } = await fixture();
    await store.append(id, { type: 'context.gc.completed', payload: { generation: 1 } });
    await store.append(id, {
      type: 'usage.updated',
      payload: {
        type: 'usage.updated',
        eventId: 'usage',
        sequence: 1,
        timestamp: new Date().toISOString(),
        sessionId: id,
        executionId: 'execution',
        inputTokens: 500
      }
    });
    const catalog = await openAgentSessionCatalog({ sessionStore: store });
    const page = vi.spyOn(store, 'readPage');
    const read = vi.spyOn(store, 'read');
    for (let index = 0; index < 2; index++)
      await expect(catalog.contextUsage(id)).resolves.toEqual({ inputTokens: 500, gcCount: 1 });
    expect(page).toHaveBeenCalledTimes(2);
    expect(page).toHaveBeenCalledWith(id, { limit: 1000 });
    expect(read).not.toHaveBeenCalled();
    await catalog.close();
    await store.close();
  });

  it('reads the latest generation across pages without scanning back to Compact or adding index fields', async () => {
    const { home, store, id } = await fixture();
    await store.append(id, { type: 'context.gc.completed', payload: { generation: 1 } });
    await store.compact(id, { summary: 'A new context window.' });
    await recordGc(store, id, 1, 10000, 8800);
    await recordGc(store, id, 2, 8000, 7200);
    await store.append(id, { type: 'tool.result', payload: {} });
    await recordUsage(store, id);
    const history = await store.read(id);
    const page = vi.spyOn(store, 'readPage').mockImplementation(async (_id, input) => {
      const older = history.filter(
        (record) => input?.beforeSequence === undefined || record.sequence < input.beforeSequence
      );
      const records = older.slice(-2);
      return {
        records,
        ...(older.length > records.length ? { previousBeforeSequence: records[0]!.sequence } : {})
      };
    });
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 500,
      gcCount: 2,
      gcReclaimedTokens: 2000
    });
    expect(page).toHaveBeenCalledTimes(4);
    const index = JSON.parse(
      await readFile(join(home, '.mar', 'agent', 'sessions', 'index.json'), 'utf8')
    );
    expect(index.sessions[0].resume).not.toHaveProperty('gcCount');
    expect(index.sessions[0].resume).not.toHaveProperty('gcReclaimedTokens');
    await store.close();
  });

  it('stops at Compact instead of reusing an older generation', async () => {
    const { store, id } = await fixture();
    await store.append(id, { type: 'context.gc.completed', payload: { generation: 7 } });
    await store.compact(id, { summary: 'A new window.' });
    await recordUsage(store, id);
    expect(await gcCount(store, id)).toBe(0);
    await store.close();
  });

  it('recomputes retained history on rollback and excludes inherited checkpoints on forks', async () => {
    const { store, id } = await fixture();
    await store.append(id, { type: 'turn.user', turnId: 'first', payload: { prompt: 'First' } });
    await recordGc(store, id, 1, 5000, 3800);
    await store.append(id, { type: 'turn.user', turnId: 'second', payload: { prompt: 'Second' } });
    await recordGc(store, id, 2, 3000, 2200);
    const fork = await store.forkSession(id, { boundaryTurnId: 'second', title: 'Branch' });
    await recordUsage(store, fork.id);
    expect(await gcUsage(store, fork.id)).toEqual({
      inputTokens: 500,
      gcCount: 0,
      gcReclaimedTokens: 0
    });
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 2200,
      gcCount: 2,
      gcReclaimedTokens: 2000
    });
    await store.rollbackSession(id, { boundaryTurnId: 'second' });
    expect(await gcUsage(store, id)).toEqual({
      inputTokens: 3800,
      gcCount: 1,
      gcReclaimedTokens: 1200
    });
    await store.close();
  });
});
