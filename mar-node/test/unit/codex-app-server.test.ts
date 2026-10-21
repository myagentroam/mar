import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerRpcError,
  CodexAppServerClient,
  codexSessionControl,
  isCodexRolloutMissingError,
  isSupportedCodexVersion,
  probeCodex
} from '../../src/codex-app-server.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import type { NodeAgentSession } from '../../src/database.js';

const fakeServer = `
let input = '';
let experimentalApi = false;
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\\n');
  input = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      experimentalApi = message.params?.capabilities?.experimentalApi === true;
      process.stdout.write(JSON.stringify({ method: 'test/clientInfo', params: { clientInfo: message.params?.clientInfo, secretInjected: process.env.API_KEY === 'run-secret' } }) + '\\n');
    }
    if (message.method === 'initialized') continue;
    if (message.method === 'collaborationMode/list') {
      if (!experimentalApi)
        process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'experimentalApi required' } }) + '\\n');
      else
        process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ mode: 'plan' }] } }) + '\\n');
      continue;
    }
    if (message.method === 'model/list') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ model: 'gpt-dynamic' }], nextCursor: null } }) + '\\n');
      continue;
    }
    if (message.method === 'thread/resume' && message.params?.threadId === 'missing-thread') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id missing-thread' } }) + '\\n');
      continue;
    }
    if (message.method === 'turn/start') {
      process.stdout.write(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 'approval-99', params: { threadId: 'thread-1', turnId: 'turn-1' } }) + '\\n');
    }
    if (message.id === 'approval-99') process.stdout.write(JSON.stringify({ method: 'approval.resolved', params: message.result }) + '\\n');
    process.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method, params: message.params } }) + '\\n');
  }
});`;

const lifecycleServer = `
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\\n');
  input = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialized') continue;
    const delay = message.method === 'initialize' ? 80 : message.method === 'thread/list' ? 60 : 0;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { method: message.method, processId: process.pid }
      }) + '\\n');
    }, delay);
  }
});`;

const threadLeaseServer = `
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  const lines = input.split('\\n');
  input = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialized') continue;
    if (message.method === 'thread/resume' && message.params?.threadId === 'missing-thread') {
      process.stdout.write(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: 'no rollout found' }
      }) + '\\n');
      continue;
    }
    const threadId = message.method === 'thread/fork' ? 'forked-thread' : message.params?.threadId;
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: { id: threadId } }
    }) + '\\n');
  }
});`;

describe('Codex App Server client', () => {
  it('keeps verified history capabilities when a later official list page omits the thread', async () => {
    const client = new CodexAppServerClient({ command: 'unused' });
    const list = vi
      .spyOn(client, 'listThreads')
      .mockResolvedValueOnce({
        data: [{ id: 'older', historyMode: 'paginated' }],
        nextCursor: 'more'
      })
      .mockResolvedValueOnce({ data: [{ id: 'newer', historyMode: 'legacy' }], nextCursor: 'more' })
      .mockResolvedValueOnce({ data: [{ id: 'older', historyMode: 'legacy' }] });
    const runner = new CodexRunner(client);
    const session = { id: 'session', externalSessionId: 'older' } as NodeAgentSession;
    try {
      await runner.listThreads();
      expect(runner.supportsRollback(session)).toBe(true);
      await runner.listThreads();
      expect(runner.supportsRollback(session)).toBe(true);
      await runner.listThreads();
      expect(runner.supportsRollback(session)).toBe(false);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      runner.stop();
    }
  });

  it('verifies an older thread through metadata once without restarting the history client', async () => {
    const client = new CodexAppServerClient({ command: 'unused' });
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    vi.spyOn(client, 'listThreads').mockResolvedValue({
      data: [{ id: 'newer', historyMode: 'legacy' }]
    });
    vi.spyOn(client, 'listThreadTurns').mockResolvedValue({ data: [], nextCursor: null });
    const read = vi.fn().mockResolvedValue({ thread: { id: 'older', historyMode: 'paginated' } });
    Object.assign(client, { readThread: read });
    const runner = new CodexRunner(client);
    const session = { id: 'session', externalSessionId: 'older' } as NodeAgentSession;
    try {
      await runner.listThreads();
      expect(runner.supportsRollback(session)).toBe(false);
      await runner.readOfficialConversation(session, {}, () => undefined);
      expect(runner.supportsRollback(session)).toBe(true);
      await runner.readOfficialConversation(session, {}, () => undefined);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith('older');
    } finally {
      runner.stop();
    }
  });

  it.each(['startThread', 'resumeThread'] as const)(
    'observes the native history mode returned by %s without requiring rediscovery',
    async (method) => {
      const client = new CodexAppServerClient({ command: 'unused' });
      vi.spyOn(client, method).mockResolvedValue({
        thread: { id: 'created', historyMode: 'paginated' }
      });
      const runner = new CodexRunner(client);
      try {
        if (method === 'startThread') await runner.startThread('/workspace');
        else await runner.resumeThread('created', '/workspace');
        expect(runner.supportsRollback({ externalSessionId: 'created' } as NodeAgentSession)).toBe(
          true
        );
      } finally {
        runner.stop();
      }
    }
  );

  it('shares concurrent metadata probes and does not retain their results after shutdown', async () => {
    const client = new CodexAppServerClient({ command: 'unused' });
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    vi.spyOn(client, 'listThreadTurns').mockResolvedValue({ data: [], nextCursor: null });
    let resolveMode!: (value: unknown) => void;
    const read = vi.spyOn(client, 'readThread').mockReturnValue(
      new Promise((resolve) => {
        resolveMode = resolve;
      })
    );
    const runner = new CodexRunner(client);
    const session = { id: 'session', externalSessionId: 'older' } as NodeAgentSession;
    try {
      const first = runner.readOfficialConversation(session, {}, () => undefined);
      const second = runner.readOfficialConversation(session, {}, () => undefined);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      runner.stop();
      resolveMode({ thread: { id: 'older', historyMode: 'paginated' } });
      await Promise.all([first, second]);
      expect(runner.supportsRollback(session)).toBe(false);
    } finally {
      runner.stop();
    }
  });

  it.each(['unavailable', 'foreign'] as const)(
    'keeps official history readable when its optional metadata is %s',
    async (mode) => {
      const client = new CodexAppServerClient({ command: 'unused' });
      vi.spyOn(client, 'start').mockResolvedValue(undefined);
      vi.spyOn(client, 'listThreadTurns').mockResolvedValue({ data: [], nextCursor: null });
      const read = vi.spyOn(client, 'readThread');
      if (mode === 'unavailable') read.mockRejectedValue(new Error('METADATA_UNAVAILABLE'));
      else read.mockResolvedValue({ thread: { id: 'other', historyMode: 'paginated' } });
      const runner = new CodexRunner(client);
      const session = { id: 'session', externalSessionId: 'older' } as NodeAgentSession;
      try {
        expect(await runner.readOfficialConversation(session, {}, () => undefined)).toEqual({
          turns: [],
          nextCursor: null
        });
        await runner.readOfficialConversation(session, {}, () => undefined);
        expect(read).toHaveBeenCalledTimes(1);
        expect(runner.supportsRollback(session)).toBe(false);
        expect(runner.supportsRollback({ externalSessionId: 'other' } as NodeAgentSession)).toBe(
          false
        );
      } finally {
        runner.stop();
      }
    }
  );

  it.each(['paginated', 'legacy', undefined] as const)(
    'reads %s history through the reused App Server and preserves cross-page Rewind boundaries',
    async (historyMode) => {
      const client = new CodexAppServerClient({ command: 'unused' });
      const factory = vi.fn(() => {
        throw new Error('History reads must not spawn temporary servers');
      });
      const runner = new CodexRunner(client, undefined, factory);
      vi.spyOn(client, 'start').mockResolvedValue(undefined);
      vi.spyOn(client, 'listThreads').mockResolvedValue({
        data: [{ id: 'native', historyMode }]
      });
      const nativeTurn = (id: string) => ({
        id,
        status: 'completed',
        itemsView: 'full',
        startedAt: 1,
        completedAt: 2,
        items: [{ id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: id }] }]
      });
      const list = vi
        .spyOn(client, 'listThreadTurns')
        .mockResolvedValueOnce({
          data: [nativeTurn('turn-3'), nativeTurn('turn-2')],
          nextCursor: 'older'
        })
        .mockResolvedValueOnce({ data: [nativeTurn('turn-1')], nextCursor: null })
        .mockResolvedValueOnce({ data: [nativeTurn('turn-1')], nextCursor: null })
        .mockResolvedValueOnce({ data: [], nextCursor: null });
      const session = {
        id: 'session',
        runner: 'codex',
        externalSessionId: 'native',
        cwd: '/workspace',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession;
      const native = vi.fn(() => {
        throw new Error('Old immutable JSONL must not be read');
      });
      try {
        await runner.listThreads();
        const page = await runner.readConversationHistory({
          session,
          native,
          official: () => runner.readOfficialConversation(session, { limit: 2 }, () => undefined)
        });
        expect(page?.source).toBe('official');
        expect(page?.turns.map((turn) => turn.rewind)).toEqual([
          { before: 'turn-1', after: 'turn-2' },
          { before: 'turn-2', after: 'turn-3' }
        ]);
        const older = await runner.readOfficialConversation(
          session,
          { cursor: page!.nextCursor!, limit: 2 },
          () => undefined
        );
        expect(older?.turns[0]?.rewind).toEqual({ before: null, after: 'turn-1' });
        expect(list).toHaveBeenNthCalledWith(3, 'native', { cursor: 'older', limit: 2 });
        await expect(
          runner.readOfficialConversation(session, {}, () => undefined)
        ).resolves.toEqual({
          turns: [],
          nextCursor: null
        });
        await expect(
          runner.readOfficialConversation(
            { ...session, id: 'other' },
            { cursor: page!.nextCursor! },
            () => undefined
          )
        ).rejects.toThrow('EVENT_CURSOR_INVALID');
        expect(native).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
      } finally {
        runner.stop();
      }
    }
  );

  it('never falls back to JSONL when official history is unavailable or fails', async () => {
    const runner = new CodexRunner(new CodexAppServerClient({ command: 'unused' }));
    const native = vi.fn();
    const official = vi.fn().mockResolvedValue(undefined);
    try {
      await expect(runner.readConversationHistory({ native, official })).resolves.toBeUndefined();
      official.mockRejectedValueOnce(new Error('RPC_UNAVAILABLE'));
      await expect(runner.readConversationHistory({ native, official })).rejects.toThrow(
        'RPC_UNAVAILABLE'
      );
      expect(native).not.toHaveBeenCalled();
    } finally {
      runner.stop();
    }
  });

  it.each(['paginated', 'legacy', undefined] as const)(
    'declares native Rollback only for official %s history and uses the excluded target Turn',
    async (historyMode) => {
      const client = new CodexAppServerClient({
        command: process.execPath,
        args: ['-e', fakeServer],
        timeoutMs: 1_000
      });
      const runner = new CodexRunner(client);
      vi.spyOn(client, 'listThreads').mockResolvedValue({
        data: [{ id: 'thread', historyMode }]
      });
      const resume = vi.spyOn(client, 'resumeThread').mockResolvedValue({
        thread: { id: 'thread', historyMode }
      });
      const revert = vi.spyOn(client, 'revertThread');
      const session = {
        id: 'thread',
        runner: 'codex',
        externalSessionId: 'thread',
        nativeControl: 'EXTERNAL',
        cwd: '/workspace',
        model: null,
        effort: null,
        access: null
      } as NodeAgentSession;
      try {
        expect(runner.supportsRollback(session)).toBe(false);
        await runner.listThreads();
        expect(runner.supportsRollback(session)).toBe(historyMode === 'paginated');
        if (historyMode === 'paginated') {
          await expect(
            runner.rollbackNative(session, 'kept-turn', 'excluded-turn')
          ).resolves.toEqual(expect.any(Number));
          expect(resume).toHaveBeenCalledWith('thread', '/workspace', {
            model: null,
            effort: null,
            access: null
          });
          expect(revert).toHaveBeenCalledWith('thread', 'excluded-turn');
          await expect(client.revertThread('thread', 'excluded-turn')).resolves.toEqual({
            method: 'thread/revert',
            params: { threadId: 'thread', beforeTurnId: 'excluded-turn' }
          });
        } else {
          await expect(runner.rollbackNative(session, null, 'excluded-turn')).rejects.toThrow(
            'SESSION_ROLLBACK_UNAVAILABLE'
          );
          expect(resume).not.toHaveBeenCalled();
          expect(revert).not.toHaveBeenCalled();
        }
      } finally {
        runner.stop();
        await client.stopAndWait();
      }
    }
  );

  it('rechecks Codex history mode before mutation and does not revert a stale capability', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000
    });
    const runner = new CodexRunner(client);
    vi.spyOn(client, 'listThreads').mockResolvedValue({
      data: [{ id: 'thread', historyMode: 'paginated' }]
    });
    vi.spyOn(client, 'resumeThread').mockResolvedValue({
      thread: { id: 'thread', historyMode: 'legacy' }
    });
    const revert = vi.spyOn(client, 'revertThread');
    const session = {
      id: 'thread',
      externalSessionId: 'thread',
      cwd: '/workspace'
    } as NodeAgentSession;
    try {
      await runner.listThreads();
      await expect(runner.rollbackNative(session, null, 'first-turn')).rejects.toThrow(
        'SESSION_ROLLBACK_UNAVAILABLE'
      );
      expect(revert).not.toHaveBeenCalled();
      expect(runner.supportsRollback(session)).toBe(false);
    } finally {
      runner.stop();
      await client.stopAndWait();
    }
  });

  it('forces a temporary App Server to exit if graceful stop stalls', async () => {
    const childProcesses: ReturnType<typeof spawn>[] = [];
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" + threadLeaseServer
      ],
      timeoutMs: 1_000,
      spawnProcess: (command, args, options) => {
        const child = spawn(command, args, options);
        childProcesses.push(child);
        return child;
      }
    });
    try {
      await client.start();
      await expect(client.stopAndWait()).resolves.toBeUndefined();
      expect(childProcesses[0]?.signalCode).toBe('SIGKILL');
    } finally {
      client.stop();
    }
  });

  it('releases a temporary App Server after external resume and native fork', async () => {
    const children: ReturnType<typeof spawn>[] = [];
    const runner = new CodexRunner(
      undefined,
      undefined,
      () =>
        new CodexAppServerClient({
          command: process.execPath,
          args: ['-e', threadLeaseServer],
          timeoutMs: 1_000,
          spawnProcess: (command, args, options) => {
            const child = spawn(command, args, options);
            children.push(child);
            return child;
          }
        })
    );
    const session = {
      id: 'existing-thread',
      externalSessionId: 'existing-thread',
      cwd: '/workspace',
      runner: 'codex',
      nativeControl: 'EXTERNAL',
      model: 'gpt-test',
      effort: 'medium',
      access: 'on-request'
    } as NodeAgentSession;
    try {
      await expect(
        runner.resumeExternal(session, {
          available: true,
          projectionFor: () => undefined,
          managedAliasFor: () => undefined,
          currentResumed: () => undefined,
          promote: () => undefined,
          ensureConfiguration: (external) => external,
          workspacePath: () => '/workspace',
          rememberManagedNative: () => undefined,
          create: (external) => external
        })
      ).resolves.toMatchObject({ activity: 'IDLE' });
      await expect(runner.forkNative(session, 'turn-1', 'Fork')).resolves.toBe('forked-thread');
      await expect(
        runner.resumeExternal(
          { ...session, externalSessionId: 'missing-thread' },
          {
            available: true,
            projectionFor: () => undefined,
            managedAliasFor: () => undefined,
            currentResumed: () => undefined,
            promote: () => undefined,
            ensureConfiguration: (external) => external,
            workspacePath: () => '/workspace',
            rememberManagedNative: () => undefined,
            create: (external) => external
          }
        )
      ).resolves.toMatchObject({ failureCode: 'RUNNER_RESUME_FAILED' });
      expect(children).toHaveLength(3);
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true
      );
    } finally {
      runner.stop();
    }
  });

  it('releases each completed Run even when another Run uses the same environment', async () => {
    const children: ReturnType<typeof spawn>[] = [];
    const runner = new CodexRunner(
      undefined,
      undefined,
      () =>
        new CodexAppServerClient({
          command: process.execPath,
          args: ['-e', threadLeaseServer],
          timeoutMs: 1_000,
          spawnProcess: (command, args, options) => {
            const child = spawn(command, args, options);
            children.push(child);
            return child;
          }
        })
    );
    const exited = async (child: ReturnType<typeof spawn>) => {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    };
    try {
      runner.prepareEnvironment({}, 'run-1');
      runner.prepareEnvironment({}, 'run-2');
      await Promise.all([runner.start('run-1'), runner.start('run-2')]);
      expect(children).toHaveLength(2);
      runner.releaseEnvironment('run-1');
      await exited(children[0]!);
      expect(children[1]!.exitCode).toBeNull();
      expect(children[1]!.signalCode).toBeNull();
      runner.releaseEnvironment('run-2');
      await exited(children[1]!);
    } finally {
      runner.stop();
    }
  });

  it('completes initialization, thread/Turn requests, notifications, and expectedTurnId steering', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000
    });
    const notifications: { method: string; requestId?: string | number }[] = [];
    client.onNotification((notification) => notifications.push(notification));
    client.configureEnvironment({ API_KEY: 'run-secret' });
    await client.start();
    await expect(client.startThread('/workspace')).resolves.toMatchObject({
      method: 'thread/start',
      params: { cwd: '/workspace', experimentalRawEvents: true }
    });
    await expect(client.resumeThread('thread-1', '/workspace')).resolves.not.toHaveProperty(
      'params.experimentalRawEvents'
    );
    await expect(client.forkThread('thread-1', '/workspace', 'turn-2')).resolves.not.toHaveProperty(
      'params.experimentalRawEvents'
    );
    await expect(
      client.startThread('/workspace', {
        model: 'gpt-5.6-sol',
        access: 'full-access',
        developerInstructions: 'inspect the tests before execution'
      })
    ).resolves.toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        model: 'gpt-5.6-sol',
        developerInstructions: 'inspect the tests before execution',
        sandbox: 'danger-full-access',
        approvalPolicy: 'never'
      }
    });
    await expect(
      client.startThread('/workspace', {
        mcpServers: {
          mar_goal: {
            command: 'node',
            args: ['/tmp/goal-mcp.mjs']
          }
        }
      })
    ).resolves.toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        config: {
          mcp_servers: {
            mar_goal: {
              command: 'node',
              args: ['/tmp/goal-mcp.mjs']
            }
          }
        }
      }
    });
    await expect(
      client.forkThread('thread-1', '/workspace', 'turn-2', {
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'read-only'
      })
    ).resolves.toMatchObject({
      method: 'thread/fork',
      params: {
        threadId: 'thread-1',
        lastTurnId: 'turn-2',
        cwd: '/workspace',
        model: 'gpt-5.6-sol',
        sandbox: 'read-only',
        approvalPolicy: 'on-request'
      }
    });
    await expect(client.steerTurn('thread-1', 'turn-1', 'continue')).resolves.toMatchObject({
      method: 'turn/steer',
      params: { threadId: 'thread-1', expectedTurnId: 'turn-1' }
    });
    await expect(
      client.startTurn(
        'thread-1',
        'create a migration plan',
        '/workspace',
        {
          model: 'gpt-5.6-sol',
          effort: 'high',
          access: 'read-only',
          serviceTier: 'fast',
          collaborationMode: 'plan',
          developerInstructions: 'inspect the tests before execution'
        },
        [{ type: 'localImage', path: '/tmp/myagentroam-attachment/design.png' }]
      )
    ).resolves.toMatchObject({
      method: 'turn/start',
      params: {
        input: [
          { type: 'text', text: 'create a migration plan' },
          { type: 'localImage', path: '/tmp/myagentroam-attachment/design.png' }
        ],
        model: 'gpt-5.6-sol',
        effort: 'high',
        sandboxPolicy: { type: 'readOnly' },
        approvalPolicy: 'on-request',
        serviceTier: 'fast',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.6-sol',
            reasoningEffort: 'high'
          }
        }
      }
    });
    await expect(client.listCollaborationModes()).resolves.toEqual({ data: [{ mode: 'plan' }] });
    await expect(client.readThread('thread-1')).resolves.toEqual({
      method: 'thread/read',
      params: { threadId: 'thread-1', includeTurns: false }
    });
    await expect(
      client.listModels({ cursor: null, limit: 100, includeHidden: false })
    ).resolves.toEqual({
      data: [{ model: 'gpt-dynamic' }],
      nextCursor: null
    });
    expect(notifications).toContainEqual(expect.objectContaining({ method: 'turn/started' }));
    expect(notifications).toContainEqual({
      method: 'test/clientInfo',
      params: {
        clientInfo: { name: 'codex_vscode', title: 'MyAgentRoam', version: '0.1.4' },
        secretInjected: true
      }
    });
    const approval = notifications.find((notification) => notification.requestId === 'approval-99');
    expect(approval).toMatchObject({ method: 'item/commandExecution/requestApproval' });
    client.respond('approval-99', { decision: 'accept' });
    client.stop();
  });

  it('encodes access permissions in the thread and Turn sandbox fields required by App Server', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000
    });
    await client.start();
    await expect(client.startThread('/workspace', { access: 'on-request' })).resolves.toMatchObject(
      {
        params: { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
      }
    );
    await expect(
      client.startTurn('thread-1', 'continue', '/workspace', { access: 'read-only' })
    ).resolves.toMatchObject({
      params: { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request' }
    });
    const turnWithoutEffort = await client.startTurn('thread-1', 'continue', '/workspace', {
      model: 'gpt-5.6-sol',
      effort: '',
      access: 'read-only',
      collaborationMode: 'default'
    });
    expect(turnWithoutEffort).toEqual(
      expect.objectContaining({
        params: expect.not.objectContaining({ effort: expect.anything() })
      })
    );
    expect(turnWithoutEffort).toMatchObject({
      params: {
        collaborationMode: {
          mode: 'default',
          settings: { model: 'gpt-5.6-sol', reasoningEffort: null }
        }
      }
    });
    client.stop();
  });

  it('preserves structured RPC errors and recognizes only rollout-missing semantics', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000
    });
    try {
      await client.start();
      const error = await client
        .resumeThread('missing-thread', '/workspace')
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(CodexAppServerRpcError);
      expect(error).toMatchObject({ code: -32600, rpcMessage: expect.stringContaining('rollout') });
      expect(isCodexRolloutMissingError(error)).toBe(true);
      expect(isCodexRolloutMissingError(new Error('CODEX_APP_SERVER_TIMEOUT'))).toBe(false);
    } finally {
      client.stop();
    }
  });

  it('ignores the old process exit callback after an immediate restart', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000
    });
    try {
      await client.start();
      client.stop();
      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(client.listThreads()).resolves.toMatchObject({ method: 'thread/list' });
    } finally {
      client.stop();
    }
  });

  it('shares one initialization handshake across concurrent starts', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', lifecycleServer],
      timeoutMs: 1_000
    });
    try {
      const first = client.start();
      let secondResolved = false;
      const second = client.start().then(() => {
        secondResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondResolved).toBe(false);
      await Promise.all([first, second]);
    } finally {
      client.stop();
    }
  });

  it('restarts a stopped App Server during Run initialization while the Run lease remains active', async () => {
    let spawnCount = 0;
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', lifecycleServer],
      timeoutMs: 1_000,
      spawnProcess: (command, args, options) => {
        spawnCount += 1;
        return spawn(command, args, options);
      }
    });
    const runner = new CodexRunner(client);
    runner.prepareEnvironment({}, 'run-1');
    try {
      const starting = runner.start('run-1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.stop();
      await expect(starting).resolves.toBeUndefined();
      expect(spawnCount).toBe(2);
      await expect(client.listThreads()).resolves.toMatchObject({ method: 'thread/list' });
    } finally {
      runner.releaseEnvironment('run-1');
      runner.stop();
    }
  });

  it('waits for sent requests during restart and holds new requests for the new instance', async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', lifecycleServer],
      timeoutMs: 1_000
    });
    try {
      await client.start();
      const existing = client.listThreads() as Promise<{
        method: string;
        processId: number;
      }>;
      const restart = client.restart();
      const afterRestart = client.listModels({
        cursor: null,
        limit: 100,
        includeHidden: false
      }) as Promise<{ method: string; processId: number }>;
      const [existingResult, afterRestartResult] = await Promise.all([
        existing,
        afterRestart,
        restart
      ]);
      expect(existingResult.method).toBe('thread/list');
      expect(afterRestartResult.method).toBe('model/list');
      expect(afterRestartResult.processId).not.toBe(existingResult.processId);
    } finally {
      client.stop();
    }
  });

  it('cancels pending recovery on explicit stop without relaunching the child process', async () => {
    let spawnCount = 0;
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', lifecycleServer],
      timeoutMs: 1_000,
      spawnProcess: (command, args, options) => {
        spawnCount += 1;
        return spawn(command, args, options);
      }
    });
    await client.start();
    const existing = client.listThreads();
    const restart = client.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.stop();
    await expect(existing).rejects.toThrow('CODEX_APP_SERVER_STOPPED');
    await expect(restart).rejects.toThrow('CODEX_APP_SERVER_STOPPED');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawnCount).toBe(1);
  });

  it('probes the actual Codex version without rejecting App Server by version number', () => {
    expect(probeCodex('definitely-not-installed-codex')).toEqual({
      available: false,
      compatible: false
    });
    expect(probeCodex()).toMatchObject({ available: true, compatible: true });
    expect(isSupportedCodexVersion(probeCodex().version ?? '')).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 0.147.0')).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 0.148.0')).toBe(true);
  });

  it('maps all visible sessions to unified controls while retaining active-run actions', () => {
    expect(
      codexSessionControl({
        available: false,
        nativeThreadId: 'thread-1',
        nativeControl: 'MAR_MANAGED',
        activeTurn: false
      })
    ).toEqual({ level: 'MANAGED', capabilities: ['history.read', 'turn.start'] });
    expect(
      codexSessionControl({
        available: true,
        nativeThreadId: 'foreign-thread',
        nativeControl: 'EXTERNAL',
        activeTurn: true
      })
    ).toEqual({
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.steer', 'turn.interrupt']
    });
    expect(
      codexSessionControl({
        available: true,
        nativeThreadId: 'thread-1',
        nativeControl: 'MAR_MANAGED',
        activeTurn: false
      })
    ).toEqual({ level: 'MANAGED', capabilities: ['history.read', 'turn.start'] });
    expect(
      codexSessionControl({
        available: true,
        nativeThreadId: 'thread-1',
        nativeControl: 'MAR_MANAGED',
        activeTurn: true
      })
    ).toEqual({
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.steer', 'turn.interrupt']
    });
  });

  it('initializes and lists models with the real App Server using the default transport', async () => {
    const client = new CodexAppServerClient({ timeoutMs: 5_000 });
    try {
      await client.start();
      const result = await client.listModels({ cursor: null, limit: 100, includeHidden: false });
      expect(result).toMatchObject({ data: expect.any(Array) });
    } finally {
      client.stop();
    }
  });

  it('launches the managed App Server once over stdio by default', async () => {
    const invocations: string[][] = [];
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer],
      timeoutMs: 1_000,
      spawnProcess: (command, args, options) => {
        invocations.push([...args]);
        return spawn(command, args, options);
      }
    });
    try {
      await client.start();
      await expect(client.listThreads()).resolves.toBeDefined();
      expect(invocations).toEqual([['-e', fakeServer]]);
    } finally {
      client.stop();
    }
  });
});
