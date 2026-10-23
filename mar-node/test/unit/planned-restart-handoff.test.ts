import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import {
  PlannedRestartHandoff,
  type RestartMessage,
  type RestartSession
} from '../../src/service/planned-restart-handoff.js';

const nodeId = 'node-planned-restart-test';
const serverUrl = 'https://server.example.test';
const workspace = {
  id: 'workspace-planned-restart-test',
  path: '/workspace',
  kind: 'DIRECTORY' as const,
  gitSummary: null,
  createdAt: 1,
  updatedAt: 1
};
const ownerUserId = 41;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'planned-restart-handoff-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(sessionIds = ['native-session']) {
  const runtime = new NodeRuntimeState(
    () => nodeId,
    (id) => (id === workspace.id ? workspace : undefined),
    () => 10_000
  );
  const sessions = sessionIds.map((externalSessionId) =>
    runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      externalSessionId,
      cwd: workspace.path,
      model: 'model-under-test',
      effort: 'high',
      access: 'full-access'
    })
  );
  const goals = new GoalRuntime(
    () => undefined,
    () => 20_000
  );
  const coordinator = new ContinuousRunCoordinator({
    runtime,
    emitQueue: vi.fn(),
    emitConversation: vi.fn(),
    clearImages: vi.fn(),
    cleanupAttachments: vi.fn(),
    migrateAssets: vi.fn(),
    emitRun: vi.fn(),
    control: vi.fn(),
    stopped: () => false,
    markInterrupted: vi.fn(),
    mcps: () => []
  });
  const activeCommands = new Set<string>();
  const diagnostics: { code: string; sessionId?: string }[] = [];
  return { runtime, sessions, goals, coordinator, activeCommands, diagnostics };
}

function prepareCurrent(
  f: ReturnType<typeof fixture>,
  session: ReturnType<typeof fixture>['sessions'][number],
  content: string,
  secret: string,
  suppressNotifications = false
) {
  const accepted = f.coordinator.accept({
    runId: 'run-' + session.id,
    sessionId: session.id,
    clientMessageId: 'client-' + session.id,
    content,
    suppressNotifications,
    initiatedByUserId: ownerUserId
  });
  f.coordinator.prepare(accepted.run.id, {
    runId: accepted.run.id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    executionContext: { runner: 'mar-agent' },
    input: content,
    clientMessageId: 'client-' + session.id,
    attachments: [],
    attachmentPaths: [],
    cwd: session.cwd,
    externalSessionId: session.externalSessionId,
    model: session.model,
    effort: session.effort,
    access: session.access,
    collaborationMode: 'default',
    secretEnvironment: { MODEL_API_SECRET: secret },
    restartMessage: { content, attachments: [], initiatedByUserId: ownerUserId }
  });
  return accepted.run;
}

function prepareQueue(
  f: ReturnType<typeof fixture>,
  session: ReturnType<typeof fixture>['sessions'][number],
  id: string,
  content: string,
  attachments: RestartMessage['attachments'] = [],
  suppressNotifications = false
) {
  const accepted = f.coordinator.accept({
    runId: id,
    sessionId: session.id,
    clientMessageId: 'client-' + id,
    content,
    attachments,
    suppressNotifications,
    initiatedByUserId: ownerUserId
  });
  if (accepted.queueItem === undefined) throw new Error('Expected an accepted queue item');
  const item = accepted.queueItem;
  f.coordinator.prepare(item.id, {
    runId: item.id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    executionContext: { runner: 'mar-agent' },
    input: content,
    clientMessageId: item.clientMessageId,
    attachments: [],
    attachmentPaths: [],
    cwd: session.cwd,
    externalSessionId: session.externalSessionId,
    model: session.model,
    effort: session.effort,
    access: session.access,
    collaborationMode: 'default',
    secretEnvironment: { QUEUED_MODEL_SECRET: 'must-not-be-persisted' },
    restartMessage: { content, attachments, initiatedByUserId: ownerUserId }
  });
  return item;
}

function handoff(
  f: ReturnType<typeof fixture>,
  directory: string,
  callbacks: {
    readonly goals?: GoalRuntime;
    readonly inputState?: (
      session: RestartSession,
      message: RestartMessage
    ) => Promise<'missing' | 'completed' | 'interrupted' | 'paused'>;
    readonly restore?: (session: RestartSession, handoffId: string) => Promise<void>;
    readonly diagnose?: (code: string, sessionId?: string) => void;
  } = {}
) {
  return new PlannedRestartHandoff({
    directory: () => directory,
    identity: () => ({ nodeId, serverUrl }),
    runtime: f.runtime,
    coordinator: f.coordinator,
    goals: callbacks.goals ?? f.goals,
    commandActive: (sessionId, command) => f.activeCommands.has(sessionId + ':' + command),
    inputState: callbacks.inputState ?? (async () => 'interrupted'),
    restore: callbacks.restore ?? (async () => undefined),
    diagnose:
      callbacks.diagnose ??
      ((code, sessionId) =>
        f.diagnostics.push({
          code,
          ...(sessionId === undefined ? {} : { sessionId })
        }))
  });
}

describe('PlannedRestartHandoff', () => {
  it('retains the initiating identity across consecutive restarts without a new Run', async () => {
    const directory = await temporaryDirectory();
    const first = fixture();
    const session = first.sessions[0]!;
    first.goals.start(session.id, 'Keep this paused objective');
    first.runtime.pauseSessionQueue(session.id);
    const writer = handoff(first, directory);
    writer.rememberUser(session.id, ownerUserId);
    await writer.publish(writer.capture());
    const next = fixture();
    const reader = handoff(next, directory, {
      restore: async (entry) => {
        next.goals.restoreRestartState(entry.goal!);
        next.runtime.pauseSessionQueue(entry.session.id);
      }
    });
    await reader.load();
    await reader.recover();
    expect(reader.capture().sessions).toMatchObject([
      { ownerUserId, paused: true, goal: { goal: { id: first.goals.get(session.id)!.id } } }
    ]);
  });

  it('captures and consumes interrupted work, FIFO attachments, pause intent, and exact Goal counters without secrets', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'unfinished current request', 'current-secret-value', true);
    const attachment = { name: 'diagram.png', mime: 'image/png', dataBase64: 'cG5nLWRhdGE=' };
    const first = prepareQueue(
      f,
      session,
      'queue-first',
      'first queued request',
      [attachment],
      true
    );
    const second = prepareQueue(f, session, 'queue-second', 'second queued request');
    f.coordinator.restoreImmediate(second.id);
    f.runtime.pauseSessionQueue(session.id);
    f.activeCommands.add(session.id + ':plan');
    f.goals.start(session.id, 'Finish the original objective', '<input-tag>keep</input-tag>');
    f.goals.recordTurn(session.id);
    f.goals.recordTurn(session.id);
    f.goals.recordExecutionResult(session.id, { failed: true, progressed: false });
    f.goals.recordExecutionResult(session.id, { failed: true, progressed: false });

    const writer = handoff(f, directory);
    const snapshot = writer.capture();
    expect(snapshot.sessions).toHaveLength(1);
    const entry = snapshot.sessions[0]!;
    expect(entry).toMatchObject({
      session: { id: session.externalSessionId, workspaceId: workspace.id, cwd: workspace.path },
      ownerUserId,
      paused: true,
      plan: true,
      awaitingGoal: false,
      suppressNotifications: true,
      current: {
        id: 'run-' + session.id,
        content: 'unfinished current request',
        suppressNotifications: true
      },
      queue: [
        {
          id: first.id,
          content: 'first queued request',
          attachments: [attachment],
          suppressNotifications: true,
          immediate: false
        },
        { id: second.id, content: 'second queued request', immediate: true }
      ],
      goal: {
        goal: {
          id: expect.any(String),
          sessionId: session.id,
          objective: 'Finish the original objective',
          inputTags: '<input-tag>keep</input-tag>',
          revision: 1,
          turns: 2,
          status: 'active'
        },
        executionFailures: 2
      }
    });
    expect(entry.queue[1]!.suppressNotifications).toBeUndefined();

    await writer.publish(snapshot);
    const manifestPath = join(directory, 'planned-restart-handoff.json');
    const persistedText = await readFile(manifestPath, 'utf8');
    const persisted = JSON.parse(persistedText) as typeof snapshot;
    expect(persistedText).not.toContain('current-secret-value');
    expect(persistedText).not.toContain('must-not-be-persisted');
    expect(persistedText).not.toContain('secretEnvironment');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);

    const restoredGoals = new GoalRuntime(
      () => undefined,
      () => 30_000
    );
    const restored: RestartSession[] = [];
    const reader = handoff(f, directory, {
      goals: restoredGoals,
      restore: async (restoredSession) => {
        restored.push(restoredSession);
        if (restoredSession.goal !== undefined)
          restoredGoals.restoreRestartState(restoredSession.goal);
      }
    });
    await reader.load();
    expect(reader.blocks(session.id)).toBe(true);
    expect(reader.blocksOperation('session.message', { sessionId: session.id })).toBe(true);
    expect(reader.blocksOperation('session.remove', { sessionId: session.id })).toBe(true);
    expect(reader.blocksOperation('session.rollback', { sessionId: session.id })).toBe(true);
    expect(reader.blocksOperation('session.config.update', { sessionId: session.id })).toBe(true);
    expect(reader.blocksOperation('workspace.queue.update', { queueItemId: first.id })).toBe(true);
    expect(reader.blocksOperation('session.watch', { sessionId: session.id })).toBe(false);
    expect(reader.blocksOperation('workspace.queue.get', { sessionId: session.id })).toBe(false);
    expect(reader.blocksOperation('session.message', { sessionId: 'unaffected-session' })).toBe(
      false
    );
    await Promise.all([reader.recover(), reader.recover()]);
    await reader.wait();

    expect(restored).toEqual([persisted.sessions[0]]);
    expect(restoredGoals.restartState(session.id)).toEqual(entry.goal);
    expect(reader.blocks(session.id)).toBe(false);
    await expect(readFile(manifestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(directory, 'planned-restart-handoff.processing.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await reader.recover();
    expect(restored).toHaveLength(1);
  });

  it('does not create or consume a manifest when there is no resumable state', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const restore = vi.fn(async () => undefined);
    const recovery = handoff(f, directory, { restore });

    const snapshot = recovery.capture();
    expect(snapshot.sessions).toEqual([]);
    await recovery.publish(snapshot);
    await recovery.load();
    await recovery.recover();

    expect(restore).not.toHaveBeenCalled();
    await expect(
      readFile(join(directory, 'planned-restart-handoff.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replay a processing manifest left by an interrupted prior startup', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const processingPath = join(directory, 'planned-restart-handoff.processing.json');
    await writeFile(
      processingPath,
      JSON.stringify({ schemaVersion: 1, sessions: [{ id: 'do-not-replay' }] })
    );
    const restore = vi.fn(async () => undefined);
    const recovery = handoff(f, directory, { restore });

    await recovery.load();
    await recovery.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(await readFile(processingPath, 'utf8')).toContain('do-not-replay');
  });

  it('does not resubmit an input already completed before the manifest was published', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'already completed input', 'not-persisted');
    const writer = handoff(f, directory, { inputState: async () => 'completed' });
    await writer.publish(writer.capture());

    const persisted = JSON.parse(
      await readFile(join(directory, 'planned-restart-handoff.json'), 'utf8')
    ) as {
      sessions: RestartSession[];
    };
    expect(persisted.sessions[0]?.current).toBeUndefined();
    const restored: RestartSession[] = [];
    const reader = handoff(f, directory, {
      restore: async (entry) => {
        restored.push(entry);
      }
    });
    await reader.load();
    await reader.recover();

    expect(restored).toHaveLength(1);
    expect(restored[0]?.current).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['unsupported schema', JSON.stringify({ schemaVersion: 2 })],
    [
      'wrong Node identity',
      JSON.stringify({
        schemaVersion: 1,
        id: 'handoff',
        nodeId: 'another-node',
        serverUrl,
        createdAt: 1,
        sessions: []
      })
    ]
  ])('rejects %s without restoring a session', async (_case, content) => {
    const directory = await temporaryDirectory();
    const f = fixture();
    await writeFile(join(directory, 'planned-restart-handoff.json'), content);
    const restore = vi.fn(async () => undefined);
    const recovery = handoff(f, directory, { restore });

    await recovery.load();
    await recovery.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(f.diagnostics).toContainEqual({ code: 'RESTART_HANDOFF_INVALID', sessionId: undefined });
    expect(recovery.blocks('native-session')).toBe(false);
  });

  it('isolates a failed session restore and leaves its processing file non-replayable', async () => {
    const directory = await temporaryDirectory();
    const f = fixture(['native-first', 'native-second']);
    for (const session of f.sessions)
      prepareCurrent(f, session, 'request for ' + session.id, 'no-secret');
    const writer = handoff(f, directory);
    await writer.publish(writer.capture());

    const attempted: string[] = [];
    const reader = handoff(f, directory, {
      restore: async (entry) => {
        attempted.push(entry.session.id);
        if (entry.session.id === 'native-first') throw new Error('controlled restore failure');
      }
    });
    await reader.load();
    await reader.recover();

    expect(attempted).toEqual(['native-first', 'native-second']);
    expect(f.diagnostics).toContainEqual({
      code: 'RESTART_SESSION_RESTORE_FAILED',
      sessionId: 'native-first'
    });
    const processingPath = join(directory, 'planned-restart-handoff.processing.json');
    expect(JSON.parse(await readFile(processingPath, 'utf8')).sessions).toHaveLength(2);

    const nextStartupAttempts: string[] = [];
    const nextStartup = handoff(f, directory, {
      restore: async (entry) => {
        nextStartupAttempts.push(entry.session.id);
      }
    });
    await nextStartup.load();
    await nextStartup.recover();
    expect(nextStartupAttempts).toEqual([]);
  });

  it('captures the edited QueueItem text rather than stale prepared input', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'active request', 'not-persisted');
    const item = prepareQueue(f, session, 'edited-item', 'old editor text');
    f.runtime.updateQueueItem(item.id, 'edited editor text');
    f.coordinator.updatePreparedInput(item.id, 'runner-prepared resource text');

    const snapshot = handoff(f, directory).capture();

    expect(snapshot.sessions[0]?.queue).toMatchObject([
      { id: item.id, content: 'edited editor text' }
    ]);
    expect(f.coordinator.pending(item.id)?.restartMessage?.content).toBe('edited editor text');
  });
});
