import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAgentSdkAdapter } from '../../src/claude-agent-sdk.js';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import {
  fakeServer,
  capabilities,
  codexProfileClientFactory,
  eventually
} from './support/codex-connector.js';

async function primeCodexProfile(connector: NodeConnector): Promise<void> {
  await (
    connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    }
  ).executeNodeOperation('runner.profiles.list', {});
}

function codexTurnRegistered(connector: NodeConnector, runId: string): boolean {
  const internals = connector as unknown as {
    runtime: { currentExecutionId(runId: string): string | undefined };
    codexClient: {
      execution: { runs: ReadonlyMap<string, { readonly turnId?: string }> };
    };
  };
  const executionId = internals.runtime.currentExecutionId(runId);
  if (executionId === undefined) return false;
  const run = (
    connector as unknown as {
      codexClient: {
        execution: { runs: ReadonlyMap<string, { readonly turnId?: string }> };
      };
    }
  ).codexClient.execution.runs.get(executionId);
  return typeof run?.turnId === 'string';
}

const emptyClaudeClient = {
  listSessions: async () => []
} as unknown as ClaudeAgentSdkAdapter;

let previousHome: string | undefined;
let isolatedHome: string;

beforeEach(async () => {
  previousHome = process.env.HOME;
  isolatedHome = await mkdtemp(join(tmpdir(), 'mar-codex-discovery-'));
  process.env.HOME = isolatedHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(isolatedHome, { recursive: true, force: true });
});

describe('Codex session discovery and first-message activation', () => {
  it('waits for slow external-session recovery before creating any Run, while concurrent messages share it', async () => {
    const database = new NodeDatabase(':memory:', 'node-deferred-codex-resume');
    database.saveWorkspace({
      id: 'workspace-1',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let releaseResume!: (value: unknown) => void;
    const resumeThread = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          releaseResume = resolve;
        })
    );
    const startTurn = vi.fn(async () => ({ turn: { id: 'turn-after-resume' } }));
    const client = {
      start: async () => undefined,
      stop: () => undefined,
      clearEnvironment: () => undefined,
      onNotification: () => () => undefined,
      resumeThread,
      startTurn
    } as unknown as CodexAppServerClient;
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: client,
      claudeClient: emptyClaudeClient
    });
    (
      connector as unknown as {
        runtime: {
          createAgentSession(input: {
            workspaceId: string;
            runner: 'codex';
            externalSessionId: string;
            cwd: string;
          }): unknown;
        };
      }
    ).runtime.createAgentSession({
      workspaceId: 'workspace-1',
      runner: 'codex',
      externalSessionId: 'slow-thread',
      cwd: '/workspace'
    });

    const execute = connector as unknown as {
      runtime: { listRunsForSession(sessionId: string): readonly unknown[] };
      executeNodeOperation(
        operation: string,
        data: unknown
      ): Promise<{ delivery: string; run: { id: string } }>;
    };
    const first = execute.executeNodeOperation('session.message', {
      sessionId: 'slow-thread',
      clientMessageId: 'deferred-resume-message',
      content: 'continue after recovery'
    });
    await eventually(() => resumeThread.mock.calls.length === 1);
    expect(execute.runtime.listRunsForSession('slow-thread')).toEqual([]);
    expect(startTurn).not.toHaveBeenCalled();
    const second = execute.executeNodeOperation('session.message', {
      sessionId: 'slow-thread',
      clientMessageId: 'deferred-resume-queued-message',
      content: 'queue after the same recovery'
    });
    expect(resumeThread).toHaveBeenCalledTimes(1);

    releaseResume({ thread: { id: 'slow-thread' } });
    await expect(first).resolves.toMatchObject({ delivery: 'STARTED' });
    await expect(second).resolves.toMatchObject({ delivery: 'QUEUED' });
    connector.stop();
  });

  it('discovers and selects sessions through thread/list without reading each official thread', async () => {
    const database = new NodeDatabase(':memory:', 'node-1');
    try {
      database.saveWorkspace({
        id: 'workspace-1',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      let readCount = 0;
      const client = {
        start: async () => undefined,
        onNotification: () => () => undefined,
        listThreads: async () => ({
          data: [
            ...Array.from({ length: 12 }, (_, index) => ({
              id: `thread-${index}`,
              source: 'vscode',
              cwd: '/workspace',
              name: `thread ${index}`
            })),
            {
              id: 'thread-subagent',
              sourceKind: 'cli',
              source: { subagent: { thread_spawn: { parent_thread_id: 'thread-0' } } },
              cwd: '/workspace',
              name: 'derived session'
            }
          ]
        }),
        readThread: async () => {
          readCount += 1;
          return { thread: { status: { type: 'idle' } } };
        }
      };
      const connector = new NodeConnector({
        reconnect: false,
        capabilities: capabilities(),
        database,
        codexClient: client as unknown as CodexAppServerClient,
        claudeClient: emptyClaudeClient
      });

      const discovered = await (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{ sessions: { externalSessionId: string }[] }>;
        }
      ).executeNodeOperation('session.discover', {
        runner: 'codex',
        workspaceId: 'workspace-1',
        limit: 20
      });

      expect(discovered.sessions).toHaveLength(12);
      await (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{ session: { readonly activity: string } }>;
        }
      ).executeNodeOperation('session.get', {
        sessionId: discovered.sessions[0]?.externalSessionId
      });
      expect(readCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps an overlong official title for display without creating a session record', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-long-title');
    try {
      database.saveWorkspace({
        id: 'workspace-long-title',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const title = 'long title'.repeat(50);
      const client = {
        start: async () => undefined,
        onNotification: () => () => undefined,
        listThreads: async () => ({
          data: [{ id: 'thread-long-title', source: 'vscode', cwd: '/workspace', name: title }]
        }),
        readThread: async () => ({
          thread: { id: 'thread-long-title', status: { type: 'idle' } }
        })
      };
      const connector = new NodeConnector({
        reconnect: false,
        capabilities: capabilities(),
        database,
        codexClient: client as unknown as CodexAppServerClient,
        claudeClient: emptyClaudeClient
      });
      const result = (await (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{ sessions: { runnerTitle: string | null }[] }>;
        }
      ).executeNodeOperation('session.list', {
        workspaceId: 'workspace-long-title'
      })) as { sessions: { runnerTitle: string | null }[] };

      expect(result.sessions[0]?.runnerTitle).toBe(title);
      expect(database.listSessionRecords('workspace-long-title')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('returns no session when there are neither local settings nor an external discovery', async () => {
    const database = new NodeDatabase(':memory:', 'node-1');
    try {
      database.saveWorkspace({
        id: 'workspace-1',
        path: '/workspace',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        capabilities: capabilities(),
        database,
        claudeClient: emptyClaudeClient
      });
      const result = (await (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{
            sessions: { externalSessionId: string | null; control: { level: string } }[];
          }>;
        }
      ).executeNodeOperation('session.list', {})) as {
        sessions: { externalSessionId: string | null; control: { level: string } }[];
      };
      expect(result.sessions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('uses the saved Composer configuration for the same Runner when recovering an external Codex thread', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-resume-defaults');
    database.saveWorkspace({
      id: 'workspace-codex-resume-defaults',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveRunnerDefaults({
      runner: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      access: 'workspace-write'
    });
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer]
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: codex,
      codexProfileClientFactory
    });
    await primeCodexProfile(connector);
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };

    try {
      const discovered = (await execute.executeNodeOperation('session.discover', {
        runner: 'codex',
        workspaceId: 'workspace-codex-resume-defaults'
      })) as { sessions: { id: string }[] };
      await expect(
        execute.executeNodeOperation('session.message', {
          sessionId: discovered.sessions[0]?.id,
          clientMessageId: 'resume-with-node-defaults',
          content: 'continue this session'
        })
      ).resolves.toMatchObject({
        session: {
          model: 'gpt-5.6-terra',
          effort: 'high',
          access: 'workspace-write'
        }
      });
    } finally {
      connector.stop();
    }
  });

  it('discovers VS Code threads only through the official App Server and recovers on the first message while idle', async () => {
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer]
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: codex,
      codexRunClientFactory: () =>
        new CodexAppServerClient({
          command: process.execPath,
          args: ['-e', fakeServer]
        }),
      codexProfileClientFactory
    });
    await primeCodexProfile(connector);
    const discovered = (await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{
          sessions: { id: string; runnerTitle: string | null; control: { level: string } }[];
        }>;
      }
    ).executeNodeOperation('session.discover', {
      runner: 'codex',
      workspaceId: 'workspace-1'
    })) as {
      sessions: { id: string; runnerTitle: string | null; control: { level: string } }[];
    };
    expect(discovered.sessions).toEqual([
      expect.objectContaining({
        runnerTitle: 'VS Code thread title',
        control: expect.objectContaining({ level: 'MANAGED' })
      })
    ]);
    await expect(
      (
        connector as unknown as {
          executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
        }
      ).executeNodeOperation('session.config.update', {
        sessionId: discovered.sessions[0]?.id,
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      })
    ).resolves.toMatchObject({
      session: {
        id: discovered.sessions[0]?.id,
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      }
    });
    await expect(
      (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{
            turns: { items: { kind: string; payload: { text?: string; title?: string } }[] }[];
          }>;
        }
      ).executeNodeOperation('session.turns.list', {
        sessionId: discovered.sessions[0]?.id,
        limit: 10
      })
    ).rejects.toThrow('NATIVE_TRANSCRIPT_UNAVAILABLE');
    expect(discovered.sessions[0]).toMatchObject({ activity: 'IDLE' });
    const created = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{
          session: { id: string; control: { level: string }; activity: string };
          run: { id: string };
          delivery: string;
          idempotent: boolean;
        }>;
      }
    ).executeNodeOperation('session.message', {
      sessionId: discovered.sessions[0]?.id,
      clientMessageId: 'continue-existing-thread',
      content: 'continue safely'
    });
    expect(created).toMatchObject({
      idempotent: false,
      delivery: 'STARTED',
      session: {
        model: 'gpt-5.6-sol',
        effort: 'high',
        access: 'full-access'
      }
    });
    expect(created.session.id).toBe(discovered.sessions[0]?.id);
    await eventually(() => codexTurnRegistered(connector, created.run.id));
    const repeated = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{
          session: { id: string };
          run: { id: string };
          delivery: string;
          idempotent: boolean;
        }>;
      }
    ).executeNodeOperation('session.message', {
      sessionId: discovered.sessions[0]?.id,
      clientMessageId: 'continue-existing-thread',
      content: 'continue safely'
    });
    expect(repeated).toMatchObject({
      session: { id: created.session.id },
      run: { id: created.run.id },
      idempotent: true
    });
    await eventually(() => codexTurnRegistered(connector, created.run.id));
    await (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation('run.cancel', { runId: created.run.id });
    await eventually(
      () =>
        !(
          connector as unknown as { runState: { active: ReadonlySet<string> } }
        ).runState.active.has(created.run.id),
      10_000
    );
    await connector.stop();
  }, 20_000);

  it('rejects an external Codex session already running elsewhere without creating a Run', async () => {
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({
      id: 'workspace-1',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: [
        '-e',
        fakeServer.replace(
          'result: { thread: { id: message.params.threadId } }',
          "error: { code: -32000, message: 'thread already has an active turn' }"
        )
      ]
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: codex
    });
    const discovered = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{ sessions: { id: string; activity: string }[] }>;
      }
    ).executeNodeOperation('session.discover', { runner: 'codex', workspaceId: 'workspace-1' });
    expect(discovered.sessions[0]).toMatchObject({ activity: 'IDLE' });
    const execute = connector as unknown as {
      runtime: { listRunsForSession(sessionId: string): readonly unknown[] };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    await expect(
      execute.executeNodeOperation('session.message', {
        sessionId: discovered.sessions[0]?.id,
        clientMessageId: 'must-not-send',
        content: 'do not race the external turn'
      })
    ).rejects.toThrow('RUNNER_RESUME_FAILED');
    expect(execute.runtime.listRunsForSession(discovered.sessions[0]!.id)).toEqual([]);
    codex.stop();
    database.close();
  });

  it('keeps every parsing entry point under the managed projection after recovering a notLoaded thread', async () => {
    const database = new NodeDatabase(':memory:', 'node-not-loaded-resume');
    database.saveWorkspace({
      id: 'workspace-1',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer.replace("type: 'idle'", "type: 'notLoaded'")]
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: codex,
      codexRunClientFactory: () =>
        new CodexAppServerClient({
          command: process.execPath,
          args: ['-e', fakeServer.replace("type: 'idle'", "type: 'notLoaded'")]
        })
    });
    const discovered = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{ sessions: { id: string }[] }>;
      }
    ).executeNodeOperation('session.discover', { runner: 'codex', workspaceId: 'workspace-1' });

    const result = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{ delivery: string; run: { id: string } }>;
      }
    ).executeNodeOperation('session.message', {
      sessionId: discovered.sessions[0]?.id,
      clientMessageId: 'not-loaded-message',
      content: 'resume without takeover'
    });
    expect(result).toMatchObject({ delivery: 'STARTED' });
    await eventually(
      () =>
        (
          connector as unknown as {
            runtime: { getAgentSession(id: string): { nativeControl: string } | undefined };
          }
        ).runtime.getAgentSession(discovered.sessions[0]!.id)?.nativeControl === 'MAR_MANAGED'
    );
    await eventually(() => codexTurnRegistered(connector, result.run.id));
    (
      connector as unknown as {
        codexRunController: {
          handleNotification(notification: {
            method: string;
            params: Record<string, unknown>;
          }): void;
        };
      }
    ).codexRunController.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'vscode-thread',
        turn: { id: 'turn-resumed', status: 'completed' }
      }
    });
    expect(
      (
        connector as unknown as { runtime: { getRun(id: string): { status: string } | undefined } }
      ).runtime.getRun(result.run.id)
    ).toBeUndefined();
    await connector.stop();
  });
});
