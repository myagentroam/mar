import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { ClaudeAgentSdkAdapter } from '../../src/runner/claude/claude-agent-sdk.js';
import type { CodexAppServerClient } from '../../src/runner/codex/codex-app-server.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { CommandStateStore } from '../../src/runner-command-engine.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { SessionIdentityService } from '../../src/session/session-identity-service.js';
import { SessionLifecycleService } from '../../src/session/session-lifecycle-service.js';
import type { RunAttachmentService } from '../../src/service/run-attachment-service.js';
import type { GoalRuntime } from '../../src/service/goal-runtime.js';
import { capabilities, codexProfileClientFactory } from './support/codex-connector.js';
import { executeNodeOperation } from './support/node-connector.js';
import {
  bindings,
  capabilities as claudeCapabilities,
  permissionStream
} from './support/claude-connector.js';

const cleanups: (() => void)[] = [];

function fixture() {
  const database = new NodeDatabase(':memory:', 'session-identity');
  const workspace = database.saveWorkspace({
    path: '/workspace/identity',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const onRunChanged = vi.fn();
  const runtime = new NodeRuntimeState(
    () => 'node',
    (id) => database.getWorkspace(id),
    Date.now,
    onRunChanged
  );
  const bootstrap = runtime.createAgentSession({
    workspaceId: workspace.id,
    cwd: workspace.path,
    runner: 'claude-code'
  });
  const persist = vi.fn();
  const emitSession = vi.fn();
  const releaseAttachments = vi.fn();
  const commands = new CommandStateStore();
  const hooks = {
    migrateAttachments: vi.fn(),
    validateCommands: vi.fn((previousId: string, nextId: string) =>
      commands.validateSessionIdentityPromotion(previousId, nextId)
    ),
    migrateCommands: vi.fn((previousId: string, nextId: string) =>
      commands.promoteSessionIdentity(previousId, nextId)
    ),
    migrateGoal: vi.fn(),
    migrateQueue: vi.fn(),
    migrateRunnerState: vi.fn(),
    emitRun: vi.fn(),
    emitQueue: vi.fn(),
    emitTurn: vi.fn()
  };
  const identity = new SessionIdentityService({
    runtime,
    persist,
    emitSession,
    releaseAttachments,
    ...hooks
  });
  identity.markBootstrap(bootstrap.id);
  cleanups.push(() => {
    identity.dispose();
    database.close();
  });
  return {
    database,
    workspace,
    runtime,
    bootstrap,
    identity,
    persist,
    emitSession,
    releaseAttachments,
    commands,
    hooks,
    onRunChanged
  };
}

afterEach(() => {
  try {
    for (const cleanup of cleanups.splice(0)) cleanup();
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

describe('Bootstrap Session identity retirement', () => {
  it.each([false, true])(
    'rejects a real metadata failure before mutating identity (active Run: %s)',
    async (active) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { database, runtime, bootstrap, identity, persist, hooks, emitSession } = fixture();
      database.raw.exec(
        "CREATE TRIGGER reject_identity BEFORE INSERT ON agent_sessions BEGIN SELECT RAISE(ABORT, 'IDENTITY_PERSIST_FAILED'); END"
      );
      persist.mockImplementation((session, nativeId) =>
        database.saveNativeSessionMetadata({
          runner: session.runner,
          workspaceId: session.workspaceId,
          externalSessionId: nativeId
        })
      );
      const run = active
        ? runtime.createMessageRun({
            sessionId: bootstrap.id,
            clientMessageId: 'input',
            content: 'hello'
          }).run
        : undefined;
      const rejected = vi.fn();
      void identity.wait(bootstrap.id).catch(rejected);
      let failure: unknown;
      try {
        identity.promote(bootstrap.id, 'native-failed');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: 'IDENTITY_PERSIST_FAILED' });
      expect(runtime.getAgentSession(bootstrap.id)?.id).toBe(bootstrap.id);
      expect(runtime.getAgentSession('native-failed')).toBeUndefined();
      expect(database.getSessionRecord('native-failed')).toBeUndefined();
      expect(hooks.migrateAttachments).not.toHaveBeenCalled();
      expect(hooks.migrateGoal).not.toHaveBeenCalled();
      expect(hooks.migrateCommands).not.toHaveBeenCalled();
      expect(hooks.migrateQueue).not.toHaveBeenCalled();
      expect(hooks.migrateRunnerState).not.toHaveBeenCalled();
      expect(emitSession).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
      expect(vi.getTimerCount()).toBe(0);
      if (run !== undefined) {
        expect(identity.bootstrapIds.has(bootstrap.id)).toBe(true);
        expect(() => identity.promote(bootstrap.id, 'late-native')).toThrow('SESSION_START_FAILED');
        runtime.transitionRun(run.id, 'FAILED');
        identity.reject(bootstrap.id, 'SESSION_START_FAILED');
        await Promise.resolve();
      }
      expect(runtime.getAgentSession(bootstrap.id)).toBeUndefined();
      expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
      expect(persist).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['empty-target', 'SESSION_EXTERNAL_ID_INVALID'],
    ['missing-source', 'SESSION_NOT_FOUND'],
    ['runtime-conflict', 'SESSION_ID_CONFLICT'],
    ['command-conflict', 'SESSION_ID_CONFLICT'],
    ['successful-alias', 'SESSION_NOT_FOUND']
  ] as const)(
    'settles preflight failure without touching the target: %s',
    async (scenario, code) => {
      const { database, workspace, runtime, bootstrap, identity, persist, hooks, commands } =
        fixture();
      const command = {
        commandId: 'plan',
        active: true,
        label: 'Plan',
        detail: '',
        closable: true,
        closeInput: '/plan'
      };
      const target = 'native-target';
      if (scenario === 'missing-source') runtime.removeAgentSession(bootstrap.id);
      if (scenario === 'runtime-conflict')
        runtime.createAgentSession({
          workspaceId: workspace.id,
          cwd: workspace.path,
          runner: 'claude-code',
          externalSessionId: target
        });
      if (scenario === 'successful-alias') {
        identity.promote(bootstrap.id, target);
        persist.mockClear();
        hooks.migrateCommands.mockClear();
        hooks.migrateRunnerState.mockClear();
        hooks.migrateAttachments.mockClear();
      }
      if (scenario === 'command-conflict') {
        commands.set(bootstrap.id, command);
        commands.set(target, command);
      }
      database.saveNativeSessionMetadata({
        runner: 'claude-code',
        workspaceId: workspace.id,
        externalSessionId: target,
        customTitle: 'Keep me'
      });
      const rejected = vi.fn();
      void identity.wait(bootstrap.id).catch(rejected);
      let failure: unknown;
      try {
        identity.promote(bootstrap.id, scenario === 'empty-target' ? '' : target);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: code });
      await Promise.resolve();
      expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
      expect(persist).not.toHaveBeenCalled();
      expect(hooks.migrateAttachments).not.toHaveBeenCalled();
      expect(hooks.migrateCommands).not.toHaveBeenCalled();
      expect(database.getSessionRecord(target)?.metadata.customTitle).toBe('Keep me');
      expect(hooks.migrateRunnerState).not.toHaveBeenCalled();
      if (scenario === 'runtime-conflict' || scenario === 'successful-alias')
        expect(runtime.getAgentSession(target)?.id).toBe(target);
      if (scenario === 'command-conflict') expect(commands.get(target, 'plan')).toEqual(command);
    }
  );

  it('publishes only after Runtime and every synchronous state migration have completed', async () => {
    const { runtime, bootstrap, identity, hooks, persist, emitSession, onRunChanged } = fixture();
    runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'first',
      content: 'hello'
    });
    const timeline: string[] = [];
    persist.mockImplementation(() => {
      timeline.push('persist');
    });
    for (const name of [
      'migrateAttachments',
      'migrateGoal',
      'migrateCommands',
      'migrateQueue',
      'migrateRunnerState'
    ] as const) {
      hooks[name].mockImplementation(() => {
        expect(runtime.getAgentSession(bootstrap.id)?.id).toBe('native-ordered');
        expect(runtime.getAgentSession('native-ordered')).toBeDefined();
        timeline.push(name);
      });
    }
    const waiting = identity.wait(bootstrap.id);
    for (const emit of [
      onRunChanged,
      emitSession,
      hooks.emitRun,
      hooks.emitQueue,
      hooks.emitTurn
    ]) {
      emit.mockImplementation(() => {
        expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
        timeline.push('publish');
      });
    }
    identity.promote(bootstrap.id, 'native-ordered');
    expect(timeline.slice(0, 6)).toEqual([
      'persist',
      'migrateAttachments',
      'migrateGoal',
      'migrateCommands',
      'migrateQueue',
      'migrateRunnerState'
    ]);
    expect(timeline.slice(6)).not.toHaveLength(0);
    expect(timeline.slice(6).every((step) => step === 'publish')).toBe(true);
    await expect(waiting).resolves.toBe('native-ordered');
    for (const migrate of [
      hooks.migrateAttachments,
      hooks.migrateGoal,
      hooks.migrateCommands,
      hooks.migrateQueue,
      hooks.migrateRunnerState
    ])
      expect(migrate).toHaveBeenCalledExactlyOnceWith(bootstrap.id, 'native-ordered');
  });

  it('migrates attachments independently when the Goal callback has no work', () => {
    const { bootstrap, identity, hooks } = fixture();
    hooks.migrateGoal.mockImplementation(() => undefined);
    identity.promote(bootstrap.id, 'native-attachments');
    expect(hooks.migrateAttachments).toHaveBeenCalledExactlyOnceWith(
      bootstrap.id,
      'native-attachments'
    );
  });

  it('rejects a generic identity waiter without retiring its ordinary Session', async () => {
    const { runtime, bootstrap, identity, persist, releaseAttachments } = fixture();
    identity.bootstrapIds.delete(bootstrap.id);
    const failure = new Error('METADATA_FAILED');
    persist.mockImplementation(() => {
      throw failure;
    });
    const rejected = vi.fn();
    void identity.wait(bootstrap.id).catch(rejected);
    expect(() => identity.promote(bootstrap.id, 'native-failed')).toThrow(failure);
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(runtime.getAgentSession(bootstrap.id)?.id).toBe(bootstrap.id);
    expect(runtime.getAgentSession('native-failed')).toBeUndefined();
    expect(releaseAttachments).not.toHaveBeenCalled();
  });

  it.each(['observer', 'session', 'run', 'queue', 'turn'] as const)(
    'keeps a fully committed identity successful when %s publication fails',
    async (stage) => {
      const { runtime, bootstrap, identity, hooks, emitSession, onRunChanged, releaseAttachments } =
        fixture();
      const first = runtime.createMessageRun({
        sessionId: bootstrap.id,
        clientMessageId: 'one',
        content: 'one'
      });
      runtime.transitionRun(first.run.id, 'SUCCEEDED');
      runtime.createMessageRun({ sessionId: bootstrap.id, clientMessageId: 'two', content: 'two' });
      onRunChanged.mockClear();
      const observedStates: unknown[] = [];
      onRunChanged.mockImplementation(() => {
        observedStates.push([
          hooks.migrateAttachments.mock.calls.length,
          hooks.migrateGoal.mock.calls.length,
          hooks.migrateCommands.mock.calls.length,
          hooks.migrateQueue.mock.calls.length,
          hooks.migrateRunnerState.mock.calls.length,
          identity.bootstrapIds.has(bootstrap.id)
        ]);
      });
      const callback = {
        observer: onRunChanged,
        session: emitSession,
        run: hooks.emitRun,
        queue: hooks.emitQueue,
        turn: hooks.emitTurn
      }[stage];
      callback.mockImplementationOnce(() => {
        throw new Error('PUBLICATION_FAILED');
      });
      const waiting = identity.wait(bootstrap.id);
      expect(() => identity.promote(bootstrap.id, 'native-success')).not.toThrow();
      await expect(waiting).resolves.toBe('native-success');
      expect(runtime.getAgentSession(bootstrap.id)?.id).toBe('native-success');
      expect(onRunChanged).toHaveBeenCalledTimes(2);
      expect(observedStates).toEqual(
        Array(stage === 'observer' ? 1 : 2).fill([1, 1, 1, 1, 1, false])
      );
      expect(emitSession).toHaveBeenCalledOnce();
      expect(hooks.emitRun).toHaveBeenCalledTimes(2);
      expect(hooks.emitQueue).toHaveBeenCalledOnce();
      expect(hooks.emitTurn).toHaveBeenCalledTimes(2);
      identity.reject(bootstrap.id, 'SESSION_START_FAILED');
      await Promise.resolve();
      expect(runtime.getAgentSession('native-success')).toBeDefined();
      expect(releaseAttachments).not.toHaveBeenCalled();
    }
  );

  it('preserves same-ID promotion without a waiter or extra Run observations', () => {
    const { runtime, bootstrap, identity, onRunChanged, hooks } = fixture();
    runtime.createMessageRun({ sessionId: bootstrap.id, clientMessageId: 'one', content: 'one' });
    onRunChanged.mockClear();
    identity.promote(bootstrap.id, bootstrap.id);
    expect(runtime.getAgentSession(bootstrap.id)?.externalSessionId).toBe(bootstrap.id);
    expect(onRunChanged).not.toHaveBeenCalled();
    expect(hooks.migrateAttachments).toHaveBeenCalledExactlyOnceWith(bootstrap.id, bootstrap.id);
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
  });

  it('preserves direct Runtime promotion when its post-commit observer fails', () => {
    const { runtime, bootstrap, onRunChanged } = fixture();
    const { run } = runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'direct',
      content: 'hello'
    });
    onRunChanged.mockClear();
    onRunChanged.mockImplementation(() => {
      throw new Error('PUBLICATION_FAILED');
    });
    expect(() => runtime.setExternalSessionId(bootstrap.id, 'native-direct')).not.toThrow();
    expect(onRunChanged).toHaveBeenCalledOnce();
    expect(runtime.getAgentSession(bootstrap.id)?.id).toBe('native-direct');
    expect(runtime.getRun(run.id)?.sessionId).toBe('native-direct');
  });

  it('keeps target command state when the source has no commands', () => {
    const { runtime, bootstrap, identity, commands } = fixture();
    const command = {
      commandId: 'plan',
      active: true,
      label: 'Plan',
      detail: '',
      closable: true,
      closeInput: '/plan'
    };
    commands.set('native-target', command);
    identity.promote(bootstrap.id, 'native-target');
    expect(runtime.getAgentSession('native-target')?.id).toBe('native-target');
    expect(commands.get('native-target', 'plan')).toEqual(command);
  });

  it('does not turn a committed start into failure when its Session publication throws', async () => {
    const { runtime, bootstrap, identity, emitSession, releaseAttachments } = fixture();
    emitSession.mockImplementation(() => {
      throw new Error('PUBLICATION_FAILED');
    });
    const execute = async (operation: string) => {
      if (operation === 'session.create') return { session: bootstrap };
      if (operation === 'session.message') {
        const { run } = runtime.createMessageRun({
          sessionId: bootstrap.id,
          clientMessageId: 'published',
          content: 'hello'
        });
        identity.promote(bootstrap.id, 'native-published');
        return { run, delivery: 'STARTED', idempotent: false };
      }
      throw new Error('Unexpected operation');
    };
    const lifecycle = new SessionLifecycleService({
      runtime,
      identity,
      runners: new RunnerRegistry([new ClaudeCodeRunner()]),
      execute,
      interceptedSessionId: () => undefined,
      present: (session: unknown) => session
    } as never);
    await expect(
      lifecycle.operations()['session.start']!({ clientMessageId: 'published', content: 'hello' })
    ).resolves.toMatchObject({ session: { id: 'native-published' } });
    expect(runtime.getAgentSession('native-published')).toBeDefined();
    expect(releaseAttachments).not.toHaveBeenCalled();
  });

  it('promotes a successful bootstrap and does not retire its native alias on later rejection', async () => {
    const { runtime, bootstrap, identity, persist, emitSession, releaseAttachments } = fixture();
    const waiting = identity.wait(bootstrap.id);
    identity.promote(bootstrap.id, 'native-success');
    await expect(waiting).resolves.toBe('native-success');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await Promise.resolve();
    expect(runtime.getAgentSession('native-success')?.id).toBe('native-success');
    expect(persist).toHaveBeenCalledExactlyOnceWith(bootstrap, 'native-success');
    expect(emitSession).toHaveBeenCalledOnce();
    expect(releaseAttachments).not.toHaveBeenCalled();
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
  });

  it('retires a timed-out bootstrap even after its waiter has settled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime, bootstrap, identity, persist, emitSession, releaseAttachments } = fixture();
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow(
      'SESSION_NATIVE_ID_TIMEOUT'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await waiting;
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await Promise.resolve();
    expect(runtime.getAgentSession(bootstrap.id)).toBeUndefined();
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
    expect(releaseAttachments).toHaveBeenCalledWith(bootstrap.id);
    expect(() => identity.promote(bootstrap.id, 'late-native')).toThrow();
    expect(persist).not.toHaveBeenCalled();
    expect(emitSession).not.toHaveBeenCalled();
  });

  it('keeps an active Run until terminal retry but rejects late promotion before any publication', async () => {
    const { runtime, bootstrap, identity, persist, emitSession } = fixture();
    const { run } = runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'first',
      content: 'hello'
    });
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow('SESSION_START_FAILED');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await waiting;
    expect(runtime.getAgentSession(bootstrap.id)).toBeDefined();
    expect(() => identity.promote(bootstrap.id, 'late-native')).toThrow('SESSION_START_FAILED');
    expect(runtime.getAgentSession('late-native')).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
    expect(emitSession).not.toHaveBeenCalled();
    runtime.transitionRun(run.id, 'FAILED');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await Promise.resolve();
    expect(runtime.getAgentSession(bootstrap.id)).toBeUndefined();
    expect(runtime.getRun(run.id)).toBeUndefined();
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await Promise.resolve();
  });

  it('blocks promotion synchronously before the deferred cleanup runs', async () => {
    const { runtime, bootstrap, identity, persist } = fixture();
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow('SESSION_START_FAILED');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    expect(() => identity.promote(bootstrap.id, 'same-tick-native')).toThrow(
      'SESSION_START_FAILED'
    );
    await waiting;
    expect(runtime.getAgentSession('same-tick-native')).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it('retries terminal cleanup after an earlier active-Run rejection settled the waiter', async () => {
    const { runtime, bootstrap, identity } = fixture();
    const { run } = runtime.createMessageRun({
      sessionId: bootstrap.id,
      clientMessageId: 'first',
      content: 'hello'
    });
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow('SESSION_START_FAILED');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await waiting;
    expect(runtime.getRun(run.id)?.status).toBe('STARTING');
    runtime.transitionRun(run.id, 'FAILED');
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await Promise.resolve();
    expect(runtime.getAgentSession(bootstrap.id)).toBeUndefined();
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
  });

  it('finishes retirement when another owner has already removed the Runtime object', async () => {
    const { runtime, bootstrap, identity } = fixture();
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow('SESSION_START_FAILED');
    runtime.removeAgentSession(bootstrap.id);
    identity.reject(bootstrap.id, 'SESSION_START_FAILED');
    await waiting;
    expect(identity.bootstrapIds.has(bootstrap.id)).toBe(false);
    expect(runtime.listAgentSessions()).toEqual([]);
  });

  it('settles pending identity waits on dispose without affecting a different Session', async () => {
    const { runtime, workspace, bootstrap, identity } = fixture();
    const other = runtime.createAgentSession({
      workspaceId: workspace.id,
      cwd: workspace.path,
      runner: 'codex'
    });
    const waiting = expect(identity.wait(bootstrap.id)).rejects.toThrow('NODE_STOPPED');
    identity.dispose();
    await waiting;
    expect(runtime.getAgentSession(other.id)).toBe(other);
    expect(identity.bootstrapIds.size).toBe(0);
  });

  it('times out non-bootstrap identity consumers without retiring their Session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime, workspace, identity } = fixture();
    const session = runtime.createAgentSession({
      workspaceId: workspace.id,
      cwd: workspace.path,
      runner: 'codex'
    });
    const waiting = expect(identity.wait(session.id)).rejects.toThrow('SESSION_NATIVE_ID_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30_000);
    await waiting;
    expect(runtime.getAgentSession(session.id)).toBe(session);
  });

  it('handles identity timeout during a pending command while preserving the command failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bootstrap, identity, runtime } = fixture();
    let failCommand!: (error: Error) => void;
    const command = new Promise((_resolve, reject) => {
      failCommand = reject;
    });
    const execute = vi.fn(async (operation: string) => {
      if (operation === 'session.create') return { session: bootstrap };
      if (operation === 'session.command.execute') return command;
      throw new Error('Unexpected operation');
    });
    const lifecycle = new SessionLifecycleService({ identity, runtime, execute } as never);
    const started = lifecycle.operations()['session.start']!({
      clientMessageId: 'command-start',
      content: 'hello',
      deferredCommands: [{ commandId: 'plan', input: 'on' }]
    });
    const failed = expect(started).rejects.toThrow('COMMAND_FAILED');
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith('session.command.execute', expect.anything());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.getAgentSession(bootstrap.id)).toBeUndefined();
    failCommand(new Error('COMMAND_FAILED'));
    await failed;
    expect(execute).not.toHaveBeenCalledWith('session.message', expect.anything());
  });
});

it('fails a Codex start on SQLite rejection without publishing before the first Turn, then starts fresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-identity-codex-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  const database = new NodeDatabase(':memory:', 'identity-codex');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  database.raw.exec(
    "CREATE TRIGGER reject_first_identity BEFORE INSERT ON agent_sessions WHEN NEW.id = 'failed-native' BEGIN SELECT RAISE(ABORT, 'IDENTITY_PERSIST_FAILED'); END"
  );
  let finishTurn!: (value: Awaited<ReturnType<CodexAppServerClient['startTurn']>>) => void;
  const firstTurn = new Promise<Awaited<ReturnType<CodexAppServerClient['startTurn']>>>(
    (resolve) => {
      finishTurn = resolve;
    }
  );
  const startTurn = vi
    .fn<CodexAppServerClient['startTurn']>()
    .mockReturnValueOnce(firstTurn)
    .mockResolvedValue({ turn: { id: 'fresh-turn' } });
  let thread = 0;
  const client = {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    configureEnvironment: () => undefined,
    clearEnvironment: () => undefined,
    startThread: async () => ({
      thread: { id: ++thread === 1 ? 'failed-native' : 'fresh-native' }
    }),
    startTurn,
    interruptTurn: async () => ({})
  } as unknown as CodexAppServerClient;
  const connector = new NodeConnector({
    reconnect: false,
    database,
    capabilities: capabilities(),
    codexClient: client,
    codexRunClientFactory: () => client,
    codexProfileClientFactory
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    sessionIdentityService: SessionIdentityService;
  };
  try {
    await executeNodeOperation(connector, 'runner.profiles.list', {});
    const started = executeNodeOperation(connector, 'session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      clientMessageId: 'failed',
      content: 'First attempt'
    });
    void started.catch(() => undefined);
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    const bootstrapId = [...node.sessionIdentityService.bootstrapIds][0]!;
    expect(bootstrapId).toBeTruthy();
    expect(node.runtime.getAgentSession(bootstrapId)?.externalSessionId).toBeNull();
    expect(database.getSessionRecord('failed-native')).toBeUndefined();
    finishTurn({ turn: { id: 'first-turn' } });
    await expect(started).rejects.toThrow('IDENTITY_PERSIST_FAILED');
    await vi.waitFor(() => expect(node.runtime.getAgentSession(bootstrapId)).toBeUndefined());
    expect(node.runtime.getAgentSession('failed-native')).toBeUndefined();
    expect(database.getSessionRecord('failed-native')).toBeUndefined();
    expect(node.sessionIdentityService.bootstrapIds.has(bootstrapId)).toBe(false);
    await expect(
      executeNodeOperation(connector, 'session.start', {
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: root,
        clientMessageId: 'fresh',
        content: 'Second attempt'
      })
    ).resolves.toMatchObject({ session: { id: 'fresh-native' } });
    expect(database.getSessionRecord('fresh-native')).toBeDefined();
  } finally {
    finishTurn({ turn: { id: 'first-turn' } });
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['success', 'validation failure', 'persistence failure'] as const)(
  'keeps the real Connector attachment phase separate, synchronous and gated on %s',
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'mar-identity-attachments-'));
    const directory = join(root, 'attachments');
    await mkdir(directory);
    const path = join(directory, 'notes.txt');
    await writeFile(path, 'retained input');
    const database = new NodeDatabase(':memory:', 'identity-attachments');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = new NodeConnector({
      database,
      capabilities: capabilities(),
      reconnect: false
    });
    const node = connector as unknown as {
      runtime: NodeRuntimeState;
      sessionIdentityService: SessionIdentityService;
      runAttachmentService: RunAttachmentService;
      goalRuntime: GoalRuntime;
      goalCoordinator: { migrateSession(previousId: string, nextId: string): void };
      goalMcpBridge: { migrateSession(previousId: string, nextId: string): void };
      commandStates: CommandStateStore;
      continuousRunCoordinator: { migrateSession(previousId: string, nextId: string): void };
      modelUsage: { promoteSession(previousId: string, nextId: string): void };
      runners: RunnerRegistry;
      publishWorkbenchEvent(category: string, payload: unknown): void;
    };
    try {
      const session = node.runtime.createAgentSession({
        workspaceId: workspace.id,
        cwd: root,
        runner: 'claude-code'
      });
      node.sessionIdentityService.markBootstrap(session.id);
      const goal = node.goalRuntime.start(session.id, 'Retain the accepted input');
      const attachments = node.runAttachmentService;
      attachments.adoptSessionFiles(session.id, 'input', [directory], workspace.id, [path]);
      const retained = attachments.state.sessionRetentions.get(session.id);
      const paths = attachments.state.runFileDirectories.get('input');
      const timeline: string[] = [];
      const promoteRuntime = node.runtime.promoteSessionIdentity.bind(node.runtime);
      vi.spyOn(node.runtime, 'promoteSessionIdentity').mockImplementation((...args) => {
        timeline.push('runtime');
        return promoteRuntime(...args);
      });
      const stages = [
        {
          label: 'attachments',
          call: attachments.migrateSession.bind(attachments),
          spy: vi.spyOn(attachments, 'migrateSession')
        },
        {
          label: 'goal',
          call: node.goalCoordinator.migrateSession.bind(node.goalCoordinator),
          spy: vi.spyOn(node.goalCoordinator, 'migrateSession')
        },
        {
          label: 'goal-mcp',
          call: node.goalMcpBridge.migrateSession.bind(node.goalMcpBridge),
          spy: vi.spyOn(node.goalMcpBridge, 'migrateSession')
        },
        {
          label: 'commands',
          call: node.commandStates.promoteSessionIdentity.bind(node.commandStates),
          spy: vi.spyOn(node.commandStates, 'promoteSessionIdentity')
        },
        {
          label: 'queue',
          call: node.continuousRunCoordinator.migrateSession.bind(node.continuousRunCoordinator),
          spy: vi.spyOn(node.continuousRunCoordinator, 'migrateSession')
        },
        {
          label: 'usage',
          call: node.modelUsage.promoteSession.bind(node.modelUsage),
          spy: vi.spyOn(node.modelUsage, 'promoteSession')
        },
        {
          label: 'runners',
          call: node.runners.migrateSessionIdentity.bind(node.runners),
          spy: vi.spyOn(node.runners, 'migrateSessionIdentity')
        }
      ];
      for (const stage of stages)
        stage.spy.mockImplementation((previousId, nextId) => {
          expect(node.runtime.getAgentSession(nextId)?.id).toBe(nextId);
          if (stage.label !== 'attachments')
            expect(attachments.state.runFileSessions.get('input')).toBe(nextId);
          timeline.push(stage.label);
          stage.call(previousId, nextId);
        });
      const publishing = vi.spyOn(node, 'publishWorkbenchEvent').mockImplementation(() => {
        expect(node.sessionIdentityService.bootstrapIds.has(session.id)).toBe(false);
        timeline.push('publish');
      });
      const waiting = node.sessionIdentityService.wait(session.id);
      if (outcome !== 'success') {
        if (outcome === 'persistence failure')
          database.raw.exec(
            "CREATE TRIGGER reject_attachment_identity BEFORE INSERT ON agent_sessions BEGIN SELECT RAISE(ABORT, 'IDENTITY_PERSIST_FAILED'); END"
          );
        const failure =
          outcome === 'validation failure'
            ? 'SESSION_EXTERNAL_ID_INVALID'
            : 'IDENTITY_PERSIST_FAILED';
        expect(() =>
          node.sessionIdentityService.promote(
            session.id,
            outcome === 'validation failure' ? '' : 'native-attachments'
          )
        ).toThrow(failure);
        await expect(waiting).rejects.toThrow(failure);
        for (const stage of stages) expect(stage.spy).not.toHaveBeenCalled();
        expect(timeline).toEqual([]);
        expect(publishing).not.toHaveBeenCalled();
        expect(node.goalRuntime.get(session.id)?.id).toBe(goal.id);
        return;
      }
      node.sessionIdentityService.promote(session.id, 'native-attachments');
      await expect(waiting).resolves.toBe('native-attachments');
      for (const stage of stages)
        expect(stage.spy).toHaveBeenCalledExactlyOnceWith(session.id, 'native-attachments');
      expect(timeline.slice(0, 8)).toEqual([
        'runtime',
        'attachments',
        'goal',
        'goal-mcp',
        'commands',
        'queue',
        'usage',
        'runners'
      ]);
      expect(timeline.slice(8)).not.toHaveLength(0);
      expect(timeline.slice(8).every((step) => step === 'publish')).toBe(true);
      expect(attachments.state.sessionRetentions.has(session.id)).toBe(false);
      expect(attachments.state.sessionRetentions.get('native-attachments')).toBe(retained);
      expect(attachments.state.runFileDirectories.get('input')).toBe(paths);
      expect(attachments.fileResource(workspace.id, attachments.resourcePath(path))).toBe(path);
      expect(node.goalRuntime.get('native-attachments')?.id).toBe(goal.id);
      await attachments.releaseSession(session.id);
      expect(await readFile(path, 'utf8')).toBe('retained input');
      await attachments.releaseSession('native-attachments');
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      await connector.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it('settles an accepted Claude start when its asynchronous identity persistence fails, then starts fresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-identity-claude-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  const database = new NodeDatabase(':memory:', 'identity-claude');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  database.raw.exec(
    "CREATE TRIGGER reject_first_identity BEFORE INSERT ON agent_sessions WHEN NEW.id = 'failed-claude' BEGIN SELECT RAISE(ABORT, 'IDENTITY_PERSIST_FAILED'); END"
  );
  let releaseIdentity!: () => void;
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let attempt = 0;
  const query = vi.fn<Parameters<typeof bindings>[0]>((input) => {
    if (typeof input.prompt === 'string') throw new Error('Expected managed Channel input');
    // Consume managed input before yielding the SDK's asynchronous identity event.
    const accepted = input.prompt[Symbol.asyncIterator]().next();
    const first = ++attempt === 1;
    let sentIdentity = false;
    return {
      ...permissionStream(() => undefined),
      async next() {
        if (!sentIdentity) {
          sentIdentity = true;
          await accepted;
          if (first) await identityGate;
          return {
            done: false as const,
            value: {
              type: 'system',
              subtype: 'init',
              session_id: first ? 'failed-claude' : 'fresh-claude'
            } as never
          };
        }
        await streamGate;
        return { done: true as const, value: undefined };
      }
    };
  });
  const connector = new NodeConnector({
    reconnect: false,
    database,
    capabilities: claudeCapabilities(),
    claudeClient: new ClaudeAgentSdkAdapter(bindings(query))
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    sessionIdentityService: SessionIdentityService;
  };
  try {
    const started = executeNodeOperation(connector, 'session.start', {
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: root,
      clientMessageId: 'failed',
      content: 'First attempt'
    });
    void started.catch(() => undefined);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const bootstrapId = [...node.sessionIdentityService.bootstrapIds][0]!;
    await vi.waitFor(() =>
      expect(node.runtime.activeSessionRun(bootstrapId)?.status).toBe('RUNNING')
    );
    releaseIdentity();
    await expect(started).rejects.toThrow('IDENTITY_PERSIST_FAILED');
    await vi.waitFor(() => expect(node.runtime.getAgentSession(bootstrapId)).toBeUndefined());
    expect(node.runtime.getAgentSession('failed-claude')).toBeUndefined();
    expect(database.getSessionRecord('failed-claude')).toBeUndefined();
    expect(node.sessionIdentityService.bootstrapIds.has(bootstrapId)).toBe(false);
    await expect(
      executeNodeOperation(connector, 'session.start', {
        workspaceId: workspace.id,
        runner: 'claude-code',
        cwd: root,
        clientMessageId: 'fresh',
        content: 'Second attempt'
      })
    ).resolves.toMatchObject({ session: { id: 'fresh-claude' } });
    expect(database.getSessionRecord('fresh-claude')).toBeDefined();
  } finally {
    releaseIdentity();
    releaseStream();
    try {
      await connector.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

it('keeps a timed-out start failed when a pending Runner returns an identity, then allows a fresh start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-bootstrap-start-'));
  const database = new NodeDatabase(':memory:', 'bootstrap-start');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  let finishTurn!: (value: Awaited<ReturnType<CodexAppServerClient['startTurn']>>) => void;
  const firstTurn = new Promise<Awaited<ReturnType<CodexAppServerClient['startTurn']>>>(
    (resolve) => {
      finishTurn = resolve;
    }
  );
  const startTurn = vi
    .fn<CodexAppServerClient['startTurn']>()
    .mockReturnValueOnce(firstTurn)
    .mockResolvedValue({ turn: { id: 'fresh-turn' } });
  let thread = 0;
  const client = {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    configureEnvironment: () => undefined,
    clearEnvironment: () => undefined,
    startThread: async () => ({ thread: { id: ++thread === 1 ? 'late-native' : 'fresh-native' } }),
    startTurn,
    interruptTurn: async () => ({})
  } as unknown as CodexAppServerClient;
  const connector = new NodeConnector({
    reconnect: false,
    database,
    capabilities: capabilities(),
    codexClient: client,
    codexRunClientFactory: () => client,
    codexProfileClientFactory
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    sessionIdentityService: SessionIdentityService;
  };
  try {
    await executeNodeOperation(connector, 'runner.profiles.list', {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = executeNodeOperation(connector, 'session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      clientMessageId: 'timed-out',
      content: 'First attempt'
    });
    const failed = expect(started).rejects.toThrow('SESSION_NATIVE_ID_TIMEOUT');
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    const bootstrapId = [...node.sessionIdentityService.bootstrapIds][0]!;
    expect(bootstrapId).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(node.runtime.getAgentSession(bootstrapId)).toBeDefined();
    finishTurn({ turn: { id: 'late-turn' } });
    await failed;
    await vi.waitFor(() => expect(node.runtime.getAgentSession(bootstrapId)).toBeUndefined());
    expect(node.runtime.getAgentSession('late-native')).toBeUndefined();
    expect(database.getSessionRecord('late-native')).toBeUndefined();
    expect(node.sessionIdentityService.bootstrapIds.has(bootstrapId)).toBe(false);
    vi.useRealTimers();
    const fresh = await executeNodeOperation(connector, 'session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      clientMessageId: 'fresh',
      content: 'Second attempt'
    });
    expect(fresh).toMatchObject({ session: { id: 'fresh-native' } });
    expect(database.getSessionRecord('fresh-native')).toBeDefined();
  } finally {
    finishTurn({ turn: { id: 'late-turn' } });
    vi.useRealTimers();
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});
