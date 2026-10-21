import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { SessionQueryService } from '../../src/service/session-query-service.js';
import { RunWorkbenchService } from '../../src/service/run-workbench-service.js';
import { SessionLifecycleService } from '../../src/service/session-lifecycle-service.js';
import { WorkspaceQueueWorkbenchService } from '../../src/service/workspace-queue-workbench-service.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-cli-context-'));
  directories.push(root);
  const workspaces = ['local', 'foreign'].map((id) => ({
    id,
    path: join(root, id),
    kind: 'DIRECTORY' as const,
    gitSummary: null,
    createdAt: 1,
    updatedAt: 1
  }));
  const workspace = (id: string) => workspaces.find((value) => value.id === id);
  const runtime = new NodeRuntimeState(() => 'node', workspace);
  const sessions = workspaces.map((value) =>
    runtime.createAgentSession({
      workspaceId: value.id,
      runner: 'codex',
      cwd: value.path,
      externalSessionId: 'native-' + value.id
    })
  );
  const history = vi.fn();
  const segments = vi.fn();
  const goal = vi.fn(() => ({ status: 'active' }));
  const queries = new SessionQueryService({
    queuedCount: () => 0,
    runtime,
    workspace,
    goal,
    resolve: async (id) => runtime.getAgentSession(id),
    similar: () => undefined,
    present: (session) => session,
    history,
    segments,
    context: { read: vi.fn() } as never,
    runners: {} as never,
    discover: async () => [],
    workspaceIdForCwd: (cwd) => workspaces.find((value) => value.path === cwd)?.id
  });
  return { runtime, sessions, queries, history, segments, goal, workspace };
}

it('reads cold Session details and queues without loading or resuming the Session', async () => {
  const f = await fixture();
  const saved = f.sessions[0]!;
  const foreign = f.sessions[1]!;
  f.runtime.removeAgentSession(saved.id);
  const resolve = vi.fn(async (id: string, registeredOnly?: boolean) => {
    expect(registeredOnly).toBe(true);
    return [saved, foreign].find((session) => session.id === id);
  });
  const queries = new SessionQueryService({
    queuedCount: () => 0,
    runtime: f.runtime,
    workspace: f.workspace,
    resolve,
    similar: () => undefined,
    present: (session) => session,
    goal: () => null,
    history: f.history,
    segments: f.segments,
    context: {} as never,
    runners: {} as never,
    discover: async () => [],
    workspaceIdForCwd: () => undefined
  }).operations();
  const emit = vi.fn();
  const coordinator = { resume: vi.fn() };
  const queues = new WorkspaceQueueWorkbenchService({
    runtime: f.runtime,
    resolve,
    coordinator: coordinator as never,
    emit,
    prepareInput: (_runner, input) => input
  }).operations();
  const input = { workspaceId: saved.workspaceId, sessionId: saved.id, registeredOnly: true };
  const compact = await queries['session.get']!({ ...input, view: 'marctl' });
  expect(compact).toMatchObject({
    view: 'marctl',
    workspaceId: saved.workspaceId,
    session: {
      id: saved.id,
      status: 'IDLE',
      runId: null,
      queuedCount: 0,
      latestMessage: null,
      recentTools: []
    }
  });
  expect(await queries['session.get']!(input)).toMatchObject({ session: { id: saved.id } });
  await expect(
    Promise.all([
      queries['session.runs']!(input),
      queues['workspace.queue.get']!(input),
      queries['session.goal.get']!(input)
    ])
  ).resolves.toEqual([
    { runs: [] },
    { queue: { version: 0, paused: false, items: [] } },
    { goal: null }
  ]);
  for (const sessionId of ['missing', foreign.id])
    await expect(queues['workspace.queue.get']!({ ...input, sessionId })).rejects.toThrow(
      'SESSION_NOT_FOUND'
    );
  expect(() => queues['workspace.queue.pause']!(input)).toThrow('SESSION_NOT_FOUND');
  expect(f.runtime.getAgentSession(saved.id)).toBeUndefined();
  expect(f.runtime.activeWorkspaceLeaseCount()).toBe(0);
  expect(emit).not.toHaveBeenCalled();
  expect(coordinator.resume).not.toHaveBeenCalled();
});

it('returns only the explicit current Workspace and scoped canonical Session', async () => {
  const { queries, sessions, runtime } = await fixture();
  const local = sessions[0]!;
  const operations = queries.operations();
  expect(await operations['session.cli.context']!({ workspaceId: 'local' })).toMatchObject({
    workspace: { id: 'local' },
    session: null,
    run: null
  });
  runtime.promoteSessionIdentity(local.id, 'promoted-local');
  expect(
    await operations['session.cli.context']!({ workspaceId: 'local', sessionId: local.id })
  ).toMatchObject({ session: { id: 'promoted-local' } });
  await expect(
    operations['session.cli.context']!({ workspaceId: 'local', sessionId: sessions[1]!.id })
  ).rejects.toThrow('SESSION_NOT_FOUND');
  await expect(operations['session.cli.context']!({ workspaceId: 'missing' })).rejects.toThrow(
    'WORKSPACE_NOT_FOUND'
  );
});

it('rejects foreign Session reads before history, context or Goal lookup', async () => {
  const { queries, sessions, history, segments, goal } = await fixture();
  for (const operation of [
    'session.get',
    'session.runs',
    'session.turns.list',
    'session.context.read',
    'session.goal.get'
  ]) {
    await expect(
      queries.operations()[operation]!({
        workspaceId: 'local',
        sessionId: sessions[1]!.id,
        unit: 'SEGMENT'
      })
    ).rejects.toThrow('SESSION_NOT_FOUND');
  }
  expect(() =>
    queries.operations()['session.events.read']!({
      workspaceId: 'local',
      sessionId: sessions[1]!.id
    })
  ).toThrow('SESSION_NOT_FOUND');
  expect(history).not.toHaveBeenCalled();
  expect(segments).not.toHaveBeenCalled();
  expect(goal).not.toHaveBeenCalled();
});

it('rejects foreign Run cancellation before changing its state or pausing its queue', async () => {
  const { runtime, sessions } = await fixture();
  const run = runtime.createMessageRun({
    sessionId: sessions[1]!.id,
    clientMessageId: 'foreign-message',
    content: 'fixture',
    initiatedByUserId: 7
  }).run;
  const pauseQueue = vi.fn();
  const control = vi.fn();
  const service = new RunWorkbenchService({
    runtime,
    pauseQueue,
    control,
    readImage: vi.fn(),
    respondUserInput: vi.fn(),
    runInterrupted: vi.fn(),
    emitRun: vi.fn(),
    markInterrupted: vi.fn()
  });
  expect(() =>
    service.operations()['run.cancel']!({ runId: run.id, workspaceId: 'local', __requestUserId: 7 })
  ).toThrow('RUN_NOT_FOUND');
  expect(runtime.getRun(run.id)?.status).toBe('STARTING');
  expect(pauseQueue).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
});

it('preserves an explicitly requested CLI title across native promotion and automatic titles', async () => {
  const { runtime, workspace } = await fixture();
  const service = new SessionLifecycleService({
    runtime,
    database: () =>
      ({
        getWorkspace: workspace,
        getRunnerDefaults: () => [],
        saveRunnerDefaults: vi.fn()
      }) as never,
    runners: {
      product: () => ({
        name: 'codex',
        defaultConfiguration: () => ({
          runner: 'codex',
          model: 'target-default',
          effort: 'low',
          access: 'read-only'
        })
      })
    } as never,
    projection: {} as never,
    identity: {} as never,
    present: (session) => session,
    emitSession: vi.fn(),
    invalidateWorkspaceSessions: vi.fn(),
    execute: vi.fn(),
    interceptedSessionId: () => undefined
  });
  const input = {
    runner: 'codex',
    workspaceId: 'local',
    cwd: '/fixture',
    customTitle: 'fixer#42 Preserve title'
  };
  const created = (await service.operations()['session.create']!(input)) as {
    session: { id: string };
  };
  runtime.promoteSessionIdentity(created.session.id, 'native-titled');
  runtime.setRunnerTitleFromNative('native-titled', 'Automatically generated title');
  expect(runtime.getAgentSession('native-titled')).toMatchObject({
    customTitle: input.customTitle,
    titleSource: 'CUSTOM'
  });
  expect(() => service.operations()['session.create']!({ ...input, customTitle: 42 })).toThrow(
    'SESSION_INVALID'
  );
});

it('preserves inline images and delegated notification policy on Session startup', async () => {
  const execute = vi.fn(async (operation: string) => {
    if (operation === 'session.create') return { session: { id: 'bootstrap' } };
    return { run: { id: 'run' }, delivery: 'STARTED', idempotent: false };
  });
  const service = new SessionLifecycleService({
    database: () => ({}) as never,
    runtime: {
      getAgentSession: () => ({ id: 'native' }),
      getRun: () => ({ id: 'run' }),
      conversationTurnForRun: () => ({ id: 'turn' })
    } as never,
    runners: {} as never,
    projection: {} as never,
    identity: { wait: async () => 'native', reject: vi.fn() } as never,
    present: (session) => session,
    emitSession: vi.fn(),
    invalidateWorkspaceSessions: vi.fn(),
    execute,
    interceptedSessionId: () => undefined
  });
  const attachments = [{ name: 'screen.png', mime: 'image/png', dataBase64: 'cG5n' }];
  await service.operations()['session.start']!({
    workspaceId: 'local',
    runner: 'codex',
    clientMessageId: 'image-only',
    __suppressNotifications: true,
    content: '',
    attachments
  });
  expect(execute).toHaveBeenCalledWith(
    'session.message',
    expect.objectContaining({ content: '', attachments, __suppressNotifications: true })
  );
  execute.mockClear();
  await expect(
    service.operations()['session.start']!({
      clientMessageId: 'invalid-image',
      content: '',
      attachments: [{ ...attachments[0], dataBase64: 'invalid base64' }]
    })
  ).rejects.toThrow('MESSAGE_ATTACHMENTS_INVALID');
  expect(execute).not.toHaveBeenCalled();
});

it('returns bounded released Run summaries for read-only Session queries without restoring execution state', async () => {
  const { runtime, sessions, queries } = await fixture();
  const run = runtime.createMessageRun({
    sessionId: sessions[0]!.id,
    clientMessageId: 'fast-input',
    content: 'fixture'
  }).run;
  runtime.transitionRun(run.id, 'RUNNING');
  runtime.transitionRun(run.id, 'SUCCEEDED');
  runtime.removeTerminalRun(run.id);
  expect(runtime.getRun(run.id)).toBeUndefined();
  expect(runtime.listRunsForSession(run.sessionId)).toEqual([]);
  const result = await queries.operations()['session.runs']!({
    sessionId: run.sessionId,
    workspaceId: 'local'
  });
  expect(result).toMatchObject({
    runs: [expect.objectContaining({ id: run.id, sessionId: run.sessionId, status: 'SUCCEEDED' })]
  });
  runtime.resetAgentSessionHistory(run.sessionId, Date.now());
  expect(runtime.listRunsForSession(run.sessionId, { includeTerminal: true })).toEqual([]);
  expect(() =>
    runtime.adoptRun({
      runId: run.id,
      sessionId: run.sessionId,
      runner: run.runner,
      cwd: '/fixture'
    })
  ).toThrow('RUN_TERMINAL');
});

it('evicts old terminal summaries at the existing bound and migrates their native Session identity', async () => {
  const { runtime, sessions } = await fixture();
  let oldest = '';
  for (let index = 0; index < 1025; index++) {
    const run = runtime.createMessageRun({
      sessionId: sessions[0]!.id,
      clientMessageId: 'terminal-' + index,
      content: 'fixture'
    }).run;
    oldest ||= run.id;
    runtime.transitionRun(run.id, 'RUNNING');
    runtime.transitionRun(run.id, 'SUCCEEDED');
    runtime.removeTerminalRun(run.id);
  }
  runtime.promoteSessionIdentity(sessions[0]!.id, 'native-terminal');
  const summaries = runtime.listRunsForSession('native-terminal', { includeTerminal: true });
  expect(summaries).toHaveLength(1024);
  expect(summaries.some((run) => run.id === oldest)).toBe(false);
  expect(
    summaries.every((run) => run.sessionId === 'native-terminal' && run.status === 'SUCCEEDED')
  ).toBe(true);
});
