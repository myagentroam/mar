import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionOperationContext } from '@myagentroam/agent/extensions';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import type { AgentNetworkService } from '../../src/service/agent-network-service.js';
import { invokeAgentNetwork } from '../../src/service/agent-network-invoke.js';
import { actorForAuthenticatedTerminal } from '../../src/service/agent-network-bindings.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-network-list-'));
  const database = new NodeDatabase(':memory:', 'network-list');
  const workspace = database.saveWorkspace({
    path: directory,
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const connector = new NodeConnector({ reconnect: false, database });
  cleanup.push(async () => {
    await connector.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const core = connector as unknown as {
    runtime: NodeRuntimeState;
    agentNetworkService: AgentNetworkService;
    nativeSessionProjectionService: NativeSessionProjectionService;
  };
  const create = (id: string, parentSessionId: string | null = null, title = id) =>
    core.runtime.createAgentSession({
      workspaceId: workspace.id,
      cwd: directory,
      runner: 'codex',
      externalSessionId: id,
      customTitle: title,
      parentSessionId
    });
  const list = (source: NodeAgentSession, input: Record<string, unknown> = {}) =>
    invokeAgentNetwork(
      core.agentNetworkService,
      { sessionId: source.id, requestUserId: 7 },
      'list',
      input,
      { signal: new AbortController().signal } as ExtensionOperationContext
    );
  const start = (session: NodeAgentSession) => {
    const { run } = core.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: `input-${session.id}`,
      content: 'Private input'
    });
    core.runtime.transitionRun(run.id, 'RUNNING');
    return run;
  };
  const terminalList = (input: Record<string, unknown> = {}) =>
    invokeAgentNetwork(
      core.agentNetworkService,
      actorForAuthenticatedTerminal({ sessionId: '', requestUserId: 7 }, workspace.id),
      'list',
      input
    );
  return { ...core, directory, workspace, database, create, list, terminalList, start };
}

describe('native Agent Network list', () => {
  it('prioritizes active Sessions, then sorts by activity without returning sort metadata', async () => {
    const f = await fixture();
    const root = f.create('root');
    const first = f.create('first', root.id);
    const second = f.create('second', root.id);
    const idle = f.create('idle', root.id);
    f.start(first);
    f.start(second);
    Object.assign(f.runtime.getAgentSession(root.id)!, { lastActivityAt: 0 });
    Object.assign(f.runtime.getAgentSession(first.id)!, { lastActivityAt: 100 });
    Object.assign(f.runtime.getAgentSession(second.id)!, { lastActivityAt: 200 });
    Object.assign(f.runtime.getAgentSession(idle.id)!, { lastActivityAt: 1000 });
    const result = (await f.list(root)) as { sessions: Array<Record<string, unknown>> };
    expect(result.sessions.map((session) => session.id)).toEqual([
      'second',
      'first',
      'idle',
      'root'
    ]);
    for (const session of result.sessions)
      expect(Object.keys(session).sort()).toEqual(['id', 'parentSessionId', 'status', 'title']);
  });

  it('defaults a trusted terminal without a Session to active without inventing an identity', async () => {
    const f = await fixture();
    const active = f.create('active');
    f.start(active);
    f.create('idle');
    expect(await f.terminalList()).toEqual({
      scope: 'active',
      currentAgentId: null,
      sessions: [{ id: 'active', parentSessionId: null, title: 'active', status: 'RUNNING' }],
      truncated: false
    });
    await expect(f.terminalList({ scope: 'tree' })).rejects.toThrow('AGENT_TARGET_REQUIRED');
  });

  it('validates the shared Node boundary rather than relying only on the tool or CLI schema', async () => {
    const f = await fixture();
    const source = f.create('source');
    for (const input of [
      { scope: 'profile' },
      { scope: 'children' },
      { cursor: 'next' },
      { agentId: 'other' },
      { limit: 101 },
      { limit: 0 },
      { limit: 1.5 },
      { limit: NaN },
      { limit: '1' },
      { query: 42 },
      { query: 'x'.repeat(161) }
    ]) {
      await expect(f.list(source, input)).rejects.toMatchObject({ code: 'AGENT_LIST_INVALID' });
      await expect(f.terminalList(input)).rejects.toMatchObject({ code: 'AGENT_LIST_INVALID' });
    }
  });
  it('defaults to the containing tree and returns only the agreed public fields', async () => {
    const f = await fixture();
    const root = f.create('root');
    const parent = f.create('parent', root.id);
    const source = f.create('source', parent.id);
    const sibling = f.create('sibling', parent.id);
    const child = f.create('child', source.id);
    f.create('independent');
    const before = f.runtime.listAgentSessions().length;
    const discover = vi.spyOn(f.nativeSessionProjectionService, 'discover');
    expect(await f.list(source)).toEqual({
      scope: 'tree',
      currentAgentId: source.id,
      sessions: [root, parent, sibling, source, child]
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id))
        .map((session) => ({
          id: session.id,
          parentSessionId: session.parentSessionId,
          title: session.customTitle,
          status: 'IDLE'
        })),
      truncated: false
    });
    expect(discover).not.toHaveBeenCalled();
    expect(f.runtime.listAgentSessions()).toHaveLength(before);
    expect(f.runtime.activeSessionRun(source.id)).toBeUndefined();
  });

  it('reuses registered tree metadata without per-session database or idle content reads', async () => {
    const f = await fixture();
    const source = f.create('source');
    for (let index = 0; index < 64; index++) {
      const suffix = index.toString().padStart(3, '0');
      f.database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: `registered-${suffix}`,
        workspaceId: f.workspace.id,
        customTitle: `Registered ${suffix}`,
        parentSessionId: source.id,
        initializeParent: true
      });
    }
    const records = vi.spyOn(f.database, 'getSessionRecord');
    const workspaces = vi.spyOn(f.database, 'getWorkspace');
    const content = vi.spyOn(f.runtime, 'conversationTail');
    const discover = vi.spyOn(f.nativeSessionProjectionService, 'discover');
    expect(await f.list(source, { query: 'Registered 063', limit: 1 })).toEqual({
      scope: 'tree',
      currentAgentId: source.id,
      sessions: [
        {
          id: 'registered-063',
          parentSessionId: source.id,
          title: 'Registered 063',
          status: 'IDLE'
        }
      ],
      truncated: false
    });
    expect(records).not.toHaveBeenCalled();
    expect(workspaces.mock.calls.length).toBeLessThanOrEqual(1);
    expect(content).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('keeps runtime and discovered native facts ahead of persisted list metadata', async () => {
    const f = await fixture();
    const source = f.create('source');
    f.create('live', source.id, 'Runtime title');
    for (const id of ['live', 'native'])
      f.database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: id,
        workspaceId: f.workspace.id,
        customTitle: 'Persisted title',
        parentSessionId: source.id,
        initializeParent: true
      });
    f.nativeSessionProjectionService.remember([
      {
        ...source,
        id: 'native',
        externalSessionId: 'native',
        nativeControl: 'EXTERNAL',
        parentSessionId: source.id,
        customTitle: 'Cached native title',
        lastActivityAt: 1000
      }
    ]);
    expect(await f.list(source, { query: 'Runtime title' })).toMatchObject({
      sessions: [{ id: 'live', title: 'Runtime title' }],
      truncated: false
    });
    expect(await f.list(source, { query: 'Cached native title' })).toMatchObject({
      sessions: [{ id: 'native', title: 'Cached native title' }],
      truncated: false
    });
    expect(await f.list(source, { query: 'Persisted title' })).toMatchObject({ sessions: [] });
  });

  it('includes registered idle ancestors and descendants without discovering Runner sessions', async () => {
    const f = await fixture();
    for (const [id, parentSessionId] of [
      ['root', null],
      ['archived-child', 'source']
    ] as const)
      f.database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: id,
        workspaceId: f.workspace.id,
        customTitle: id,
        parentSessionId,
        initializeParent: true
      });
    const source = f.create('source', 'root');
    const discover = vi.spyOn(f.nativeSessionProjectionService, 'discover');
    expect(await f.list(source)).toEqual({
      scope: 'tree',
      currentAgentId: source.id,
      sessions: expect.arrayContaining([
        { id: 'root', parentSessionId: null, title: 'root', status: 'IDLE' },
        { id: 'source', parentSessionId: 'root', title: 'source', status: 'IDLE' },
        {
          id: 'archived-child',
          parentSessionId: 'source',
          title: 'archived-child',
          status: 'IDLE'
        }
      ]),
      truncated: false
    });
    expect(((await f.list(source)) as { sessions: unknown[] }).sessions).toHaveLength(3);
    expect(discover).not.toHaveBeenCalled();
    expect(f.runtime.activeSessionRun('archived-child')).toBeUndefined();
  });

  it('selects active Runs across trees, including sleep, but excludes idle and foreign sessions', async () => {
    const f = await fixture();
    const source = f.create('source');
    const running = f.create('running');
    const sleeping = f.create('sleeping');
    const queued = f.create('queued');
    const completed = f.create('completed');
    f.start(running);
    const sleep = f.start(sleeping);
    f.runtime.appendRunEvent({
      runId: sleep.id,
      sequence: 1,
      eventType: 'conversation.item',
      payload: {
        itemId: 'sleep',
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        payload: {
          toolName: 'sleep',
          toolPresentation: {
            kind: 'SLEEP',
            durationMs: 1000,
            startedAt: '2026-10-30T01:00:00.000Z'
          }
        }
      }
    });
    f.runtime.createQueueItem({
      sessionId: queued.id,
      clientMessageId: 'queued',
      content: 'Waiting'
    });
    const finished = f.start(completed);
    f.runtime.transitionRun(finished.id, 'SUCCEEDED');
    const foreignWorkspace = f.database.saveWorkspace({
      path: join(f.directory, 'foreign'),
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const foreign = f.runtime.createAgentSession({
      workspaceId: foreignWorkspace.id,
      cwd: foreignWorkspace.path,
      runner: 'codex',
      externalSessionId: 'foreign'
    });
    f.start(foreign);
    expect(await f.list(source, { scope: 'active' })).toEqual({
      scope: 'active',
      currentAgentId: source.id,
      sessions: expect.arrayContaining([
        {
          id: running.id,
          parentSessionId: null,
          title: 'running',
          status: 'RUNNING'
        },
        {
          id: sleeping.id,
          parentSessionId: null,
          title: 'sleeping',
          status: 'SLEEPING'
        }
      ]),
      truncated: false
    });
    expect(await f.list(source, { scope: 'active', query: 'queued' })).toEqual({
      scope: 'active',
      currentAgentId: source.id,
      sessions: [],
      truncated: false
    });
    const active = (await f.list(source, { scope: 'active' })) as { sessions: unknown[] };
    expect(active.sessions).toHaveLength(2);
  });

  it('filters titles before applying the limit and reports truncation without pagination fields', async () => {
    const f = await fixture();
    const source = f.create('source');
    f.create('first', source.id, 'Other');
    Object.assign(f.create('second', source.id, 'ＴＡＳＫ One'), { lastActivityAt: 100 });
    Object.assign(f.create('third', source.id, 'Task Two'), { lastActivityAt: 200 });
    expect(await f.list(source, { query: ' task ', limit: 1 })).toEqual({
      scope: 'tree',
      currentAgentId: source.id,
      sessions: [
        {
          id: 'third',
          parentSessionId: source.id,
          title: 'Task Two',
          status: 'IDLE'
        }
      ],
      truncated: true
    });
    expect(await f.list(source, { query: 'missing', limit: 1 })).toEqual({
      scope: 'tree',
      currentAgentId: source.id,
      sessions: [],
      truncated: false
    });
  });

  it('defaults to ten Sessions, supports an explicit hundred and filters before truncation', async () => {
    const f = await fixture();
    const source = f.create('source');
    for (let index = 0; index < 99; index++)
      f.create(`child-${index.toString().padStart(3, '0')}`, source.id);
    const full = (await f.list(source)) as { sessions: unknown[]; truncated: boolean };
    expect(full.sessions).toHaveLength(10);
    expect(full.truncated).toBe(true);
    const explicit = (await f.list(source, { limit: 100 })) as {
      sessions: unknown[];
      truncated: boolean;
    };
    expect(explicit.sessions).toHaveLength(100);
    expect(explicit.truncated).toBe(false);
    f.create('last-child', source.id);
    const capped = (await f.list(source, { limit: 100 })) as {
      sessions: unknown[];
      truncated: boolean;
    };
    expect(capped.sessions).toHaveLength(100);
    expect(capped.truncated).toBe(true);
    expect(await f.list(source, { query: 'last-child' })).toMatchObject({
      sessions: [{ id: 'last-child' }],
      truncated: false
    });
  });

  it.each(['missing', 'foreign'])(
    'stops ancestry at a %s parent without exposing another Workspace',
    async (kind) => {
      const f = await fixture();
      if (kind === 'foreign') {
        const workspace = f.database.saveWorkspace({
          path: join(f.directory, 'foreign'),
          kind: 'DIRECTORY',
          gitSummary: null
        });
        f.runtime.createAgentSession({
          workspaceId: workspace.id,
          cwd: workspace.path,
          runner: 'codex',
          externalSessionId: 'outside'
        });
      }
      const source = f.create('source', 'outside');
      expect(await f.list(source)).toEqual({
        scope: 'tree',
        currentAgentId: source.id,
        sessions: [
          {
            id: source.id,
            parentSessionId: 'outside',
            title: 'source',
            status: 'IDLE'
          }
        ],
        truncated: false
      });
    }
  );

  it('rejects cyclic ancestry instead of hanging or returning a partial tree', async () => {
    const f = await fixture();
    const source = f.create('source', 'parent');
    f.create('parent', source.id);
    await expect(f.list(source)).rejects.toMatchObject({ code: 'SESSION_RELATION_INVALID' });
  });
});
