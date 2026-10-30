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
  it('defaults a trusted terminal without a Session to active without inventing an identity', async () => {
    const f = await fixture();
    const active = f.create('active');
    f.start(active);
    f.create('idle');
    expect(await f.terminalList()).toEqual({
      currentAgentId: null,
      sessions: [
        { id: 'active', parentSessionId: null, title: 'active', runner: 'codex', status: 'RUNNING' }
      ],
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
      currentAgentId: source.id,
      sessions: [root, parent, sibling, source, child].map((session) => ({
        id: session.id,
        parentSessionId: session.parentSessionId,
        title: session.customTitle,
        runner: 'codex',
        status: 'IDLE'
      })),
      truncated: false
    });
    expect(discover).not.toHaveBeenCalled();
    expect(f.runtime.listAgentSessions()).toHaveLength(before);
    expect(f.runtime.activeSessionRun(source.id)).toBeUndefined();
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
      currentAgentId: source.id,
      sessions: [
        { id: 'root', parentSessionId: null, title: 'root', runner: 'codex', status: 'IDLE' },
        { id: 'source', parentSessionId: 'root', title: 'source', runner: 'codex', status: 'IDLE' },
        {
          id: 'archived-child',
          parentSessionId: 'source',
          title: 'archived-child',
          runner: 'codex',
          status: 'IDLE'
        }
      ],
      truncated: false
    });
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
      currentAgentId: source.id,
      sessions: expect.arrayContaining([
        {
          id: running.id,
          parentSessionId: null,
          title: 'running',
          runner: 'codex',
          status: 'RUNNING'
        },
        {
          id: sleeping.id,
          parentSessionId: null,
          title: 'sleeping',
          runner: 'codex',
          status: 'SLEEPING'
        }
      ]),
      truncated: false
    });
    expect(await f.list(source, { scope: 'active', query: 'queued' })).toEqual({
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
    f.create('second', source.id, 'ＴＡＳＫ One');
    f.create('third', source.id, 'Task Two');
    expect(await f.list(source, { query: ' task ', limit: 1 })).toEqual({
      currentAgentId: source.id,
      sessions: [
        {
          id: 'second',
          parentSessionId: source.id,
          title: 'ＴＡＳＫ One',
          runner: 'codex',
          status: 'IDLE'
        }
      ],
      truncated: true
    });
    expect(await f.list(source, { query: 'missing', limit: 1 })).toEqual({
      currentAgentId: source.id,
      sessions: [],
      truncated: false
    });
  });

  it('defaults to a 100-session cap and filters the full scope before truncation', async () => {
    const f = await fixture();
    const source = f.create('source');
    for (let index = 0; index < 99; index++)
      f.create(`child-${index.toString().padStart(3, '0')}`, source.id);
    const full = (await f.list(source)) as { sessions: unknown[]; truncated: boolean };
    expect(full.sessions).toHaveLength(100);
    expect(full.truncated).toBe(false);
    f.create('last-child', source.id);
    const capped = (await f.list(source)) as { sessions: unknown[]; truncated: boolean };
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
        currentAgentId: source.id,
        sessions: [
          {
            id: source.id,
            parentSessionId: 'outside',
            title: 'source',
            runner: 'codex',
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
