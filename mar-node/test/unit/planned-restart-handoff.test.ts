import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import { openRestartState, sealRestartState } from '../../src/service/restart-execution-state.js';
import {
  PlannedRestartHandoff,
  type PlannedRestart,
  type RestartMessage,
  type RestartSession
} from '../../src/service/planned-restart-handoff.js';
import type { RestartExecution } from '../../src/service/restart-execution-state.js';

const nodeId = 'node-planned-restart-test';
const serverUrl = 'https://server.example.test';
const nodeCredential = 'test-node-credential';
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
      modelId: 'model-under-test',
      effort: 'high',
      access: 'full-access'
    })
  );
  const goals = new GoalRuntime(
    () => undefined,
    () => 20_000
  );
  const coordinator = new ContinuousRunCoordinator({
    executionTerminating: () => undefined,
    keepRunActive: () => false,
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
  suppressNotifications = false,
  initiatedByUserId: number | null = ownerUserId
) {
  const accepted = f.coordinator.accept({
    runId: 'run-' + session.id,
    sessionId: session.id,
    clientMessageId: 'client-' + session.id,
    content,
    suppressNotifications,
    ...(initiatedByUserId === null ? {} : { initiatedByUserId })
  });
  const secretEnvironment = { MODEL_API_SECRET: secret };
  f.coordinator.prepare(accepted.run.id, {
    runId: accepted.run.id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    executionContext: {
      runner: 'mar-agent',
      runnerInput: {
        model: { id: 'model-under-test', credential: { type: 'INLINE_API_KEY', value: secret } },
        models: [{ id: 'model-under-test' }]
      }
    },
    input: content,
    clientMessageId: 'client-' + session.id,
    attachments: [],
    attachmentPaths: [],
    cwd: session.cwd,
    externalSessionId: session.externalSessionId,
    modelId: session.modelId,
    effort: session.effort,
    access: session.access,
    collaborationMode: 'default',
    secretEnvironment,
    personalInstructions: 'private instructions ' + secret,
    usageGrant: {
      scopeId: '00000000-0000-4000-8000-000000000001',
      token: 'usage-grant-' + secret
    },
    restartMessage: {
      content,
      attachments: [],
      ...(initiatedByUserId === null ? {} : { initiatedByUserId })
    }
  });
  return accepted.run;
}

function prepareQueue(
  f: ReturnType<typeof fixture>,
  session: ReturnType<typeof fixture>['sessions'][number],
  id: string,
  content: string,
  attachments: RestartMessage['attachments'] = [],
  suppressNotifications = false,
  secret = 'queued-model-secret',
  usageGrantToken = 'queued-usage-grant-secret',
  initiatedByUserId = ownerUserId
) {
  const accepted = f.coordinator.accept({
    runId: id,
    sessionId: session.id,
    clientMessageId: 'client-' + id,
    content,
    attachments,
    suppressNotifications,
    initiatedByUserId
  });
  if (accepted.queueItem === undefined) throw new Error('Expected an accepted queue item');
  const item = accepted.queueItem;
  f.coordinator.prepare(item.id, {
    runId: item.id,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    executionContext: {
      runner: 'mar-agent',
      runnerInput: {
        model: { id: 'model-under-test', credential: { type: 'INLINE_API_KEY', value: secret } },
        models: [{ id: 'model-under-test' }]
      }
    },
    input: content,
    clientMessageId: item.clientMessageId,
    attachments: [],
    attachmentPaths: [],
    cwd: session.cwd,
    externalSessionId: session.externalSessionId,
    modelId: session.modelId,
    effort: session.effort,
    access: session.access,
    collaborationMode: 'default',
    secretEnvironment: { QUEUED_MODEL_SECRET: secret },
    personalInstructions: 'private queued instructions ' + secret,
    usageGrant: {
      scopeId: '00000000-0000-4000-8000-000000000002',
      token: usageGrantToken
    },
    restartMessage: { content, attachments, initiatedByUserId }
  });
  return item;
}

function handoff(
  f: ReturnType<typeof fixture>,
  directory: string,
  callbacks: {
    readonly goals?: GoalRuntime;
    readonly credential?: () => string;
    readonly goalExecution?: (sessionId: string) => RestartExecution | undefined;
    readonly inputState?: (
      session: RestartSession,
      message: RestartMessage
    ) => Promise<'missing' | 'completed' | 'interrupted' | 'paused'>;
    readonly restore?: (session: RestartSession, handoffId: string) => Promise<void>;
    readonly diagnose?: (code: string, sessionId?: string, errorCode?: string) => void;
  } = {}
) {
  return new PlannedRestartHandoff({
    directory: () => directory,
    identity: () => ({ nodeId, serverUrl }),
    credential: callbacks.credential ?? (() => nodeCredential),
    runtime: f.runtime,
    coordinator: f.coordinator,
    goals: callbacks.goals ?? f.goals,
    ...(callbacks.goalExecution === undefined ? {} : { goalExecution: callbacks.goalExecution }),
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
  it('keeps the effective Goal configuration when only a retry context remains', async () => {
    const f = fixture();
    const session = f.sessions[0]!;
    f.goals.start(session.id, 'Continue after a model switch');
    const retry: RestartExecution = {
      configuration: { modelId: 'original-model', effort: 'low', access: 'read-only' }
    };
    const current = { modelId: 'effective-goal-model', effort: 'high', access: 'auto' };
    f.runtime.updateAgentSessionConfiguration({ sessionId: session.id, ...current });

    const saved = handoff(f, await temporaryDirectory(), { goalExecution: () => retry }).capture()!
      .sessions[0]!;

    expect(saved.current).toBeUndefined();
    expect(saved.execution!.configuration).toEqual(current);
  });

  it('keeps queued configuration but checkpoints the active input with its current effective configuration', async () => {
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'active input', 'active-secret');
    prepareQueue(f, session, 'queued', 'queued input');
    const activeConfiguration = {
      modelId: 'live-selected-model',
      effort: 'low',
      access: 'read-only'
    };
    f.runtime.updateAgentSessionConfiguration({ sessionId: session.id, ...activeConfiguration });
    const saved = handoff(f, await temporaryDirectory()).capture()!.sessions[0]!;

    expect(saved.current!.execution!.configuration).toEqual(activeConfiguration);
    expect(saved.queue[0]!.execution!.configuration).toEqual({
      modelId: 'model-under-test',
      effort: 'high',
      access: 'full-access'
    });
  });

  it('keeps the application error code when capture rejects an unready Session', async () => {
    const f = fixture([]);
    const session = f.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path
    });
    f.goals.start(session.id, 'Unfinished work');
    const writer = handoff(f, await temporaryDirectory());
    expect(() => writer.capture()).toThrow('RESTART_SESSION_NOT_READY');
    try {
      writer.capture();
      expect.unreachable('Capture must reject the unready Session');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RESTART_SESSION_NOT_READY' });
    }
  });

  it('retains an identity-free Goal execution checkpoint across consecutive restarts', async () => {
    const directory = await temporaryDirectory();
    const first = fixture();
    const session = first.sessions[0]!;
    first.goals.start(session.id, 'Keep this paused objective');
    first.runtime.pauseSessionQueue(session.id);
    const execution: RestartExecution = {
      configuration: { modelId: 'model-under-test', effort: 'high', access: 'full-access' }
    };
    const writer = handoff(first, directory, { goalExecution: () => execution });
    const snapshot = writer.capture();
    expect(snapshot.sessions[0]?.execution).toEqual(execution);
    expect(snapshot.sessions[0]).not.toHaveProperty('ownerUserId');
    expect(snapshot.sessions[0]?.execution).not.toHaveProperty('initiatedByUserId');
    await writer.publish(snapshot);
    const sealed = await readFile(join(directory, 'planned-restart-handoff.json'), 'utf8');
    const opened = openRestartState(sealed, nodeCredential) as PlannedRestart;
    expect(sealed).not.toContain('executionContext');
    expect(sealed).not.toContain('secretEnvironment');
    expect(JSON.stringify(opened)).not.toContain('executionContext');
    expect(JSON.stringify(opened)).not.toContain('secretEnvironment');
    expect(JSON.stringify(opened)).not.toContain('usageGrant');
    expect(JSON.stringify(opened)).not.toContain('personalInstructions');
    const next = fixture();
    const reader = handoff(next, directory, {
      goalExecution: () => execution,
      restore: async (entry) => {
        next.goals.restoreRestartState(entry.goal!);
        next.runtime.pauseSessionQueue(entry.session.id);
      }
    });
    await reader.load();
    await reader.recover();
    const nextSnapshot = reader.capture();
    expect(nextSnapshot.sessions).toMatchObject([
      {
        paused: true,
        execution: {
          configuration: execution.configuration
        },
        goal: { goal: { id: first.goals.get(session.id)!.id } }
      }
    ]);
    expect(nextSnapshot.sessions[0]).not.toHaveProperty('ownerUserId');
    expect(nextSnapshot.sessions[0]?.execution).not.toHaveProperty('initiatedByUserId');
  });

  it('captures execution checkpoints without inventing a Session owner', async () => {
    const directory = await temporaryDirectory();
    const f = fixture(['without-origin', 'with-origin']);
    prepareCurrent(f, f.sessions[0]!, 'first request', 'no-secret', false, null);
    prepareCurrent(f, f.sessions[1]!, 'second request', 'no-secret');
    const writer = handoff(f, directory);

    await writer.publish(writer.capture());

    const manifest = openRestartState(
      await readFile(join(directory, 'planned-restart-handoff.json'), 'utf8'),
      nodeCredential
    ) as PlannedRestart;
    expect(manifest.sessions).toHaveLength(2);
    const missing = manifest.sessions.find(
      (entry: RestartSession) => entry.session.id === 'without-origin'
    )!;
    expect(missing).not.toHaveProperty('ownerUserId');
    expect(missing.current?.execution).not.toHaveProperty('initiatedByUserId');
    expect(missing.current?.content).toBe('first request');
    const attributed = manifest.sessions.find(
      (entry: RestartSession) => entry.session.id === 'with-origin'
    )!;
    expect(attributed).not.toHaveProperty('ownerUserId');
    expect(attributed.current?.execution).toMatchObject({ initiatedByUserId: ownerUserId });
    const restored: RestartSession[] = [];
    const restore = vi.fn(async (entry: RestartSession) => {
      restored.push(entry);
    });
    const diagnose = vi.fn();
    const reader = handoff(f, directory, { restore, diagnose });
    await reader.load();
    await reader.recover();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restored.map((entry) => entry.session.id)).toEqual(['without-origin', 'with-origin']);
    expect(diagnose).not.toHaveBeenCalled();
    expect(f.diagnostics).toEqual([]);
  });

  it('captures a queued Goal continuation execution context separately from FIFO messages', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'active request before Goal', 'active-current-secret');
    const before = prepareQueue(f, session, 'before-goal', 'ordinary before Goal');
    const goal = f.goals.start(session.id, 'Continue the objective');
    const goalItem = prepareQueue(
      f,
      session,
      'goal-continuation',
      'Goal continuation input',
      [],
      false,
      'goal-model-secret',
      'goal-usage-grant-secret',
      ownerUserId
    );
    const goalInput = f.coordinator.pending(goalItem.id)!;
    f.coordinator.prepare(goalItem.id, {
      ...goalInput,
      modelId: 'goal-model',
      effort: 'low',
      access: 'read-only',
      goal: { id: goal.id, revision: goal.revision, epoch: 1 }
    });
    const after = prepareQueue(f, session, 'after-goal', 'ordinary after Goal');

    const writer = handoff(f, directory);
    const snapshot = writer.capture();
    const entry = snapshot.sessions[0]!;
    expect(entry.queue.map((message) => message.id)).toEqual([before.id, after.id]);
    expect(entry.execution).toEqual({
      configuration: { modelId: 'goal-model', effort: 'low', access: 'read-only' },
      initiatedByUserId: ownerUserId
    });
    expect(entry.queue.map((message) => message.execution?.initiatedByUserId)).toEqual([
      ownerUserId,
      ownerUserId
    ]);

    await writer.publish(snapshot);
    const sealed = await readFile(join(directory, 'planned-restart-handoff.json'), 'utf8');
    expect(sealed).not.toContain('goal-model-secret');
    expect(sealed).not.toContain('goal-usage-grant-secret');
    expect(sealed).not.toContain('private queued instructions');
    const opened = openRestartState(sealed, nodeCredential) as PlannedRestart;
    const openedText = JSON.stringify(opened);
    expect(openedText).not.toContain('goal-model-secret');
    expect(openedText).not.toContain('goal-usage-grant-secret');
    expect(openedText).not.toContain('private queued instructions');
    expect(openedText).not.toContain('executionContext');
    expect(openedText).not.toContain('secretEnvironment');
    expect(openedText).not.toContain('usageGrant');
    expect(openedText).not.toContain('personalInstructions');
    const restored: RestartSession[] = [];
    const reader = handoff(f, directory, {
      restore: async (restoredSession) => {
        restored.push(restoredSession);
      }
    });
    await reader.load();
    await reader.recover();

    expect(restored[0]?.execution).toEqual(entry.execution);
    expect(restored[0]?.queue.map((message) => message.id)).toEqual([before.id, after.id]);
  });

  it('seals credential-free checkpoints with interrupted work, FIFO state, and exact Goal counters', async () => {
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
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.sessions).toHaveLength(1);
    const entry = snapshot.sessions[0]!;
    expect(entry).toMatchObject({
      session: { id: session.externalSessionId, workspaceId: workspace.id, cwd: workspace.path },
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
    const persisted = openRestartState(persistedText, nodeCredential) as PlannedRestart;
    expect(persistedText).not.toContain('current-secret-value');
    expect(persistedText).not.toContain('queued-model-secret');
    expect(persistedText).not.toContain('queued-usage-grant-secret');
    expect(persistedText).not.toContain('private instructions');
    expect(persistedText).not.toContain('secretEnvironment');
    expect(persistedText).not.toContain('MODEL_API_SECRET');
    const persistedTextJson = JSON.stringify(persisted);
    expect(persistedTextJson).not.toContain('current-secret-value');
    expect(persistedTextJson).not.toContain('queued-model-secret');
    expect(persistedTextJson).not.toContain('queued-usage-grant-secret');
    expect(persistedTextJson).not.toContain('private instructions');
    expect(persistedTextJson).not.toContain('executionContext');
    expect(persistedTextJson).not.toContain('secretEnvironment');
    expect(persistedTextJson).not.toContain('personalInstructions');
    expect(persistedTextJson).not.toContain('usageGrant');
    expect(persisted.sessions[0]?.current?.execution).toEqual({
      configuration: { modelId: 'model-under-test', effort: 'high', access: 'full-access' },
      initiatedByUserId: ownerUserId
    });
    expect(persisted.sessions[0]?.queue[0]?.execution).toEqual({
      configuration: { modelId: 'model-under-test', effort: 'high', access: 'full-access' },
      initiatedByUserId: ownerUserId
    });
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

  it.each([1, 2, 3])(
    'rejects unsupported handoff schema v%s before restoring or blocking sessions',
    async (schemaVersion) => {
      const directory = await temporaryDirectory();
      const f = fixture();
      const session = f.sessions[0]!;
      prepareCurrent(f, session, 'resume after upgrade', 'unused-secret');
      prepareQueue(f, session, 'unsupported-queue', 'unsupported FIFO request');
      const snapshot = handoff(f, directory).capture();
      const unsupported = {
        ...snapshot,
        schemaVersion
      };
      await writeFile(
        join(directory, 'planned-restart-handoff.json'),
        sealRestartState(unsupported, nodeCredential)
      );

      const restore = vi.fn(async () => undefined);
      const reader = handoff(f, directory, { restore });
      await reader.load();
      expect(reader.blocks(session.externalSessionId!)).toBe(false);
      expect(f.diagnostics).toEqual([{ code: 'RESTART_HANDOFF_INVALID' }]);
      await reader.recover();
      await reader.wait();
      expect(restore).not.toHaveBeenCalled();
    }
  );

  it('rejects a handoff encrypted with a different Node credential', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    prepareCurrent(f, f.sessions[0]!, 'encrypted request', 'encrypted-secret');
    await handoff(f, directory).publish(handoff(f, directory).capture());
    const restore = vi.fn(async () => undefined);
    const reader = handoff(f, directory, {
      credential: () => 'different-node-credential',
      restore
    });

    await reader.load();
    await reader.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(f.diagnostics).toEqual([{ code: 'RESTART_HANDOFF_INVALID' }]);
    expect(reader.blocks('native-session')).toBe(false);
  });

  it('rejects a tampered authenticated handoff without restoring a session', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    prepareCurrent(f, f.sessions[0]!, 'encrypted request', 'encrypted-secret');
    const writer = handoff(f, directory);
    await writer.publish(writer.capture());
    const manifestPath = join(directory, 'planned-restart-handoff.json');
    const envelope = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      ciphertext: string;
    };
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] = ciphertext[0]! ^ 1;
    envelope.ciphertext = ciphertext.toString('base64');
    await writeFile(manifestPath, JSON.stringify(envelope));
    const restore = vi.fn(async () => undefined);
    const reader = handoff(f, directory, { restore });

    await reader.load();
    await reader.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(f.diagnostics).toEqual([{ code: 'RESTART_HANDOFF_INVALID' }]);
    expect(reader.blocks('native-session')).toBe(false);
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
    prepareCurrent(f, f.sessions[0]!, 'do-not-replay', 'processing-secret');
    const content = sealRestartState(handoff(f, directory).capture(), nodeCredential);
    const processingPath = join(directory, 'planned-restart-handoff.processing.json');
    await writeFile(processingPath, content);
    const restore = vi.fn(async () => undefined);
    const recovery = handoff(f, directory, { restore });

    await recovery.load();
    await recovery.recover();

    expect(restore).not.toHaveBeenCalled();
    expect(await readFile(processingPath, 'utf8')).toBe(content);
  });

  it('does not resubmit an input already completed before the manifest was published', async () => {
    const directory = await temporaryDirectory();
    const f = fixture();
    const session = f.sessions[0]!;
    prepareCurrent(f, session, 'already completed input', 'not-persisted');
    const writer = handoff(f, directory, { inputState: async () => 'completed' });
    await writer.publish(writer.capture());

    const persisted = openRestartState(
      await readFile(join(directory, 'planned-restart-handoff.json'), 'utf8'),
      nodeCredential
    ) as PlannedRestart;
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
    ['malformed current payload', sealRestartState({ schemaVersion: 4 }, nodeCredential)],
    [
      'wrong Node identity',
      sealRestartState(
        {
          schemaVersion: 4,
          id: 'handoff',
          nodeId: 'another-node',
          serverUrl,
          createdAt: 1,
          sessions: []
        },
        nodeCredential
      )
    ],
    [
      'wrong Server identity',
      sealRestartState(
        {
          schemaVersion: 4,
          id: 'handoff',
          nodeId,
          serverUrl: 'https://another-server.example.test',
          createdAt: 1,
          sessions: []
        },
        nodeCredential
      )
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
    const processingText = await readFile(processingPath, 'utf8');
    expect(processingText).not.toContain('no-secret');
    expect(
      (openRestartState(processingText, nodeCredential) as PlannedRestart).sessions
    ).toHaveLength(2);

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
