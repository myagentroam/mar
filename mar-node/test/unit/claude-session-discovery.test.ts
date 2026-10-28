vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { connectTestSocket } from './support/control-socket.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { ClaudeAgentSdkAdapter } from '../../src/runner/claude/claude-agent-sdk.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import type { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import type { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import {
  recordSent,
  bindings,
  pendingStream,
  nativeSessionThenPendingStream,
  capabilities,
  eventually
} from './support/claude-connector.js';

describe('Claude session discovery, resumption, and projection', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mar-claude-discovery-'));
    vi.stubEnv('HOME', directory);
    vi.stubEnv('USERPROFILE', directory);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retains the JSONL activity time on duplicate Claude SDK and JSONL discoveries and merges with Codex by activity time', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-discovery-order');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities()
    });
    const internals = connector as unknown as {
      sessionPresentationService: SessionPresentationService;
      externalSessionResumeService: ExternalSessionResumeService;
      claudeClient: ClaudeCodeRunner;
      nativeSessionProjectionService: NativeSessionProjectionService;
      directNativeSession(input: unknown): { readonly id: string };
      rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
      executeNodeOperation(
        operation: string,
        data: unknown
      ): Promise<{
        readonly sessions: readonly {
          readonly externalSessionId: string | null;
          readonly lastActivityAt: number;
          readonly runnerTitle: string | null;
        }[];
      }>;
    };
    const codex = internals.nativeSessionProjectionService.project({
      workspace,
      runner: 'codex',
      externalSessionId: 'codex-earlier',
      cwd: workspace.path,
      lastActivityAt: 100
    });
    internals.nativeSessionProjectionService.remember([codex]);
    const claude = internals.claudeClient.projectDiscoveredSessions(
      {
        workspaces: [workspace],
        createProjection: (input) =>
          internals.nativeSessionProjectionService.project(input) as never
      },
      workspace,
      [
        { externalSessionId: 'claude-latest', cwd: workspace.path, title: 'SDK title' },
        {
          runner: 'claude-code',
          externalSessionId: 'claude-latest',
          cwd: workspace.path,
          title: 'JSONL title',
          digest: 'native',
          items: [],
          lastActivityAt: 200
        }
      ]
    );
    internals.nativeSessionProjectionService.remember(claude);

    await expect(internals.executeNodeOperation('session.list', {})).resolves.toMatchObject({
      sessions: [
        {
          externalSessionId: 'claude-latest',
          lastActivityAt: 200,
          runnerTitle: 'JSONL title'
        },
        { externalSessionId: 'codex-earlier', lastActivityAt: 100 }
      ]
    });
    await connector.stop();
  });

  it('Claude SDK discovery keeps only the current workspace and filters other worktrees using the SDK-reported cwd', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-sdk-worktree-boundary');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const listSessions = vi.fn(async () => [
      {
        sessionId: 'other-worktree-session',
        summary: 'session from another worktree',
        lastModified: 100,
        cwd: `${directory}-other-worktree`
      },
      {
        sessionId: 'sidechain-session',
        summary: 'derived session',
        lastModified: 99,
        cwd: workspace.path,
        isSidechain: true,
        agentId: 'agent-child'
      },
      {
        sessionId: 'stable-title-session',
        summary: 'latest user message',
        firstPrompt: 'first user message',
        lastModified: 101,
        cwd: workspace.path
      },
      {
        sessionId: 'custom-title-session',
        summary: 'latest user message',
        firstPrompt: 'first user message',
        customTitle: 'Custom title',
        lastModified: 102,
        cwd: workspace.path
      }
    ]);
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: new ClaudeAgentSdkAdapter({
        ...bindings(() => pendingStream()),
        listSessions
      })
    });
    const execute = connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };

    await expect(
      execute.executeNodeOperation('session.discover', {
        runner: 'claude-code',
        workspaceId: workspace.id
      })
    ).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          externalSessionId: 'stable-title-session',
          runnerTitle: 'first user message'
        }),
        expect.objectContaining({
          externalSessionId: 'custom-title-session',
          runnerTitle: 'Custom title'
        })
      ])
    });
    expect(listSessions).toHaveBeenCalledWith({
      dir: workspace.path,
      includeWorktrees: false
    });
    await connector.stop();
  });

  it('shows external Claude history as a normal session and activates it after SDK validation of the first message', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-resume');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveRunnerDefaults({
      runner: 'claude-code',
      model: 'opus',
      effort: 'xhigh',
      access: 'bypass'
    });
    const sessionInfo = vi.fn(async () => ({ sessionId: 'cli-session' }));
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: { sessionInfo } as unknown as ClaudeAgentSdkAdapter
    });
    const external = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: {
            workspaceId: string;
            runner: 'claude-code';
            externalSessionId: string;
            cwd: string;
          }): { id: string };
        };
      }
    ).runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      externalSessionId: 'cli-session',
      cwd: workspace.path
    });

    const beforeMessage = await (
      connector as unknown as {
        executeNodeOperation(
          operation: string,
          data: unknown
        ): Promise<{
          session: {
            readonly activity: string;
            readonly control: { readonly level: string; readonly capabilities: readonly string[] };
          };
        }>;
      }
    ).executeNodeOperation('session.get', { sessionId: external.id });

    expect(beforeMessage).toMatchObject({
      session: {
        activity: 'IDLE',
        control: {
          level: 'MANAGED',
          capabilities: expect.arrayContaining(['history.read', 'turn.start'])
        }
      }
    });

    vi.useFakeTimers();
    try {
      const resumed = await (
        connector as unknown as {
          executeNodeOperation(
            operation: string,
            data: unknown
          ): Promise<{
            session: {
              readonly id: string;
              readonly activity: string;
              readonly control: { level: string };
              readonly model: string;
              readonly effort: string;
              readonly access: string;
            };
            run: { readonly sessionId: string };
          }>;
        }
      ).executeNodeOperation('session.message', {
        sessionId: external.id,
        clientMessageId: 'resume-claude-history',
        content: 'Continue this session'
      });

      expect(sessionInfo).toHaveBeenCalledWith('cli-session', workspace.path);
      expect(resumed).toMatchObject({
        session: {
          id: 'cli-session',
          activity: 'MANAGED_ACTIVE',
          control: { level: 'MANAGED' },
          model: 'opus',
          effort: 'xhigh',
          access: 'bypass'
        }
      });
      expect(resumed.run.sessionId).toBe(resumed.session.id);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    await connector.stop();
  });

  it('after resuming external Claude history, later discovery projects only the same managed session', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-resume-discovery-projection');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: {
        sessionInfo: async () => ({ sessionId: 'cli-session' })
      } as unknown as ClaudeAgentSdkAdapter
    });
    const internals = connector as unknown as {
      sessionPresentationService: SessionPresentationService;
      externalSessionResumeService: ExternalSessionResumeService;
      claudeClient: ClaudeCodeRunner;
      nativeSessionProjectionService: NativeSessionProjectionService;
      directNativeSession(input: unknown): { readonly id: string };
      rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
      presentDiscoveredSessions(sessions: readonly unknown[]): readonly {
        readonly id: string;
        readonly runnerTitle: string | null;
        readonly control: { readonly level: string };
      }[];
      executeNodeOperation(
        operation: string,
        data: unknown
      ): Promise<{
        readonly session: { readonly id: string; readonly lastActivityAt: number };
      }>;
    };
    const external = internals.nativeSessionProjectionService.project({
      workspace,
      runner: 'claude-code',
      externalSessionId: 'cli-session',
      cwd: workspace.path,
      title: 'Original history'
    });
    internals.nativeSessionProjectionService.remember([external]);

    vi.useFakeTimers();
    try {
      const resumed = await internals.executeNodeOperation('session.message', {
        sessionId: external.id,
        clientMessageId: 'resume-then-discover',
        content: 'Continue this session'
      });
      const managedBeforeDiscovery = await internals.executeNodeOperation('session.get', {
        sessionId: resumed.session.id
      });
      const resumedActivityAt = managedBeforeDiscovery.session.lastActivityAt;
      const discovered = internals.sessionPresentationService.presentDiscovered(
        internals.claudeClient
          .projectDiscoveredSessions(
            {
              workspaces: [workspace],
              createProjection: (input) =>
                internals.nativeSessionProjectionService.project(input) as never
            },
            workspace,
            [
              {
                externalSessionId: 'cli-session',
                cwd: workspace.path,
                title: 'Understand the current project'
              }
            ]
          )
          .map((session) => ({ ...session, lastActivityAt: 0 }))
      );

      expect(discovered).toEqual([
        expect.objectContaining({
          id: resumed.session.id,
          runnerTitle: 'Understand the current project',
          lastActivityAt: resumedActivityAt,
          control: expect.objectContaining({ level: 'MANAGED' })
        })
      ]);
      await expect(
        internals.executeNodeOperation('session.get', { sessionId: resumed.session.id })
      ).resolves.toMatchObject({
        session: {
          runnerTitle: 'Understand the current project',
          lastActivityAt: resumedActivityAt
        }
      });
      await expect(internals.executeNodeOperation('session.list', {})).resolves.toMatchObject({
        sessions: [
          expect.objectContaining({
            id: resumed.session.id,
            lastActivityAt: resumedActivityAt
          })
        ]
      });

      const unrelatedNative = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'claude-code',
        externalSessionId: 'different-native-session',
        cwd: workspace.path,
        title: 'Understand the current project'
      });
      const unrelated = internals.sessionPresentationService.presentDiscovered([unrelatedNative]);
      expect(unrelated).toEqual([
        expect.objectContaining({
          id: unrelatedNative.id,
          runnerTitle: 'Understand the current project',
          control: expect.objectContaining({ level: 'MANAGED' })
        })
      ]);
      await expect(
        internals.executeNodeOperation('session.get', { sessionId: resumed.session.id })
      ).resolves.toMatchObject({
        session: { runnerTitle: 'Understand the current project' }
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    await connector.stop();
  });

  it('after Claude resumes, projects a new native session ID reported by the SDK onto the same managed session', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-resume-native-alias');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const sessionInfo = vi.fn(async () => ({ sessionId: 'cli-session' }) as never);
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: new ClaudeAgentSdkAdapter({
        ...bindings(() => nativeSessionThenPendingStream('resumed-native-session')),
        getSessionInfo: sessionInfo
      })
    });
    const internals = connector as unknown as {
      sessionPresentationService: SessionPresentationService;
      externalSessionResumeService: ExternalSessionResumeService;
      claudeClient: ClaudeCodeRunner;
      nativeSessionProjectionService: NativeSessionProjectionService;
      directNativeSession(input: unknown): { readonly id: string };
      rememberDirectNativeSessions(sessions: readonly { readonly id: string }[]): void;
      presentDiscoveredSessions(sessions: readonly unknown[]): readonly { readonly id: string }[];
      resolveSessionForMessage(sessionId: string): Promise<{
        readonly id: string;
        readonly externalSessionId: string | null;
      }>;
      executeNodeOperation(
        operation: string,
        data: unknown
      ): Promise<{
        readonly session: { readonly id: string };
      }>;
    };
    const external = internals.nativeSessionProjectionService.project({
      workspace,
      runner: 'claude-code',
      externalSessionId: 'cli-session',
      cwd: workspace.path,
      title: 'Original history'
    });
    internals.nativeSessionProjectionService.remember([external]);

    try {
      const resumed = await internals.executeNodeOperation('session.message', {
        sessionId: external.id,
        clientMessageId: 'resume-native-alias',
        content: 'Continue this session'
      });

      await eventually(() => {
        const discovered = internals.sessionPresentationService.presentDiscovered(
          internals.claudeClient.projectDiscoveredSessions(
            {
              workspaces: [workspace],
              createProjection: (input) =>
                internals.nativeSessionProjectionService.project(input) as never
            },
            workspace,
            [
              {
                externalSessionId: 'resumed-native-session',
                cwd: workspace.path,
                title: 'Resumed history'
              }
            ]
          )
        );
        return discovered.length === 1 && discovered[0]?.id === resumed.session.id;
      });

      const resumedAlias = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'claude-code',
        externalSessionId: 'resumed-native-session',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([resumedAlias]);
      await expect(
        internals.externalSessionResumeService.resolveForMessage(resumedAlias.id)
      ).resolves.toMatchObject({
        externalSessionId: resumed.session.id
      });
      expect(sessionInfo).toHaveBeenCalledTimes(1);

      await expect(internals.executeNodeOperation('session.list', {})).resolves.toMatchObject({
        sessions: [expect.objectContaining({ id: resumed.session.id })]
      });
    } finally {
      await connector.stop();
    }
  });

  it('attempts Claude SDK history validation but creates no Run when validation fails', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-resume-rejected');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const sessionInfo = vi.fn(async () => undefined);
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: capabilities(),
      claudeClient: { sessionInfo } as unknown as ClaudeAgentSdkAdapter
    });
    const external = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: {
            workspaceId: string;
            runner: 'claude-code';
            externalSessionId: string;
            cwd: string;
          }): { id: string };
        };
      }
    ).runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      externalSessionId: 'missing-cli-session',
      cwd: workspace.path
    });
    const internals = connector as unknown as {
      runtime: { listRunsForSession(sessionId: string): readonly unknown[] };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };

    await expect(
      internals.executeNodeOperation('session.get', { sessionId: external.id })
    ).resolves.toMatchObject({
      session: { activity: 'IDLE', control: { level: 'MANAGED' } }
    });
    await expect(
      internals.executeNodeOperation('session.message', {
        sessionId: external.id,
        clientMessageId: 'reject-claude-history',
        content: 'Try to resume'
      })
    ).rejects.toThrow('SESSION_RESUME_REJECTED');
    expect(sessionInfo).toHaveBeenCalledWith('missing-cli-session', workspace.path);
    expect(internals.runtime.listRunsForSession(external.id)).toEqual([]);
    await connector.stop();
  });

  it('rejects direct native-run startup before the message path activates the session', () => {
    const connector = new NodeConnector({ reconnect: false, capabilities: capabilities() });
    const emitRun = vi.spyOn(
      (connector as unknown as { runEventBridge: { emitRun(...args: unknown[]): void } })
        .runEventBridge,
      'emitRun'
    );
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    connectTestSocket(connector, {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        recordSent(sent, JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
      }
    });
    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'run-external',
          sessionId: 'session-external',
          runner: 'claude-code',
          input: 'do not inject',
          cwd: '/workspace',
          externalSessionId: 'foreign-session'
        })
      )
    );
    expect(emitRun).toHaveBeenCalledWith(
      'run-external',
      'run.rejected',
      { code: 'SESSION_ACTIVATION_REQUIRED' },
      'FAILED'
    );
  });
});
