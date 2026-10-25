import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { openMarAgentSessionCatalog } from '../../src/agent-core/session/catalog.js';

const homes: string[] = [];
afterEach(async () =>
  Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
);

describe('JSONL session store', () => {
  it('retains the physical writer lock for background cells while allowing only the owning Agent to take over', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cell-writer-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const releases: (() => Promise<void>)[] = [];
    try {
      const session = await store.createSession({ workspace: home });
      const owner = {};
      const first = await store.acquireSessionLease(session.id, owner);
      releases.push(first);
      const cell = await store.retainSessionLease(session.id, owner);
      releases.push(cell);
      await first();
      const lock = join(home, '.mar', 'agent', 'sessions', session.id, 'lock');
      const external = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        'import { openSync, closeSync } from "node:fs"; try { closeSync(openSync(process.argv[1], "wx")); process.exitCode = 1; } catch (error) { if (error.code !== "EEXIST") throw error; }',
        lock
      ]);
      expect(external.status).toBe(0);
      await expect(store.acquireSessionLease(session.id, {})).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      await expect(store.acquireSessionLease(session.id)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      const second = await store.acquireSessionLease(session.id, owner);
      releases.push(second);
      await expect(store.acquireSessionLease(session.id, owner)).rejects.toMatchObject({
        code: 'MAR_AGENT_SESSION_LOCKED'
      });
      await cell();
      await access(lock);
      await second();
      await expect(access(lock)).rejects.toMatchObject({ code: 'ENOENT' });
      const other = await store.acquireSessionLease(session.id, {});
      releases.push(other);
      await other();
    } finally {
      for (const release of releases.reverse()) await release();
      await store.close();
    }
  });

  it('serializes concurrent cell commits and background records without losing state or sequence identities', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-cell-state-race-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: home });
      const baseline = await store.readCodeModeState(session.id);
      const commits = await Promise.allSettled(
        [1, 2].map((value) =>
          store.commitCodeModeState(session.id, [{ operation: 'set', key: 'value', value }], {
            executionId: `e${value}`,
            turnId: `t${value}`,
            expectedState: baseline
          })
        )
      );
      expect(commits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(commits.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'MAR_AGENT_CODE_STATE_CONFLICT' }
      });
      expect(await store.readCodeModeState(session.id)).toEqual([{ key: 'value', value: 1 }]);
      await Promise.all(
        Array.from({ length: 10 }, (_, value) =>
          store.append(session.id, { type: 'test.background', payload: { value } })
        )
      );
      const records = await store.read(session.id);
      expect(new Set(records.map((record) => record.sequence)).size).toBe(records.length);
      expect(records.map((record) => record.sequence)).toEqual(
        [...records.map((record) => record.sequence)].sort((a, b) => a - b)
      );
    } finally {
      await store.close();
    }
  });

  it('keeps Code Mode state transactional across restart, compact, fork, rollback and clear', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-code-state-home-'));
    homes.push(home);
    let store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home, title: 'Code state' });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'first' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    await store.commitCodeModeState(
      session.id,
      [
        { operation: 'set', key: 'count', value: 1 },
        { operation: 'set', key: 'retained', value: { ok: true } }
      ],
      { executionId: 'execution-1', turnId: 'turn-1' }
    );
    await store.compact(session.id, {
      summary: 'A compact summary that does not contain Code Mode state.',
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    expect(
      JSON.stringify((await store.readExecutionState(session.id)).contextRecords)
    ).not.toContain('"retained"');
    await store.close();

    store = await JsonlSessionStore.open(home);
    await expect(store.readCodeModeState(session.id)).resolves.toEqual([
      { key: 'count', value: 1 },
      { key: 'retained', value: { ok: true } }
    ]);
    const forked = await store.forkSession(session.id, {
      boundaryTurnId: 'turn-1',
      title: 'Code state fork'
    });
    await expect(store.readCodeModeState(forked.id)).resolves.toEqual([
      { key: 'count', value: 1 },
      { key: 'retained', value: { ok: true } }
    ]);

    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'second' },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    await store.commitCodeModeState(
      session.id,
      [
        { operation: 'set', key: 'count', value: 2 },
        { operation: 'delete', key: 'retained' }
      ],
      { executionId: 'execution-2', turnId: 'turn-2' }
    );
    await expect(store.readCodeModeState(session.id)).resolves.toEqual([
      { key: 'count', value: 2 }
    ]);

    await store.rollbackSession(session.id, { boundaryTurnId: 'turn-1' });
    await expect(store.readCodeModeState(session.id)).resolves.toEqual([
      { key: 'count', value: 1 },
      { key: 'retained', value: { ok: true } }
    ]);
    await store.clearSession(session.id);
    await expect(store.readCodeModeState(session.id)).resolves.toEqual([]);
    await store.close();
  });

  it('projects the latest execution model and rebuilds it across rollback and clear', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-model-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home, title: 'Model state' });
    await store.append(session.id, {
      type: 'execution.header',
      payload: {
        modelId: 'model-one',
        modelName: 'Model One',
        reasoningEffort: 'high'
      },
      executionId: 'execution-one',
      turnId: 'turn-one'
    });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'first' },
      executionId: 'execution-one',
      turnId: 'turn-one'
    });
    await store.append(session.id, {
      type: 'execution.header',
      payload: {
        modelId: 'model-two',
        modelName: 'Model Two',
        reasoningEffort: 'xhigh'
      },
      executionId: 'execution-two',
      turnId: 'turn-two'
    });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'second' },
      executionId: 'execution-two',
      turnId: 'turn-two'
    });

    await expect(store.list()).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          id: session.id,
          modelId: 'model-two',
          modelName: 'Model Two',
          reasoningEffort: 'xhigh'
        })
      ]
    });

    await store.rollbackSession(session.id, { boundaryTurnId: 'turn-one' });
    await expect(store.list()).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          id: session.id,
          modelId: 'model-one',
          modelName: 'Model One',
          reasoningEffort: 'high'
        })
      ]
    });

    await store.clearSession(session.id);
    expect((await store.list()).sessions[0]).not.toHaveProperty('modelId');
    await store.close();
  });

  it('backfills the latest execution model for an existing session index', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-model-backfill-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home, title: 'Legacy model index' });
    await store.append(session.id, {
      type: 'execution.header',
      payload: {
        modelId: 'persisted-model',
        modelName: 'Persisted Model',
        reasoningEffort: 'max'
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{
        id: string;
        resume?: Record<string, unknown>;
      }>;
    };
    const persisted = index.sessions.find((candidate) => candidate.id === session.id);
    delete persisted?.resume?.executionModelIndexed;
    delete persisted?.resume?.modelId;
    delete persisted?.resume?.modelName;
    delete persisted?.resume?.reasoningEffort;
    await writeFile(indexPath, JSON.stringify(index));

    const reopened = await JsonlSessionStore.open(home);
    await reopened.updateTitle(session.id, 'Legacy model index renamed');
    await expect(reopened.executionConfiguration(session.id)).resolves.toEqual({
      modelId: 'persisted-model',
      modelName: 'Persisted Model',
      reasoningEffort: 'max'
    });
    await expect(reopened.list()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: session.id, modelId: 'persisted-model' })]
    });
    await reopened.close();
  });

  it('filters user sessions by default and queries persisted subagent relations explicitly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-source-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const root = await store.createSession({ workspace: home, title: 'Root' });
    const child = await store.createSession({
      workspace: home,
      title: 'Child',
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'parent-execution',
        role: 'explore',
        description: 'Inspect persisted state'
      }
    });
    const secondChild = await store.createSession({
      workspace: home,
      title: 'Second child',
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'parent-execution',
        role: 'explore',
        description: 'Second child'
      }
    });
    const nested = await store.createSession({
      workspace: home,
      title: 'Nested',
      source: {
        type: 'subagent',
        parentSessionId: child.id,
        rootSessionId: root.id,
        parentExecutionId: 'child-execution',
        role: 'general-purpose',
        description: 'Nested compatibility fixture'
      }
    });

    await expect(store.list()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: root.id, source: { type: 'user' } })]
    });
    await expect(
      store.list({ source: 'subagent', parentSessionId: root.id })
    ).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: child.id,
          source: expect.objectContaining({
            type: 'subagent',
            parentSessionId: root.id,
            rootSessionId: root.id
          })
        })
      ])
    });
    await expect(store.listSubagentChildren(root.id)).resolves.toMatchObject([
      expect.objectContaining({ id: child.id }),
      expect.objectContaining({ id: secondChild.id })
    ]);
    await expect(store.list({ source: 'subagent', rootSessionId: root.id })).resolves.toMatchObject(
      {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: child.id }),
          expect.objectContaining({ id: nested.id })
        ])
      }
    );
    await expect(store.getSession(child.id)).resolves.toMatchObject({
      id: child.id,
      source: expect.objectContaining({
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id
      })
    });
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{ id: string; source?: unknown }>;
    };
    const rootIndex = index.sessions.find((session) => session.id === root.id);
    delete rootIndex?.source;
    await writeFile(indexPath, JSON.stringify(index));
    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.getSession(root.id)).resolves.toMatchObject({ source: { type: 'user' } });
    await reopened.close();
  });

  it('cascades root deletion through persisted subagent descendants', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-session-tree-delete-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const root = await store.createSession({ workspace: home, title: 'Root' });
    const child = await store.createSession({
      workspace: home,
      title: 'Child',
      source: {
        type: 'subagent',
        parentSessionId: root.id,
        rootSessionId: root.id,
        parentExecutionId: 'parent-execution',
        role: 'general-purpose',
        description: 'Child'
      }
    });
    const nested = await store.createSession({
      workspace: home,
      title: 'Nested',
      source: {
        type: 'subagent',
        parentSessionId: child.id,
        rootSessionId: root.id,
        parentExecutionId: 'child-execution',
        role: 'explore',
        description: 'Nested'
      }
    });

    await expect(store.delete(root.id)).resolves.toEqual({ deleted: true });
    await expect(store.list()).resolves.toEqual({ sessions: [] });
    await expect(store.list({ source: 'subagent', rootSessionId: root.id })).resolves.toEqual({
      sessions: []
    });
    await expect(access(join(home, '.mar', 'agent', 'sessions', child.id))).rejects.toThrow();
    await expect(access(join(home, '.mar', 'agent', 'sessions', nested.id))).rejects.toThrow();
    await store.close();
  });

  it('deletes a persisted session through the public SDK catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-catalog-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.delete(session.id)).resolves.toEqual({ deleted: true });
    expect((await catalog.list()).sessions).toEqual([]);
    await catalog.close();
  });

  it('removes a stale index entry when its session directory is already missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-catalog-stale-session-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.close();
    await rm(join(home, '.mar', 'agent', 'sessions', session.id), {
      recursive: true,
      force: true
    });

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.delete(session.id)).resolves.toEqual({ deleted: false });
    await expect(catalog.list()).resolves.toEqual({ sessions: [] });
    await catalog.close();
  });

  it('pages recoverable conversation entries through the public SDK catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-history-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, {
      type: 'turn.user',
      payload: {
        prompt: 'hello',
        clientMessageId: 'client-message',
        images: [{ name: 'diagram.png', mimeType: 'image/png', byteSize: 3 }]
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.append(session.id, {
      type: 'message.completed',
      payload: {
        type: 'message.completed',
        eventId: 'event',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: session.id,
        executionId: 'execution',
        turnId: 'turn',
        phase: 'final_answer',
        text: 'world'
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.history(session.id)).resolves.toMatchObject({
      entries: [
        {
          kind: 'user',
          turnId: 'turn',
          text: 'hello',
          clientMessageId: 'client-message',
          images: [{ name: 'diagram.png', mimeType: 'image/png', byteSize: 3 }]
        },
        { kind: 'event', event: { type: 'message.completed', text: 'world' } }
      ]
    });
    await expect(catalog.history(session.id, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await expect(catalog.history(session.id, { cursor: '1e2' })).rejects.toMatchObject({
      code: 'MAR_AGENT_TOOL_INPUT_INVALID'
    });
    await catalog.close();
  });

  it.each(['RUNNING', 'COMPLETED', 'FAILED'] as const)(
    'projects legacy hosted %s into standard tools at the SDK catalog boundary',
    async (status) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-legacy-hosted-home-'));
      homes.push(home);
      const store = await JsonlSessionStore.open(home);
      const session = await store.createSession({ workspace: home });
      const sources = Array.from({ length: 21 }, (_, index) => ({
        url: `https://example.test/${index}`
      }));
      await store.append(session.id, {
        type: 'hosted_tool.updated',
        executionId: 'execution',
        turnId: 'turn',
        payload: {
          type: 'hosted_tool.updated',
          eventId: 'legacy-hosted',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: session.id,
          executionId: 'execution',
          turnId: 'turn',
          itemId: 'legacy-web',
          kind: 'WEB_SEARCH',
          status,
          summary: { query: 'stored query', sources }
        }
      });
      await store.close();
      const eventsPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
      const original = await readFile(eventsPath, 'utf8');
      const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
      try {
        const page = await catalog.history(session.id, { limit: 1 });
        const events = page.entries.flatMap((entry) =>
          entry.kind === 'event' ? [entry.event] : []
        );
        expect(events[0]).toMatchObject({
          type: 'tool.started',
          callId: 'legacy-web',
          toolName: 'web_search',
          input: { query: 'stored query' },
          truncated: true
        });
        expect(events).toHaveLength(status === 'RUNNING' ? 1 : 2);
        if (status !== 'RUNNING') {
          const terminal = events[1]!;
          expect(terminal).toMatchObject({
            type: status === 'COMPLETED' ? 'tool.completed' : 'tool.failed',
            callId: 'legacy-web',
            toolName: 'web_search',
            truncated: true
          });
          const summary =
            terminal.type === 'tool.completed'
              ? terminal.summary
              : terminal.type === 'tool.failed'
                ? terminal.message
                : '';
          expect(JSON.parse(summary!).sources).toEqual(sources.slice(0, 20));
        }
        for (const event of events) {
          expect(event).not.toHaveProperty('kind');
          expect(event).not.toHaveProperty('status');
          expect(event).not.toHaveProperty('itemId');
        }
        expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
        expect(new Set(page.entries.map((entry) => entry.sequence)).size).toBe(1);
        expect(page.nextCursor).toBeDefined();
        const previous = await catalog.history(session.id, { limit: 1, cursor: page.nextCursor! });
        expect(previous.entries).toEqual([]);
        expect(await readFile(eventsPath, 'utf8')).toBe(original);
      } finally {
        await catalog.close();
      }
    }
  );

  it('forks a session through a validated Turn boundary without copying later history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    for (const [index, turnId] of ['turn-1', 'turn-2'].entries()) {
      const executionId = `execution-${index + 1}`;
      await store.append(source.id, {
        type: 'turn.user',
        payload: { prompt: `question-${index + 1}` },
        executionId,
        turnId
      });
      await store.append(source.id, {
        type: 'message.completed',
        payload: {
          type: 'message.completed',
          eventId: `message-${index + 1}`,
          sequence: index + 1,
          timestamp: `2026-01-01T00:00:0${index}.000Z`,
          sessionId: source.id,
          executionId,
          turnId,
          phase: 'final_answer',
          text: `answer-${index + 1}`
        },
        executionId,
        turnId
      });
      if (index === 0) {
        await store.updateTitle(source.id, 'Renamed', {
          executionId,
          turnId
        });
        await store.append(source.id, {
          type: 'todo.updated',
          payload: {
            revision: 1,
            items: [{ id: 'fork', step: 'Preserve branch state', status: 'in_progress' }]
          },
          executionId,
          turnId
        });
        await store.compact(source.id, {
          summary: 'Retained branch context',
          executionId,
          turnId
        });
      }
    }
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    const forked = await catalog.fork(source.id, {
      boundaryTurnId: 'turn-1',
      title: 'Renamed (Copy 1)'
    });
    expect(forked).toMatchObject({
      title: 'Renamed (Copy 1)',
      workspace: home
    });
    await expect(catalog.history(forked.id)).resolves.toMatchObject({
      entries: [
        { kind: 'user', turnId: 'turn-1', text: 'question-1' },
        {
          kind: 'event',
          event: {
            sessionId: forked.id,
            turnId: 'turn-1',
            type: 'message.completed',
            text: 'answer-1'
          }
        }
      ]
    });
    const forkedStore = await JsonlSessionStore.open(home);
    expect((await forkedStore.read(forked.id)).map((record) => record.sequence)).toEqual([
      1, 2, 3, 4, 5, 6
    ]);
    await expect(forkedStore.readExecutionState(forked.id)).resolves.toMatchObject({
      automaticTitlePending: false,
      todo: {
        revision: 1,
        items: [{ id: 'fork', step: 'Preserve branch state', status: 'in_progress' }]
      },
      contextRecords: [
        expect.objectContaining({
          type: 'compact.completed',
          turnId: 'turn-1',
          payload: expect.objectContaining({ summary: 'Retained branch context' })
        })
      ]
    });
    await forkedStore.close();
    const sourceHistory = await catalog.history(source.id);
    expect(sourceHistory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', turnId: 'turn-2', text: 'question-2' })
      ])
    );
    const blank = await catalog.fork(source.id, {
      boundaryTurnId: null,
      title: 'Renamed (Copy 2)'
    });
    await expect(catalog.history(blank.id)).resolves.toMatchObject({ entries: [] });
    await expect(
      catalog.fork(source.id, {
        boundaryTurnId: 'missing-turn',
        title: 'Invalid branch'
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_REWIND_TARGET_INVALID' });
    const writer = await JsonlSessionStore.open(home);
    const release = await writer.acquireSessionLease(source.id);
    await expect(
      catalog.fork(source.id, {
        boundaryTurnId: 'turn-1',
        title: 'Busy branch'
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_LOCKED' });
    await release();
    await writer.close();
    await catalog.close();
  });

  it('copies only generated images referenced by retained fork history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-images-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    const generated = join(home, '.mar', 'agent', 'sessions', source.id, 'generated_images');
    await mkdir(generated);
    await writeFile(join(generated, 'image_retained.png'), 'retained');
    await writeFile(join(generated, 'image_later.png'), 'later');
    for (const [index, fileName] of ['image_retained.png', 'image_later.png'].entries()) {
      const turnId = `turn-${index + 1}`;
      const executionId = `execution-${index + 1}`;
      await store.append(source.id, {
        type: 'tool.completed',
        payload: {
          type: 'tool.completed',
          eventId: `image-${index + 1}`,
          sequence: index + 1,
          timestamp: `2026-09-03T00:00:0${index}.000Z`,
          sessionId: source.id,
          executionId,
          turnId,
          toolName: 'codex_image_gen',
          callId: `call-${index + 1}`,
          summary: fileName,
          artifacts: [
            {
              kind: 'image',
              name: fileName,
              mimeType: 'image/png',
              byteSize: index + 1,
              sha256: String(index + 1).repeat(64),
              fileName
            }
          ]
        },
        executionId,
        turnId
      });
    }

    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'turn-1',
      title: 'Original (Copy 1)'
    });

    const copied = join(home, '.mar', 'agent', 'sessions', forked.id, 'generated_images');
    await expect(readdir(copied)).resolves.toEqual(['image_retained.png']);
    await expect(readFile(join(copied, 'image_retained.png'), 'utf8')).resolves.toBe('retained');
    await store.close();
  });

  it('persists the optional model URL alongside restorable input image bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-input-image-url-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Image URL', workspace: home });
    const url = 'https://images.example.test/input.png?signature=stable';
    const urlExpiresAt = Date.now() + 60_000;
    const images = await store.persistInputImages(session.id, [
      { name: 'input.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=', url, urlExpiresAt }
    ]);
    expect(images[0]).toMatchObject({ url, urlExpiresAt });
    const restored = await store.readInputImages(session.id, images);
    expect(restored).toMatchObject([
      { mimeType: 'image/png', url, urlExpiresAt, resourceId: images[0]!.resourceId }
    ]);
    expect(restored[0]).not.toHaveProperty('dataBase64');
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'inspect', images } });
    await expect(store.readImageResource(session.id, images[0]!.resourceId!)).resolves.toEqual({
      mimeType: 'image/png',
      dataBase64: 'aW1hZ2U='
    });
    await expect(
      store.persistInputImages(session.id, [
        { name: 'invalid.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=', urlExpiresAt }
      ])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_INPUT_INVALID' });
    await store.close();
  });

  it('copies only user input images referenced by retained fork history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-input-images-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    const inputImages = join(home, '.mar', 'agent', 'sessions', source.id, 'input_images');
    await mkdir(inputImages);
    const contents = ['retained', 'later'];
    await writeFile(join(inputImages, 'turn-1-0.bin'), contents[0]!);
    await writeFile(join(inputImages, 'turn-2-0.bin'), contents[1]!);
    for (const [index, fileName] of ['turn-1-0.bin', 'turn-2-0.bin'].entries()) {
      await store.append(source.id, {
        type: 'turn.user',
        payload: {
          prompt: `question-${index + 1}`,
          images: [
            {
              name: `image-${index + 1}.png`,
              mimeType: 'image/png',
              byteSize: index === 0 ? 8 : 5,
              fileName,
              sha256: createHash('sha256').update(contents[index]!).digest('hex')
            }
          ]
        },
        executionId: `execution-${index + 1}`,
        turnId: `turn-${index + 1}`
      });
    }

    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'turn-1',
      title: 'Original (Copy 1)'
    });

    const copied = join(home, '.mar', 'agent', 'sessions', forked.id, 'input_images');
    await expect(readdir(copied)).resolves.toEqual(['turn-1-0.bin']);
    await expect(readFile(join(copied, 'turn-1-0.bin'), 'utf8')).resolves.toBe('retained');
    await store.close();
  });

  it('keeps contextual world state private to its Session lifecycle', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-context-world-state-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    await store.append(source.id, {
      type: 'turn.user',
      payload: { prompt: 'first' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    const state = {
      version: 1,
      generation: null,
      instructionSnapshot: 'snapshot',
      resourceSnapshot: null,
      entries: [{ index: 0, kind: 'instructions', content: 'private instructions' }]
    };
    await store.writeContextualWorldState(source.id, state);
    await expect(store.readContextualWorldState(source.id)).resolves.toEqual(state);
    expect(JSON.stringify(await store.read(source.id))).not.toContain('private instructions');

    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'turn-1',
      title: 'Original (Copy 1)'
    });
    await expect(store.readContextualWorldState(forked.id)).resolves.toBeUndefined();

    await store.append(source.id, {
      type: 'turn.user',
      payload: { prompt: 'second' },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });
    await store.writeContextualWorldState(source.id, {
      ...state,
      entries: [{ index: 0, kind: 'instructions', content: 'later private instructions' }]
    });
    await store.rollbackSession(source.id, { boundaryTurnId: 'turn-1' });
    await expect(store.readContextualWorldState(source.id)).resolves.toBeUndefined();

    await store.writeContextualWorldState(source.id, state);
    await store.clearSession(source.id);
    await expect(store.readContextualWorldState(source.id)).resolves.toBeUndefined();
    await store.close();
  });

  it('ignores malformed, oversized, and non-regular contextual world-state sidecars', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-invalid-context-world-state-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Original', workspace: home });
    const sidecar = join(home, '.mar', 'agent', 'sessions', session.id, 'context-world-state.json');

    await writeFile(sidecar, '{');
    await expect(store.readContextualWorldState(session.id)).resolves.toBeUndefined();
    await writeFile(sidecar, 'x'.repeat(8 * 1024 * 1024 + 1));
    await expect(store.readContextualWorldState(session.id)).resolves.toBeUndefined();
    await rm(sidecar);
    await mkdir(sidecar);
    await expect(store.readContextualWorldState(session.id)).resolves.toBeUndefined();
    await store.close();
  });

  it.each(['rollback', 'clear'] as const)(
    'restores contextual world state when %s fails before commit',
    async (operation) => {
      const home = await mkdtemp(join(tmpdir(), `mar-agent-failed-${operation}-sidecar-home-`));
      homes.push(home);
      const store = await JsonlSessionStore.open(home);
      const session = await store.createSession({ title: 'Original', workspace: home });
      await store.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'first' },
        executionId: 'execution-1',
        turnId: 'turn-1'
      });
      const state = {
        version: 1,
        generation: null,
        instructionSnapshot: 'snapshot',
        resourceSnapshot: null,
        entries: [{ index: 0, kind: 'instructions', content: 'private instructions' }]
      };
      await store.writeContextualWorldState(session.id, state);
      await writeFile(
        join(home, '.mar', 'agent', 'sessions', session.id, 'generated_images'),
        'not a directory'
      );

      const action =
        operation === 'rollback'
          ? store.rollbackSession(session.id, { boundaryTurnId: 'turn-1' })
          : store.clearSession(session.id);
      await expect(action).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(store.readContextualWorldState(session.id)).resolves.toEqual(state);
      await expect(store.read(session.id)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'turn.user', turnId: 'turn-1' })])
      );
      await store.close();
    }
  );

  it('recovers or removes interrupted contextual world-state transactions on reopen', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-sidecar-recovery-home-'));
    homes.push(home);
    let store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Original', workspace: home });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'first' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    const state = {
      version: 1,
      generation: null,
      instructionSnapshot: 'snapshot',
      resourceSnapshot: null,
      entries: [{ index: 0, kind: 'instructions', content: 'private instructions' }]
    };
    await store.writeContextualWorldState(session.id, state);
    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    const canonical = join(directory, 'context-world-state.json');
    const interrupted = `${canonical}.2.00000000-0000-4000-8000-000000000001.clear-backup`;
    await rename(canonical, interrupted);
    await store.close();

    store = await JsonlSessionStore.open(home);
    await expect(store.readContextualWorldState(session.id)).resolves.toEqual(state);
    await store.clearSession(session.id);
    const committed = `${canonical}.2.00000000-0000-4000-8000-000000000002.clear-backup`;
    await writeFile(committed, 'private instructions');
    await store.close();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{ id: string; nextSequence: number }>;
    };
    index.sessions.find((item) => item.id === session.id)!.nextSequence = 3;
    await writeFile(indexPath, JSON.stringify(index));

    store = await JsonlSessionStore.open(home);
    expect((await readdir(directory)).filter((name) => name.endsWith('.clear-backup'))).toEqual([]);
    await expect(store.readContextualWorldState(session.id)).resolves.toBeUndefined();
    await store.close();
  });

  it('does not inherit Responses continuation checkpoints into a fork', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-continuation-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    await store.append(source.id, {
      type: 'turn.user',
      payload: { prompt: 'question' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    await store.append(source.id, {
      type: 'responses.continuation',
      payload: {
        modelId: 'coding',
        checkpoint: {
          version: 2,
          protocol: 'OPENAI_RESPONSES',
          configurationHash: 'a'.repeat(64),
          responseId: 'response-1',
          inputPrefixLength: 2
        }
      },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });

    const forked = await store.forkSession(source.id, {
      boundaryTurnId: 'turn-1',
      title: 'Original (Copy 1)'
    });

    expect(
      (await store.read(forked.id)).some((record) => record.type === 'responses.continuation')
    ).toBe(false);
    await store.close();
  });

  it('drops Responses continuation checkpoints when rolling history back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-rollback-continuation-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Original', workspace: home });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'first' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    await store.append(session.id, {
      type: 'responses.continuation',
      payload: { modelId: 'coding', checkpoint: { responseId: 'response-1' } },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    await store.append(session.id, {
      type: 'model.context',
      payload: { text: 'Retained after continuation' },
      executionId: 'execution-1',
      turnId: 'turn-1'
    });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'second' },
      executionId: 'execution-2',
      turnId: 'turn-2'
    });

    await store.rollbackSession(session.id, { boundaryTurnId: 'turn-1' });

    const retained = await store.read(session.id);
    expect(retained.some((record) => record.type === 'responses.continuation')).toBe(false);
    expect(retained.map((record) => record.sequence)).toEqual([1, 2, 4]);
    expect(
      (await store.append(session.id, { type: 'model.context', payload: { text: 'next' } }))
        .sequence
    ).toBe(5);
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    try {
      expect(
        (await reopened.append(session.id, { type: 'model.context', payload: { text: 'reopen' } }))
          .sequence
      ).toBe(6);
    } finally {
      await reopened.close();
    }
  });

  it('rolls back the current session before a user turn and rebuilds retained state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-rollback-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Original', workspace: home });
    const inputImages = join(home, '.mar', 'agent', 'sessions', session.id, 'input_images');
    const generatedImages = join(home, '.mar', 'agent', 'sessions', session.id, 'generated_images');
    await mkdir(inputImages);
    await mkdir(generatedImages);
    const inputContents = ['retained-input', 'removed-input'];
    for (const [index, content] of inputContents.entries())
      await writeFile(join(inputImages, `input-${index + 1}.bin`), content);
    await writeFile(join(generatedImages, 'retained.png'), 'retained-generated');
    await writeFile(join(generatedImages, 'removed.png'), 'removed-generated');

    for (const [index, turnId] of ['turn-1', 'turn-2'].entries()) {
      const executionId = `execution-${index + 1}`;
      await store.append(session.id, {
        type: 'turn.user',
        payload: {
          prompt: `question-${index + 1}`,
          images: [
            {
              name: `input-${index + 1}.png`,
              mimeType: 'image/png',
              byteSize: Buffer.byteLength(inputContents[index]!),
              fileName: `input-${index + 1}.bin`,
              sha256: createHash('sha256').update(inputContents[index]!).digest('hex')
            }
          ]
        },
        executionId,
        turnId
      });
      await store.append(session.id, {
        type: 'todo.updated',
        payload: {
          revision: index + 1,
          items: [{ id: turnId, step: turnId, status: 'in_progress' }]
        },
        executionId,
        turnId
      });
      if (index === 0) {
        await store.compact(session.id, {
          summary: 'Retained compact state',
          executionId,
          turnId
        });
        await store.updateTitle(session.id, 'Retained title', { executionId, turnId });
      }
      await store.append(session.id, {
        type: 'tool.completed',
        payload: {
          type: 'tool.completed',
          eventId: `image-${index + 1}`,
          sequence: index + 1,
          timestamp: `2026-09-09T00:00:0${index}.000Z`,
          sessionId: session.id,
          executionId,
          turnId,
          toolName: 'codex_image_gen',
          callId: `image-call-${index + 1}`,
          summary: index === 0 ? 'retained.png' : 'removed.png',
          artifacts: [
            {
              kind: 'image',
              name: index === 0 ? 'retained.png' : 'removed.png',
              mimeType: 'image/png',
              byteSize: 1,
              sha256: String(index + 1).repeat(64),
              fileName: index === 0 ? 'retained.png' : 'removed.png'
            }
          ]
        },
        executionId,
        turnId
      });
    }
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    const beforeRollback = Date.now();
    const rolledBack = await catalog.rollback(session.id, { boundaryTurnId: 'turn-1' });
    expect(rolledBack).toMatchObject({
      id: session.id,
      title: 'Retained title',
      workspace: home
    });
    expect(Date.parse(rolledBack.lastActivityAt)).toBeGreaterThanOrEqual(beforeRollback);
    await expect(catalog.history(session.id)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ kind: 'user', turnId: 'turn-1', text: 'question-1' }),
        expect.objectContaining({
          kind: 'event',
          event: expect.objectContaining({ turnId: 'turn-1', type: 'tool.completed' })
        })
      ]
    });
    expect(await readdir(inputImages)).toEqual(['input-1.bin']);
    expect(await readdir(generatedImages)).toEqual(['retained.png']);

    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: false,
      todo: {
        revision: 1,
        items: [{ id: 'turn-1', step: 'turn-1', status: 'in_progress' }]
      },
      contextRecords: [
        expect.objectContaining({
          type: 'compact.completed',
          turnId: 'turn-1',
          payload: expect.objectContaining({ summary: 'Retained compact state' })
        }),
        expect.objectContaining({ type: 'session.title.updated', turnId: 'turn-1' }),
        expect.objectContaining({ type: 'tool.completed', turnId: 'turn-1' })
      ]
    });
    const appended = await reopened.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'replacement' },
      executionId: 'execution-replacement',
      turnId: 'turn-replacement'
    });
    expect(appended.sequence).toBe(7);
    await reopened.close();

    await expect(
      catalog.rollback(session.id, { boundaryTurnId: 'missing-turn' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_ROLLBACK_TARGET_INVALID' });
    const writer = await JsonlSessionStore.open(home);
    const release = await writer.acquireSessionLease(session.id);
    await expect(catalog.rollback(session.id, { boundaryTurnId: 'turn-1' })).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
    await release();
    await writer.close();
    await catalog.close();
  });

  it('rolls back the first user turn to the original empty session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-rollback-empty-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, {
      type: 'turn.user',
      payload: { prompt: 'remove me' },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.rollback(session.id, { boundaryTurnId: null })).resolves.toMatchObject({
      id: session.id,
      title: 'New session'
    });
    await expect(catalog.history(session.id)).resolves.toEqual({ entries: [] });
    await catalog.close();

    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: true,
      todo: { revision: 0, items: [] }
    });
    expect(
      (
        await reopened.append(session.id, {
          type: 'turn.user',
          payload: { prompt: 'replacement' },
          executionId: 'replacement-execution',
          turnId: 'replacement-turn'
        })
      ).sequence
    ).toBe(2);
    await reopened.close();
  });

  it('keeps legacy image metadata as placeholders and rejects corrupt private references', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-input-images-corrupt-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Images', workspace: home });

    await expect(
      store.readInputImages(session.id, [
        { name: 'legacy.png', mimeType: 'image/png', byteSize: 3 }
      ])
    ).resolves.toEqual([]);
    await expect(
      store.readInputImages(session.id, [
        {
          name: 'unsafe.png',
          mimeType: 'image/png',
          byteSize: 3,
          fileName: '../unsafe.bin',
          sha256: 'a'.repeat(64)
        }
      ])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    await expect(
      store.readInputImages(session.id, [
        {
          name: 'missing.png',
          mimeType: 'image/png',
          byteSize: 3,
          fileName: 'missing.bin',
          sha256: 'a'.repeat(64)
        }
      ])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    const directory = join(home, '.mar', 'agent', 'sessions', session.id, 'input_images');
    await mkdir(directory);
    await writeFile(join(directory, 'target.bin'), 'abc');
    await expect(
      store.readInputImages(session.id, [
        {
          name: 'changed.png',
          mimeType: 'image/png',
          byteSize: 3,
          fileName: 'target.bin',
          sha256: 'b'.repeat(64)
        }
      ])
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    if (process.platform !== 'win32') {
      await symlink('target.bin', join(directory, 'linked.bin'));
      await expect(
        store.readInputImages(session.id, [
          {
            name: 'linked.png',
            mimeType: 'image/png',
            byteSize: 3,
            fileName: 'linked.bin',
            sha256: createHash('sha256').update('abc').digest('hex')
          }
        ])
      ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    }
    const mixedRecord = await store.append(session.id, {
      type: 'turn.user',
      payload: {
        prompt: 'mixed',
        images: [
          { name: 'legacy.png', mimeType: 'image/png', byteSize: 3 },
          {
            name: 'unsafe.png',
            mimeType: 'image/png',
            byteSize: 3,
            fileName: '../unsafe.bin',
            sha256: 'a'.repeat(64)
          }
        ]
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await expect(
      store.readInputImage(session.id, {
        sequence: mixedRecord.sequence,
        imageIndex: 0
      })
    ).resolves.toBeUndefined();
    await expect(
      store.readInputImage(session.id, {
        sequence: mixedRecord.sequence,
        imageIndex: 1
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_SESSION_CORRUPT' });
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.history(session.id)).resolves.toMatchObject({
      entries: [
        {
          kind: 'user',
          sequence: mixedRecord.sequence,
          images: [
            expect.objectContaining({ name: 'legacy.png', readable: false }),
            expect.objectContaining({ name: 'unsafe.png', readable: false })
          ]
        }
      ]
    });
    await catalog.close();
    await store.close();
  });

  it('keeps mixed legacy and readable images in original order without exposing pixels', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-input-image-catalog-home-'));
    homes.push(home);
    const imageBase64 = Buffer.from('catalog-image').toString('base64');
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Images', workspace: home });
    const images = await store.persistInputImages(session.id, [
      { name: 'diagram.png', mimeType: 'image/png', dataBase64: imageBase64 }
    ]);
    const record = await store.append(session.id, {
      type: 'turn.user',
      payload: {
        prompt: 'inspect',
        images: [{ name: 'legacy.png', mimeType: 'image/png', byteSize: 3 }, ...images]
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    const history = await catalog.history(session.id);
    expect(history.entries).toEqual([
      expect.objectContaining({
        kind: 'user',
        sequence: record.sequence,
        images: [
          {
            name: 'legacy.png',
            mimeType: 'image/png',
            byteSize: 3,
            readable: false
          },
          {
            name: 'diagram.png',
            mimeType: 'image/png',
            byteSize: 13,
            readable: true
          }
        ]
      })
    ]);
    expect(JSON.stringify(history)).not.toContain(imageBase64);
    await expect(
      catalog.readImage(session.id, { sequence: record.sequence, imageIndex: 0 })
    ).resolves.toBeUndefined();
    await expect(
      catalog.readImage(session.id, { sequence: record.sequence, imageIndex: 1 })
    ).resolves.toEqual({
      name: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 13,
      dataBase64: imageBase64
    });
    await expect(
      catalog.readImage(session.id, { sequence: record.sequence, imageIndex: 2 })
    ).resolves.toBeUndefined();
    await catalog.close();
  });

  it('clears a session atomically while preserving its identity, title, and automatic-title setting', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-clear-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.updateTitle(session.id, 'Kept title');
    const inputImages = join(home, '.mar', 'agent', 'sessions', session.id, 'input_images');
    const generatedImages = join(home, '.mar', 'agent', 'sessions', session.id, 'generated_images');
    await mkdir(inputImages);
    await mkdir(generatedImages);
    await writeFile(join(inputImages, 'input.bin'), 'input');
    await writeFile(join(generatedImages, 'result.png'), 'result');
    await store.append(session.id, {
      type: 'turn.user',
      payload: {
        prompt: 'remove this history',
        images: [
          {
            name: 'input.png',
            mimeType: 'image/png',
            byteSize: 5,
            fileName: 'input.bin',
            sha256: createHash('sha256').update('input').digest('hex')
          }
        ]
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.append(session.id, {
      type: 'tool.completed',
      payload: {
        type: 'tool.completed',
        eventId: 'image',
        sequence: 1,
        timestamp: '2026-09-09T00:00:00.000Z',
        sessionId: session.id,
        executionId: 'execution',
        toolName: 'codex_image_gen',
        callId: 'image-call',
        summary: 'result.png',
        artifacts: [
          {
            kind: 'image',
            name: 'result.png',
            mimeType: 'image/png',
            byteSize: 6,
            sha256: 'a'.repeat(64),
            fileName: 'result.png'
          }
        ]
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    const cleared = await catalog.clear(session.id);
    expect(cleared).toMatchObject({
      id: session.id,
      title: 'Kept title',
      workspace: home
    });
    await expect(catalog.history(session.id)).resolves.toEqual({ entries: [] });
    await expect(readdir(inputImages)).resolves.toEqual([]);
    await expect(readdir(generatedImages)).resolves.toEqual([]);
    await catalog.close();

    const reopened = await JsonlSessionStore.open(home);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: false,
      todo: { revision: 0, items: [] },
      contextRecords: [expect.objectContaining({ type: 'session.created' })]
    });
    expect(
      await reopened.append(session.id, {
        type: 'turn.user',
        payload: { prompt: 'new history' },
        executionId: 'next-execution',
        turnId: 'next-turn'
      })
    ).toMatchObject({ sequence: 2 });
    const release = await reopened.acquireSessionLease(session.id);
    const lockedCatalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(lockedCatalog.clear(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
    await lockedCatalog.close();
    await release();
    await reopened.close();
  });

  it('fails a fork atomically when retained history references a missing generated image', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-missing-image-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    await store.append(source.id, {
      type: 'tool.completed',
      payload: {
        type: 'tool.completed',
        eventId: 'missing-image',
        sequence: 1,
        timestamp: '2026-09-03T00:00:00.000Z',
        sessionId: source.id,
        executionId: 'execution',
        turnId: 'turn',
        toolName: 'codex_image_gen',
        callId: 'image-call',
        summary: 'missing.png',
        artifacts: [
          {
            kind: 'image',
            name: 'missing.png',
            mimeType: 'image/png',
            byteSize: 68,
            sha256: 'a'.repeat(64),
            fileName: 'missing.png'
          }
        ]
      },
      executionId: 'execution',
      turnId: 'turn'
    });

    await expect(
      store.forkSession(source.id, {
        boundaryTurnId: 'turn',
        title: 'Original (Copy 1)'
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.list()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: source.id })]
    });
    const sessionDirectories = (
      await readdir(join(home, '.mar', 'agent', 'sessions'), {
        withFileTypes: true
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(sessionDirectories).toEqual([source.id]);
    await store.close();
  });

  it('publishes a fork only after the retained history is fully copied', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-fork-publish-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const source = await store.createSession({ title: 'Original', workspace: home });
    await store.append(source.id, {
      type: 'turn.user',
      payload: { prompt: 'question' },
      executionId: 'execution',
      turnId: 'turn'
    });

    let continueCopy!: () => void;
    const copyBlocked = new Promise<void>((resolve) => {
      continueCopy = resolve;
    });
    let markCopyStarted!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      markCopyStarted = resolve;
    });
    const probe = await open(join(home, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWriteFile = prototype.writeFile;
    const write = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: object,
      ...args: unknown[]
    ) {
      if (typeof args[0] === 'string' && args[0].includes('"turn.user"')) {
        markCopyStarted();
        await copyBlocked;
      }
      return originalWriteFile.apply(this, args);
    });

    const forkPromise = store.forkSession(source.id, {
      boundaryTurnId: 'turn',
      title: 'Original (Copy 1)'
    });
    await copyStarted;
    const visibleDuringCopy = (await store.list()).sessions.some(
      (session) => session.title === 'Original (Copy 1)'
    );
    continueCopy();
    const forked = await forkPromise;
    write.mockRestore();

    expect(visibleDuringCopy).toBe(false);
    expect((await store.list()).sessions.map((session) => session.id)).toContain(forked.id);
    await store.close();
  });

  it('reads the latest persisted input token usage through the public SDK catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-usage-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    for (const [sequence, inputTokens, outputTokens] of [
      [1, 120, undefined],
      [2, undefined, 8],
      [3, 240, undefined],
      [4, undefined, 16],
      [5, 75_000, undefined]
    ] as const)
      await store.append(session.id, {
        type: 'usage.updated',
        payload: {
          type: 'usage.updated',
          eventId: `usage-${sequence}`,
          sequence,
          ...(sequence === 5 ? { purpose: 'compact' } : {}),
          timestamp: '2026-01-01T00:00:00.000Z',
          sessionId: session.id,
          executionId: 'execution',
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(sequence === 3 ? { contextInputTokens: 340 } : {}),
          ...(outputTokens === undefined ? {} : { outputTokens })
        },
        executionId: 'execution',
        turnId: 'turn'
      });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.contextUsage(session.id)).resolves.toEqual({ inputTokens: 340 });
    await catalog.close();

    const reopened = await JsonlSessionStore.open(home);
    await reopened.append(session.id, {
      type: 'context.compacted',
      payload: {
        type: 'context.compacted',
        compactionId: 'compact',
        eventId: 'compact',
        sequence: 5,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: session.id,
        executionId: 'execution',
        turnId: 'turn'
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await reopened.close();
    const compactedCatalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(compactedCatalog.contextUsage(session.id)).resolves.toEqual({ inputTokens: 0 });
    await compactedCatalog.close();

    const retained = await JsonlSessionStore.open(home);
    await retained.append(session.id, {
      type: 'context.compacted',
      payload: {
        type: 'context.compacted',
        compactionId: 'compact-with-tail',
        eventId: 'compact-with-tail',
        sequence: 7,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: session.id,
        executionId: 'execution',
        retainedContext: true
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    await retained.close();
    const retainedCatalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(retainedCatalog.contextUsage(session.id)).resolves.toBeUndefined();
    await retainedCatalog.close();
  });

  it('does not scan unbounded history for stale context usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-bounded-usage-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, {
      type: 'usage.updated',
      payload: {
        type: 'usage.updated',
        eventId: 'stale-usage',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: session.id,
        executionId: 'execution',
        inputTokens: 100
      },
      executionId: 'execution',
      turnId: 'turn'
    });
    for (let index = 0; index < 1000; index++)
      await store.append(session.id, {
        type: 'tool.result',
        payload: { index },
        executionId: 'execution',
        turnId: 'turn'
      });
    await store.close();

    const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
    await expect(catalog.contextUsage(session.id)).resolves.toBeUndefined();
    await catalog.close();
  });

  it('allows multiple SDK instances to share a HOME without an exclusive root lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-shared-home-'));
    homes.push(home);
    const first = await JsonlSessionStore.open(home);
    const second = await JsonlSessionStore.open(home);
    const session = await first.createSession({ workspace: home });
    const release = await first.acquireSessionLease(session.id);
    await expect(second.acquireSessionLease(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_LOCKED'
    });
    await release();
    const releaseSecond = await second.acquireSessionLease(session.id);
    await releaseSecond();
    await first.close();
    await first.close();
    await expect(second.createSession({ workspace: home })).resolves.toMatchObject({
      workspace: home
    });
    await second.close();
  });

  it('ignores an incomplete final JSONL record but rejects middle corruption', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-corrupt-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const path = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    await appendFile(path, '{"partial":');
    await expect(store.read(session.id)).resolves.toHaveLength(1);
    const original = (await readFile(path, 'utf8')).split('\n')[0]!;
    await writeFile(path, `${original}\nnot-json\n${original}\n`);
    await expect(store.read(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    await store.close();
  });
  it('appends ordered records, pages sessions and persists compact boundaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Test', workspace: '/workspace' });
    await store.append(session.id, { type: 'turn.started', payload: { text: 'hello' } });
    await store.compact(session.id, { summary: 'summary' });
    expect((await store.read(session.id)).map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect((await store.list()).sessions[0]).toMatchObject({ id: session.id, title: 'Test' });
    expect(await store.readPage(session.id, { limit: 2 })).toMatchObject({
      records: [expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 })],
      previousBeforeSequence: 2
    });
    await store.close();
    const reopened = await JsonlSessionStore.open(home);
    expect((await reopened.readExecutionState(session.id)).contextRecords).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'compact.completed' })])
    );
    await reopened.close();
  });

  it('restores compacted execution state without reading older unrelated segments', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-bounded-resume-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const payload = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 17; index++)
      await store.append(session.id, { type: 'large.record', payload: { index, payload } });
    await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 1,
        items: [{ id: 'resume', step: 'Resume compacted work', status: 'in_progress' }]
      }
    });
    await store.compact(session.id, { summary: 'bounded summary' });
    await store.append(session.id, { type: 'turn.user', payload: { prompt: 'continue' } });
    await store.close();

    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    await writeFile(join(directory, 'events-000001.jsonl'), 'not-json\n');

    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: false,
      todo: {
        revision: 1,
        items: [{ id: 'resume', step: 'Resume compacted work', status: 'in_progress' }]
      },
      contextRecords: [
        expect.objectContaining({ type: 'compact.completed' }),
        expect.objectContaining({ type: 'turn.user' })
      ]
    });
    await release();
    await reopened.close();
  });

  it('rebuilds missing resume indexes from legacy Todo snapshots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-resume-index-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 1,
        items: [{ id: 'inspect', step: 'Inspect', status: 'in_progress' }]
      }
    });
    await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 2,
        items: [{ id: '', step: 'Invalid', status: 'pending' }]
      }
    });
    await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 1,
        items: [
          { id: 'inspect', step: 'Inspect', status: 'completed' },
          { id: 'fix', step: 'Fix', status: 'in_progress' }
        ]
      }
    });
    await store.compact(session.id, { summary: 'legacy summary' });
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const disk = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{
        id: string;
        automaticTitlePending?: boolean;
        resume?: unknown;
      }>;
    };
    const indexed = disk.sessions.find((item) => item.id === session.id)!;
    delete indexed.automaticTitlePending;
    delete indexed.resume;
    await writeFile(indexPath, JSON.stringify(disk));

    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    await expect(reopened.readExecutionState(session.id)).resolves.toMatchObject({
      automaticTitlePending: true,
      todo: {
        revision: 2,
        items: [
          { id: 'inspect', step: 'Inspect', status: 'completed' },
          { id: 'fix', step: 'Fix', status: 'in_progress' }
        ]
      },
      contextRecords: [expect.objectContaining({ type: 'compact.completed' })]
    });
    await release();
    await reopened.close();

    const rebuilt = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{
        id: string;
        automaticTitlePending?: boolean;
        resume?: {
          version?: number;
          compactSequence?: number;
          todoSequence?: number;
          todoRevision?: number;
        };
      }>;
    };
    expect(rebuilt.sessions.find((item) => item.id === session.id)).toMatchObject({
      automaticTitlePending: true,
      resume: {
        version: 1,
        compactSequence: 5,
        todoSequence: 4,
        todoRevision: 2
      }
    });
  });

  it('rejects stale resume indexes that point before newer Compact and Todo records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-stale-resume-index-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ title: 'Stale index', workspace: home });
    const firstTodo = await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 1,
        items: [{ id: 'inspect', step: 'Inspect', status: 'in_progress' }]
      }
    });
    const firstCompact = await store.compact(session.id, { summary: 'first summary' });
    await store.append(session.id, {
      type: 'todo.updated',
      payload: {
        revision: 2,
        items: [
          { id: 'inspect', step: 'Inspect', status: 'completed' },
          { id: 'fix', step: 'Fix', status: 'in_progress' }
        ]
      }
    });
    const latestCompact = await store.compact(session.id, { summary: 'latest summary' });
    const malformedCompact = await store.append(session.id, {
      type: 'compact.completed',
      payload: { summary: '   ' }
    });
    await store.close();

    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const disk = JSON.parse(await readFile(indexPath, 'utf8')) as {
      sessions: Array<{
        id: string;
        resume?: {
          version: 1;
          compactSequence?: number;
          todoSequence?: number;
          todoRevision: number;
        };
      }>;
    };
    const indexed = disk.sessions.find((item) => item.id === session.id)!;
    expect(indexed.resume?.compactSequence).toBe(latestCompact.sequence);
    indexed.resume = {
      version: 1,
      compactSequence: firstCompact.sequence,
      todoSequence: firstTodo.sequence,
      todoRevision: 1
    };
    await writeFile(indexPath, JSON.stringify(disk));

    const reopened = await JsonlSessionStore.open(home);
    const release = await reopened.acquireSessionLease(session.id);
    const state = await reopened.readExecutionState(session.id);
    expect(state.todo).toEqual({
      revision: 2,
      items: [
        { id: 'inspect', step: 'Inspect', status: 'completed' },
        { id: 'fix', step: 'Fix', status: 'in_progress' }
      ]
    });
    expect(state.contextRecords[0]).toMatchObject({
      sequence: latestCompact.sequence,
      type: 'compact.completed'
    });
    expect(state.contextRecords.at(-1)).toMatchObject({
      sequence: malformedCompact.sequence,
      type: 'compact.completed'
    });
    await release();
    await reopened.close();

    const rebuilt = JSON.parse(await readFile(indexPath, 'utf8')) as typeof disk;
    expect(rebuilt.sessions.find((item) => item.id === session.id)?.resume?.compactSequence).toBe(
      latestCompact.sequence
    );
  });

  it('rolls large histories into bounded segments and pages from only the required tail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-segmented-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const payload = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 17; index++)
      await store.append(session.id, { type: 'large.record', payload: { index, payload } });
    const directory = join(home, '.mar', 'agent', 'sessions', session.id);
    expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([
      'events-000001.jsonl',
      'events-000002.jsonl'
    ]);
    expect(await store.readPage(session.id, { limit: 2 })).toMatchObject({
      records: [
        expect.objectContaining({ sequence: 17 }),
        expect.objectContaining({ sequence: 18 })
      ],
      previousBeforeSequence: 17
    });
    await store.close();
  });

  it('decodes only the JSONL tail needed by the requested history page', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-windowed-page-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, {
      type: 'large.old.record',
      payload: { text: 'x'.repeat(8 * 1024 * 1024) }
    });
    for (let index = 0; index < 100; index++)
      await store.append(session.id, { type: 'tail.record', payload: { index } });

    const path = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    const handle = await open(path, 'r+');
    try {
      await handle.write(Buffer.from('!'), 0, 1, 0);
    } finally {
      await handle.close();
    }

    await expect(store.read(session.id)).rejects.toMatchObject({
      code: 'MAR_AGENT_SESSION_CORRUPT'
    });
    await expect(store.readPage(session.id, { limit: 10 })).resolves.toMatchObject({
      records: Array.from({ length: 10 }, (_, offset) =>
        expect.objectContaining({ sequence: 93 + offset })
      ),
      previousBeforeSequence: 93
    });
    await store.close();
  });

  it('pages UTF-8 records across reverse-read chunk and cursor boundaries without gaps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-windowed-cursor-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    for (let index = 0; index < 130; index++)
      await store.append(session.id, {
        type: 'unicode.record',
        payload: {
          index,
          text: `${'界'.repeat((index % 17) * 257)}-${index}`
        }
      });
    const path = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    await appendFile(path, '{"incomplete":"tail');

    const newestToOldest: number[] = [];
    let beforeSequence: number | undefined;
    do {
      const page = await store.readPage(session.id, {
        limit: 7,
        ...(beforeSequence === undefined ? {} : { beforeSequence })
      });
      newestToOldest.unshift(...page.records.map((record) => record.sequence));
      beforeSequence = page.previousBeforeSequence;
    } while (beforeSequence !== undefined);
    expect(newestToOldest).toEqual(Array.from({ length: 131 }, (_, index) => index + 1));
    await store.close();
  });

  it('refreshes a concurrently replaced index and reconciles the JSONL tail under the lease', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-cross-process-home-'));
    homes.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const disk = JSON.parse(await readFile(indexPath, 'utf8')) as {
      revision: number;
      sessions: Array<Record<string, unknown>>;
    };
    disk.revision += 10;
    const externalId = '11111111-1111-4111-8111-111111111111';
    disk.sessions.push({
      id: externalId,
      title: 'External',
      workspace: home,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      nextSequence: 1,
      segments: []
    });
    await writeFile(indexPath, JSON.stringify(disk));
    expect((await store.list({ limit: 10 })).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: externalId })])
    );

    const eventPath = join(home, '.mar', 'agent', 'sessions', session.id, 'events-000001.jsonl');
    const first = JSON.parse((await readFile(eventPath, 'utf8')).trim()) as Record<string, unknown>;
    await appendFile(
      eventPath,
      `${JSON.stringify({ ...first, recordId: 'external-record', sequence: 5 })}\n`
    );
    const release = await store.acquireSessionLease(session.id);
    const appended = await store.append(session.id, { type: 'after.external', payload: {} });
    expect(appended.sequence).toBe(6);
    await release();
    await store.close();
  });
});
