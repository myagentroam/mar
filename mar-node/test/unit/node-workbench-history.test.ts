import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { ConversationHistoryService } from '../../src/service/conversation-history-service.js';
import type { NodeConversationTurn } from '../../src/runtime-model.js';
import { rewindTitle } from '../../src/session/session-catalog-service.js';
import type { NativeSessionProjectionService } from '../../src/session/native-session-projection-service.js';
import type { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import { NodeDatabase, type NodeAgentSession } from '../../src/database.js';
import { withClaudePlanTag } from '../../src/runner-command-engine.js';
import { executeNodeOperation as operation } from './support/node-connector.js';

const rewindFixtures: { root: string; connector: NodeConnector }[] = [];
afterEach(async () => {
  for (const { root, connector } of rewindFixtures.splice(0)) {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});
describe('Node Workbench history projection and pagination', () => {
  it('routes history activity and synchronous projection cleanup through the lazily bound resume owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-history-resume-owner-'));
    const database = new NodeDatabase(':memory:', 'history-resume-owner');
    const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    rewindFixtures.push({ root, connector });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      runners: RunnerRegistry;
      nativeSessionProjectionService: NativeSessionProjectionService;
      conversationHistoryService: ConversationHistoryService;
      externalSessionResumeService: ExternalSessionResumeService;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      externalSessionId: 'history-activity-native',
      nativeControl: 'EXTERNAL'
    });
    internals.nativeSessionProjectionService.remember([session]);
    const activity = vi.spyOn(internals.runners.require('codex'), 'readExternalActivity');
    const setActivity = vi.spyOn(internals.externalSessionResumeService, 'setActivity');
    activity.mockResolvedValue(undefined);
    await internals.conversationHistoryService.refreshExternalActivity(session);
    expect(setActivity).not.toHaveBeenCalled();
    expect(internals.externalSessionResumeService.activity(session.id) !== undefined).toBe(false);

    activity.mockResolvedValue('BUSY');
    await internals.conversationHistoryService.refreshExternalActivity(session);
    expect(setActivity).toHaveBeenLastCalledWith(session.id, 'BUSY');
    expect(internals.externalSessionResumeService.activity(session.id)).toBe('BUSY');
    activity.mockResolvedValue(undefined);
    await internals.conversationHistoryService.refreshExternalActivity(session);
    expect(setActivity).toHaveBeenCalledTimes(1);
    expect(internals.externalSessionResumeService.activity(session.id)).toBe('BUSY');
    activity.mockResolvedValue('IDLE');
    await internals.conversationHistoryService.refreshExternalActivity(session);
    expect(setActivity).toHaveBeenLastCalledWith(session.id, 'IDLE');
    expect(internals.externalSessionResumeService.activity(session.id)).toBe('IDLE');
    expect(setActivity).toHaveBeenCalledTimes(2);

    const release = vi.spyOn(internals.externalSessionResumeService, 'forgetSessions');
    expect(
      internals.nativeSessionProjectionService.forget(session, new Set([session.id]))
    ).toBeUndefined();
    expect(release).toHaveBeenCalledExactlyOnceWith(new Set([session.id]), new Set([session.id]));
    expect(internals.externalSessionResumeService.activity(session.id) !== undefined).toBe(false);
    expect(
      internals.nativeSessionProjectionService.cachedNative().some((item) => item.id === session.id)
    ).toBe(false);
    expect(internals.runtime.getAgentSession(session.id)).toBeUndefined();
  });

  it('increments Copy suffixes for rewind branches and preserves the complete suffix at the length limit', () => {
    const title = rewindTitle('A'.repeat(160), [
      `${'A'.repeat(151)} (Copy 1)`,
      `${'A'.repeat(151)} (Copy 2)`
    ]);
    expect(title).toHaveLength(160);
    expect(title).toMatch(/ \(Copy 3\)$/);
    expect(rewindTitle('Original session (Copy 1)', ['Original session (Copy 1)'])).toBe(
      'Original session (Copy 2)'
    );
  });

  it.each(['mar-agent', 'codex', 'claude-code', 'opencode'] as const)(
    'creates a non-destructive %s Rewind branch using a reread boundary and rejects forged boundaries',
    async (runner) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-session-rewind-'));
      const database = new NodeDatabase(':memory:', 'node-session-rewind');
      const workspace = database.saveWorkspace({
        path: root,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1' }
        }
      });
      rewindFixtures.push({ root, connector });
      const internals = connector as unknown as {
        conversationHistoryService: ConversationHistoryService;
        codexClient: {
          forkNative(
            session: unknown,
            boundary: string | null,
            title: string
          ): Promise<string | null>;
        };
        claudeClient: {
          forkNative(
            session: unknown,
            boundary: string | null,
            title: string
          ): Promise<string | null>;
        };
        openCodeClient: {
          forkNative(
            session: unknown,
            boundary: string | null,
            title: string
          ): Promise<string | null>;
        };
        marAgentClient: {
          forkNative(
            session: unknown,
            boundary: string | null,
            title: string
          ): Promise<string | null>;
        };
        sessionCatalogService: {
          options: {
            present: (session: NodeAgentSession) => NodeAgentSession;
          };
        };
        runtime: {
          createAgentSession(input: Record<string, unknown>): { readonly id: string };
          createMessageRun(input: Record<string, unknown>): {
            readonly run: { readonly id: string };
          };
        };
      };
      const source = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner,
        cwd: workspace.path,
        externalSessionId: 'source-native',
        nativeControl: 'MAR_MANAGED',
        title: 'Original session (Copy 1)'
      });
      internals.sessionCatalogService.options.present = (session) =>
        ({
          ...session,
          runtime: { level: 'MANAGED', capabilities: [], reasonCode: null }
        }) as NodeAgentSession;
      vi.spyOn(internals.conversationHistoryService, 'read').mockResolvedValue({
        turns: [
          {
            id: 'turn-1',
            sessionId: source.id,
            runId: null,
            userItemId: null,
            status: 'SUCCEEDED',
            model: null,
            effort: null,
            access: null,
            rewind: { before: null, after: 'message-1' },
            items: [],
            startedAt: 1,
            completedAt: 1
          }
        ],
        nextCursor: null,
        snapshotSequence: 1,
        source: 'native',
        readAt: 1,
        latestVisibleAt: 1
      });
      const fork = vi
        .spyOn(
          internals[
            (
              {
                'mar-agent': 'marAgentClient',
                codex: 'codexClient',
                'claude-code': 'claudeClient',
                opencode: 'openCodeClient'
              } as const
            )[runner]
          ],
          'forkNative'
        )
        .mockResolvedValueOnce('forked-native')
        .mockResolvedValueOnce('forked-native-2')
        .mockResolvedValueOnce(null);
      await expect(
        operation(connector, 'session.rewind', {
          sessionId: source.id,
          turnId: '',
          position: 'AFTER',
          boundary: 'message-1'
        })
      ).rejects.toThrow('SESSION_REWIND_INVALID');
      await expect(
        operation(connector, 'session.rewind', {
          sessionId: source.id,
          turnId: 'turn-1',
          position: 'AFTER',
          boundary: 'forged'
        })
      ).rejects.toThrow('SESSION_REWIND_TARGET_INVALID');
      const result = (await operation(connector, 'session.rewind', {
        sessionId: source.id,
        turnId: 'turn-1',
        position: 'AFTER',
        boundary: 'message-1'
      })) as { readonly session: { readonly id: string; readonly runnerTitle: string } };
      expect(fork).toHaveBeenCalledWith(
        expect.objectContaining({ id: source.id }),
        'message-1',
        'Original session (Copy 2)'
      );
      expect(result.session).toMatchObject({
        id: 'forked-native',
        runnerTitle: 'Original session (Copy 2)'
      });
      await operation(connector, 'session.rewind', {
        sessionId: source.id,
        turnId: 'turn-1',
        position: 'AFTER',
        boundary: 'message-1'
      });
      expect(fork).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: source.id }),
        'message-1',
        'Original session (Copy 3)'
      );
      const empty = (await operation(connector, 'session.rewind', {
        sessionId: source.id,
        turnId: 'turn-1',
        position: 'BEFORE',
        boundary: null
      })) as { session: NodeAgentSession };
      expect(empty.session.externalSessionId).toBeNull();
      expect(empty.session.runner).toBe(runner);
      expect(fork).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: source.id }),
        null,
        'Original session (Copy 4)'
      );
      internals.runtime.createMessageRun({
        sessionId: source.id,
        clientMessageId: 'active-rewind-message',
        content: 'message from the active run'
      });
      fork.mockRejectedValueOnce(new Error('CLAUDE_FORK_BUSY'));
      await expect(
        operation(connector, 'session.rewind', {
          sessionId: source.id,
          turnId: 'turn-1',
          position: 'AFTER',
          boundary: 'message-1'
        })
      ).rejects.toThrow('CLAUDE_FORK_BUSY');
      expect(fork).toHaveBeenCalledTimes(4);
    }
  );

  it('keeps completed Codex Rewind boundaries visible during a later managed Run', async () => {
    const database = new NodeDatabase(':memory:', 'node-codex-active-rewind');
    const workspace = database.saveWorkspace({
      path: '/workspace/codex-active-rewind',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): NodeAgentSession;
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        finishRun(runId: string, status: 'SUCCEEDED'): void;
        listConversationTurns(input: { sessionId: string }): { turns: NodeConversationTurn[] };
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'codex-active-rewind',
        nativeControl: 'MAR_MANAGED'
      });
      const completed = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'completed-message',
        content: 'First request'
      }).run;
      internals.runtime.finishRun(completed.id, 'SUCCEEDED');
      internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'active-message',
        content: 'Second request'
      });
      const nativeRead = vi.spyOn(internals.conversationHistoryService, 'readNative');
      vi.spyOn(internals.conversationHistoryService, 'readOfficial').mockResolvedValue({
        turns: [
          {
            ...internals.runtime.listConversationTurns({ sessionId: session.id }).turns[0]!,
            rewind: { before: null, after: 'native-turn-1' }
          }
        ],
        nextCursor: null
      });

      const page = await internals.conversationHistoryService.read(session, {});
      expect(page.source).toBe('runtime');
      expect(page.turns.find((turn) => turn.status === 'SUCCEEDED')?.rewind).toEqual({
        before: null,
        after: 'native-turn-1'
      });
      expect(nativeRead).not.toHaveBeenCalled();
    } finally {
      connector.stop();
    }
  });

  it.each(['mar-agent', 'codex'] as const)(
    'performs supported %s Rollback at a terminal user-message boundary and blocks concurrent messages',
    async (runner) => {
      const database = new NodeDatabase(':memory:', 'node-session-rollback');
      const workspace = database.saveWorkspace({
        path: '/workspace/rollback',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1' },
          marAgent: { available: true, version: '0.9.49' }
        }
      });
      const internals = connector as unknown as {
        conversationHistoryService: ConversationHistoryService;
        marAgentClient: {
          rollbackNative(
            session: NodeAgentSession,
            boundary: string | null,
            target?: string
          ): Promise<number>;
        };
        codexClient: {
          supportsRollback(session: NodeAgentSession): boolean;
          rollbackNative(
            session: NodeAgentSession,
            boundary: string | null,
            target?: string
          ): Promise<number>;
        };
        nativeSessionWatchService: { invalidate(sessionId: string): void };
        workspaceSessionService: { invalidateCache(workspaceId: string): void };
        promptCompletion: { invalidateSession(workspaceId: string, sessionId: string): void };
        runtime: {
          createAgentSession(input: Record<string, unknown>): NodeAgentSession;
          createMessageRun(input: Record<string, unknown>): {
            readonly run: { readonly id: string };
          };
          createQueueItem(input: Record<string, unknown>): unknown;
          finishRun(runId: string, status: 'SUCCEEDED'): unknown;
          listConversationTurns(input: { sessionId: string }): {
            readonly turns: readonly unknown[];
          };
        };
      };
      const createSession = (runner: 'mar-agent' | 'claude-code' | 'codex') =>
        internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner,
          cwd: workspace.path,
          externalSessionId: `${runner}-${crypto.randomUUID()}`,
          nativeControl: 'MAR_MANAGED'
        });
      if (runner === 'codex')
        vi.spyOn(internals.codexClient, 'supportsRollback').mockReturnValue(true);
      const source = createSession(runner);
      const activeSource = createSession(runner);
      const queuedSource = createSession(runner);
      const otherRunner = createSession('claude-code');
      const terminalRun = internals.runtime.createMessageRun({
        sessionId: source.id,
        clientMessageId: 'terminal-message',
        content: 'message to restore'
      }).run;
      internals.runtime.finishRun(terminalRun.id, 'SUCCEEDED');
      internals.runtime.createMessageRun({
        sessionId: activeSource.id,
        clientMessageId: 'active-message',
        content: 'active'
      });
      internals.runtime.createQueueItem({
        sessionId: queuedSource.id,
        clientMessageId: 'queued-message',
        content: 'queued'
      });
      vi.spyOn(internals.conversationHistoryService, 'read').mockImplementation(
        async (session) => ({
          turns: [
            {
              id: `turn-${session.id}`,
              sessionId: session.id,
              runId: null,
              userItemId: `user-${session.id}`,
              status: 'SUCCEEDED',
              model: null,
              effort: null,
              access: null,
              rewind: { before: `before-${session.id}`, after: `after-${session.id}` },
              items: [
                {
                  id: `user-${session.id}`,
                  sessionId: session.id,
                  turnId: `turn-${session.id}`,
                  runId: null,
                  parentItemId: null,
                  sourceSequence: null,
                  revision: 0,
                  kind: 'user_message',
                  status: 'COMPLETED',
                  payload: { text: 'message to restore' },
                  startedAt: 1,
                  completedAt: 1
                }
              ],
              startedAt: 1,
              completedAt: 1
            }
          ],
          nextCursor: null,
          snapshotSequence: 1,
          source: 'official',
          readAt: 1,
          latestVisibleAt: 1
        })
      );
      let completeRollback!: (value: number) => void;
      const rollback = vi
        .spyOn(
          runner === 'codex' ? internals.codexClient : internals.marAgentClient,
          'rollbackNative'
        )
        .mockImplementation(
          () =>
            new Promise<number>((resolve) => {
              completeRollback = resolve;
            })
        );
      const invalidateHistory = vi.spyOn(internals.nativeSessionWatchService, 'invalidate');
      const invalidateWorkspace = vi.spyOn(internals.workspaceSessionService, 'invalidateCache');
      const invalidatePrediction = vi.spyOn(internals.promptCompletion, 'invalidateSession');

      try {
        await expect(
          operation(connector, 'session.rollback', {
            sessionId: otherRunner.id,
            turnId: `turn-${otherRunner.id}`,
            boundary: `before-${otherRunner.id}`
          })
        ).rejects.toThrow('SESSION_ROLLBACK_UNAVAILABLE');
        await expect(
          operation(connector, 'session.rollback', {
            sessionId: source.id,
            turnId: `turn-${source.id}`,
            boundary: 'forged'
          })
        ).rejects.toThrow('SESSION_ROLLBACK_TARGET_INVALID');
        await expect(
          operation(connector, 'session.rollback', {
            sessionId: activeSource.id,
            turnId: `turn-${activeSource.id}`,
            boundary: `before-${activeSource.id}`
          })
        ).rejects.toThrow('SESSION_ACTIVE');
        await expect(
          operation(connector, 'session.rollback', {
            sessionId: queuedSource.id,
            turnId: `turn-${queuedSource.id}`,
            boundary: `before-${queuedSource.id}`
          })
        ).rejects.toThrow('SESSION_QUEUE_NOT_EMPTY');

        const pending = operation(connector, 'session.rollback', {
          sessionId: source.id,
          turnId: `turn-${source.id}`,
          boundary: `before-${source.id}`
        });
        await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
        expect(() =>
          internals.runtime.createMessageRun({
            sessionId: source.id,
            clientMessageId: 'racing-message',
            content: 'must be rejected'
          })
        ).toThrow('SESSION_ACTIVE');
        completeRollback(1_789_000_000_000);

        await expect(pending).resolves.toMatchObject({
          session: { id: source.id, lastActivityAt: 1_789_000_000_000 }
        });
        expect(rollback).toHaveBeenCalledWith(
          expect.objectContaining({ id: source.id, runner }),
          `before-${source.id}`,
          `after-${source.id}`,
          undefined
        );
        expect(internals.runtime.listConversationTurns({ sessionId: source.id }).turns).toEqual([]);
        expect(invalidateHistory).toHaveBeenCalledWith(source.id);
        expect(invalidateWorkspace).toHaveBeenCalledWith(workspace.id);
        expect(invalidatePrediction).toHaveBeenCalledExactlyOnceWith(workspace.id, source.id);
        expect(() =>
          internals.runtime.createMessageRun({
            sessionId: source.id,
            clientMessageId: 'after-rollback',
            content: 'allowed again'
          })
        ).not.toThrow();
      } finally {
        await connector.stop();
      }
    }
  );

  it('strips Claude Plan tags from native history and reuses the runtime user message clientMessageId', async () => {
    const database = new NodeDatabase(':memory:', 'node-claude-native-client-message');
    const workspace = database.saveWorkspace({
      path: '/workspace/claude-native-client-message',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: true, version: 'claude 2.1.0' }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
      };
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'claude-code',
      cwd: workspace.path,
      externalSessionId: 'claude-native-client-message',
      nativeControl: 'MAR_MANAGED'
    });
    internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'browser-message',
      content: 'inspect the current project'
    });
    internals.conversationHistoryService.readNative = async () => ({
      runner: 'claude-code',
      externalSessionId: 'claude-native-client-message',
      cwd: workspace.path,
      digest: 'native-history',
      lastActivityAt: Date.now(),
      items: [
        {
          kind: 'message',
          role: 'USER',
          text: withClaudePlanTag('inspect the current project'),
          createdAt: null
        }
      ]
    });

    const page = (await operation(connector, 'session.turns.list', { sessionId: session.id })) as {
      turns: {
        id: string;
        runId: string | null;
        startedAt: number | null;
        items: {
          turnId: string;
          runId: string | null;
          kind: string;
          payload: { clientMessageId?: string | null; text?: string };
        }[];
      }[];
    };
    expect(page.turns[0]?.runId).toBeTruthy();
    expect(page.turns[0]?.items[0]).toMatchObject({
      turnId: page.turns[0]?.id,
      runId: page.turns[0]?.runId
    });
    expect(page.turns[0]?.items[0]?.payload.clientMessageId).toBe('browser-message');
    expect(page.turns[0]?.items[0]?.payload.text).toBe('inspect the current project');
    expect(page.turns[0]?.startedAt).toEqual(expect.any(Number));
    connector.stop();
  });

  it('prevents later JSONL or legacy official titles from overwriting a renamed Codex session', () => {
    const database = new NodeDatabase(':memory:', 'node-codex-title-cache');
    const workspace = database.saveWorkspace({
      path: '/workspace/codex-title-cache',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'thread-renamed',
      workspaceId: workspace.id,
      runnerTitle: 'renamed title',
      runnerTitlePending: true,
      modelId: 'gpt-5.6-terra',
      effort: 'high',
      access: 'workspace-write'
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      nativeSessionProjectionService: NativeSessionProjectionService;
    };
    expect(
      internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'thread-renamed',
        cwd: workspace.path,
        title: 'original title',
        titleOrigin: 'NATIVE'
      }).runnerTitle
    ).toBe('renamed title');
    expect(
      internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'thread-renamed',
        cwd: workspace.path
      })
    ).toMatchObject({
      modelId: 'gpt-5.6-terra',
      effort: 'high',
      access: 'workspace-write'
    });
    expect(
      internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'codex',
        externalSessionId: 'thread-renamed',
        cwd: workspace.path,
        title: 'original title',
        titleOrigin: 'OFFICIAL'
      }).runnerTitle
    ).toBe('renamed title');
    expect(
      database.getNativeSessionMetadata('codex', 'thread-renamed', workspace.id)
    ).toMatchObject({
      runnerTitle: 'renamed title',
      runnerTitlePending: true
    });
    internals.nativeSessionProjectionService.project({
      workspace,
      runner: 'codex',
      externalSessionId: 'thread-renamed',
      cwd: workspace.path,
      title: 'renamed title',
      titleOrigin: 'OFFICIAL'
    });
    expect(
      database.getNativeSessionMetadata('codex', 'thread-renamed', workspace.id)
    ).toMatchObject({
      runnerTitle: 'renamed title',
      runnerTitlePending: false
    });
    connector.stop();
  });

  it('keeps the discovered Runner title when opening session details instead of falling back to the first-message temporary title', async () => {
    const database = new NodeDatabase(':memory:', 'node-managed-runner-title-sync');
    const workspace = database.saveWorkspace({
      path: '/workspace/managed-runner-title-sync',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: unknown): NodeAgentSession;
      };
      nativeSessionProjectionService: { directNative: Map<string, NodeAgentSession> };
    };
    const managed = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      externalSessionId: 'thread-managed-runner-title-sync',
      nativeControl: 'MAR_MANAGED',
      cwd: workspace.path,
      title: 'first user message'
    });
    internals.nativeSessionProjectionService.directNative.set(managed.id, {
      ...managed,
      runnerTitle: 'Runner correct title',
      titleSource: 'RUNNER',
      externalDiscovered: true
    });

    try {
      const listed = (await operation(connector, 'session.list', {})) as {
        readonly sessions: readonly NodeAgentSession[];
      };
      expect(listed.sessions).toEqual([
        expect.objectContaining({ id: managed.id, runnerTitle: 'Runner correct title' })
      ]);

      await expect(operation(connector, 'session.get', { sessionId: managed.id })).resolves.toEqual(
        expect.objectContaining({
          session: expect.objectContaining({
            id: managed.id,
            runnerTitle: 'Runner correct title',
            titleSource: 'RUNNER'
          })
        })
      );

      internals.nativeSessionProjectionService.directNative.set(managed.id, {
        ...managed,
        runnerTitle: 'latest user message preview',
        titleSource: 'AUTO',
        externalDiscovered: true
      });
      const listedAfterPreview = (await operation(connector, 'session.list', {})) as {
        readonly sessions: readonly NodeAgentSession[];
      };
      expect(listedAfterPreview.sessions).toEqual([
        expect.objectContaining({
          id: managed.id,
          runnerTitle: 'Runner correct title',
          titleSource: 'RUNNER'
        })
      ]);
      await expect(operation(connector, 'session.get', { sessionId: managed.id })).resolves.toEqual(
        expect.objectContaining({
          session: expect.objectContaining({
            id: managed.id,
            runnerTitle: 'Runner correct title',
            titleSource: 'RUNNER'
          })
        })
      );
    } finally {
      connector.stop();
    }
  });

  it('preserves pending user-input cards from Node and deduplicates them by requestId when refreshing Codex history', async () => {
    const database = new NodeDatabase(':memory:', 'node-pending-user-input');
    const workspace = database.saveWorkspace({
      path: '/workspace/pending-input',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
      };
      emitConversationItem(runId: string, item: Record<string, unknown>): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-pending'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'pending-input-message',
      content: 'select a scope'
    }).run;
    internals.conversationHistoryService.readOfficial = async () => ({
      turns: [
        {
          id: 'official-pending-turn',
          sessionId: session.id,
          runId: null,
          userItemId: null,
          status: 'RUNNING',
          model: null,
          effort: null,
          access: null,
          startedAt: 1,
          completedAt: null,
          items: [
            {
              id: 'official-pending-input',
              sessionId: session.id,
              turnId: 'official-pending-turn',
              runId: null,
              parentItemId: null,
              sourceSequence: null,
              revision: 0,
              kind: 'user_input_request',
              status: 'PENDING',
              payload: { requestId: 'request-pending', questions: [] },
              startedAt: 1,
              completedAt: null
            }
          ]
        }
      ],
      nextCursor: null
    });
    internals.emitConversationItem(run.id, {
      itemId: 'pending-input',
      kind: 'user_input_request',
      status: 'PENDING',
      payload: {
        requestId: 'request-pending',
        questions: [
          {
            id: 'scope',
            prompt: 'Optimization scope?',
            input: 'SINGLE_SELECT',
            options: [],
            allowOther: false
          }
        ]
      }
    });

    const page = (await operation(connector, 'session.turns.list', { sessionId: session.id })) as {
      snapshotSequence: number;
      turns: {
        runId: string | null;
        items: { kind: string; status: string; payload: { requestId?: string } }[];
      }[];
    };
    expect(page.snapshotSequence).toBeGreaterThanOrEqual(0);
    expect(page.turns).toContainEqual(
      expect.objectContaining({
        runId: run.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: 'user_input_request',
            status: 'PENDING',
            payload: expect.objectContaining({ requestId: 'request-pending' })
          })
        ])
      })
    );
    expect(
      page.turns.flatMap((turn) =>
        turn.items.filter((item) => item.payload.requestId === 'request-pending')
      )
    ).toHaveLength(1);
    connector.stop();
  });

  it('matches official Turns by submission rather than collapsing two Turns of a continuous Run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-continuous-history-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-continuous-run-turns');
    const workspace = database.saveWorkspace({
      path: '/workspace/continuous-run-turns',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        createQueueItem(input: Record<string, unknown>): unknown;
        claimNextQueueItem(sessionId: string): unknown;
        finishRun(runId: string, status: 'SUCCEEDED'): void;
        listConversationTurns(input: { sessionId: string }): { turns: NodeConversationTurn[] };
      };
      emitConversationItem(runId: string, item: Record<string, unknown>): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: workspace.path,
      externalSessionId: 'thread-continuous-run'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'first-submission',
      content: 'First request'
    }).run;
    internals.emitConversationItem(run.id, {
      itemId: 'first-answer',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'First answer' }
    });
    internals.runtime.createQueueItem({
      sessionId: session.id,
      clientMessageId: 'second-submission',
      content: 'Second request'
    });
    internals.runtime.claimNextQueueItem(session.id);
    internals.emitConversationItem(run.id, {
      itemId: 'second-answer',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'Second answer' }
    });
    internals.runtime.finishRun(run.id, 'SUCCEEDED');
    const runtimeTurns = internals.runtime.listConversationTurns({ sessionId: session.id }).turns;
    internals.conversationHistoryService.readOfficial = async () => ({
      turns: runtimeTurns.map((turn, index) => ({
        ...turn,
        id: `official-turn-${index}`,
        status: 'INTERRUPTED',
        completedAt: null,
        items: turn.items.map((item, itemIndex) => ({
          ...item,
          id: `official-item-${index}-${itemIndex}`,
          turnId: `official-turn-${index}`
        }))
      })),
      nextCursor: null
    });
    try {
      const page = await internals.conversationHistoryService.readHistoryPage(
        { ...session, runner: 'mar-agent' } as never,
        {}
      );
      expect(page.source).toBe('official');
      expect(page.turns.map((turn) => turn.items.map((item) => item.payload))).toEqual([
        expect.arrayContaining([expect.objectContaining({ text: 'First answer' })]),
        expect.arrayContaining([expect.objectContaining({ text: 'Second answer' })])
      ]);
      expect(page.turns.map((turn) => turn.id)).toEqual(['official-turn-0', 'official-turn-1']);
    } finally {
      connector.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses the native boundary for a stopped managed SDK Turn and rolls back that message', async () => {
    const database = new NodeDatabase(':memory:', 'node-sdk-stopped-rollback');
    const workspace = database.saveWorkspace({
      path: '/workspace/sdk-stopped-rollback',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      marAgentClient: {
        rollbackNative(session: NodeAgentSession, boundary: string | null): Promise<number>;
      };
      runtime: {
        createAgentSession(input: Record<string, unknown>): NodeAgentSession;
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        finishRun(runId: string, status: 'INTERRUPTED'): void;
        listConversationTurns(input: { sessionId: string }): { turns: NodeConversationTurn[] };
      };
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'sdk-stopped-rollback',
        nativeControl: 'MAR_MANAGED'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'stopped-submission',
        content: 'Stop this request'
      }).run;
      internals.runtime.finishRun(run.id, 'INTERRUPTED');
      const local = internals.runtime.listConversationTurns({ sessionId: session.id }).turns[0]!;
      const nativeCurrent: NodeConversationTurn = {
        ...local,
        id: 'native-current',
        runId: null,
        userItemId: 'native-current:user',
        rewind: { before: 'native-previous', after: 'native-current' },
        items: local.items.map((item) => ({
          ...item,
          id: 'native-current:user',
          turnId: 'native-current',
          runId: null
        }))
      };
      const nativePrevious: NodeConversationTurn = {
        ...nativeCurrent,
        id: 'native-previous',
        status: 'SUCCEEDED',
        userItemId: 'native-previous:user',
        rewind: { before: null, after: 'native-previous' },
        startedAt: 1,
        completedAt: 2,
        items: nativeCurrent.items.map((item) => ({
          ...item,
          id: 'native-previous:user',
          turnId: 'native-previous',
          payload: { text: 'Earlier request', clientMessageId: 'earlier-submission' },
          startedAt: 1,
          completedAt: 2
        }))
      };
      const readOfficial = vi
        .spyOn(internals.conversationHistoryService, 'readOfficial')
        .mockResolvedValue({ turns: [nativePrevious, nativeCurrent], nextCursor: null });
      vi.spyOn(internals.conversationHistoryService, 'readNative').mockResolvedValue(undefined);
      const rollback = vi
        .spyOn(internals.marAgentClient, 'rollbackNative')
        .mockResolvedValue(Date.now());

      readOfficial.mockResolvedValueOnce({
        turns: [
          nativePrevious,
          {
            ...nativeCurrent,
            id: local.id,
            items: nativeCurrent.items.map((item) => ({
              ...item,
              turnId: local.id,
              payload: { text: 'Different request', clientMessageId: 'different-submission' }
            }))
          }
        ],
        nextCursor: null
      });
      const unmatched = await internals.conversationHistoryService.read(session, {});
      expect(unmatched.turns.find((turn) => turn.id === local.id)?.rewind).toBeUndefined();

      const page = await internals.conversationHistoryService.read(session, {});
      expect(page.source).toBe('official');
      expect(page.turns).toHaveLength(2);
      expect(page.turns.find((turn) => turn.id === local.id)).toMatchObject({
        id: local.id,
        runId: run.id,
        status: 'INTERRUPTED',
        rewind: { before: 'native-previous', after: 'native-current' }
      });
      const watchedPage = await internals.conversationHistoryService.readHistoryPage(session, {});
      expect(watchedPage.turns.find((turn) => turn.id === local.id)?.rewind).toEqual({
        before: 'native-previous',
        after: 'native-current'
      });
      expect(readOfficial).toHaveBeenCalled();
      await expect(
        operation(connector, 'session.rollback', {
          sessionId: session.id,
          turnId: local.id,
          boundary: 'native-previous'
        })
      ).resolves.toMatchObject({ session: { id: session.id } });
      expect(rollback).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.id }),
        'native-previous',
        'native-current',
        undefined
      );
    } finally {
      await connector.stop();
    }
  });

  it('reads a completed managed SDK Turn from its Runtime stream when official history is unavailable', async () => {
    const database = new NodeDatabase(':memory:', 'node-sdk-stream-terminal');
    const workspace = database.saveWorkspace({
      path: '/workspace/sdk-stream-terminal',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        finishRun(runId: string, status: 'SUCCEEDED'): void;
      };
      emitConversationItem(runId: string, item: Record<string, unknown>): void;
    };
    try {
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'mar-agent',
        cwd: workspace.path,
        externalSessionId: 'sdk-stream-terminal',
        nativeControl: 'MAR_MANAGED'
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'sdk-submission',
        content: 'Request'
      }).run;
      internals.emitConversationItem(run.id, {
        itemId: 'mar-agent-message:reply',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'Final response' }
      });
      internals.runtime.finishRun(run.id, 'SUCCEEDED');
      const readOfficial = vi
        .spyOn(internals.conversationHistoryService, 'readOfficial')
        .mockResolvedValue(undefined);
      const page = await internals.conversationHistoryService.readHistoryPage(
        session as NodeAgentSession,
        {}
      );
      expect(page.source).toBe('runtime');
      expect(page.turns).toHaveLength(1);
      expect(page.turns[0]?.items.map((item) => item.kind)).toEqual([
        'user_message',
        'assistant_message'
      ]);
      expect(page.turns[0]?.rewind).toBeUndefined();
      expect(readOfficial).toHaveBeenCalled();
      readOfficial.mockRejectedValueOnce(new Error('SDK history temporarily unavailable'));
      const retryPage = await internals.conversationHistoryService.readHistoryPage(
        session as NodeAgentSession,
        {}
      );
      expect(retryPage.turns[0]?.rewind).toBeUndefined();
    } finally {
      await connector.stop();
    }
  });

  it('loads older SDK history without replaying a partially persisted current Turn on reconnect', async () => {
    const session = {
      id: 'managed-reconnect',
      runner: 'mar-agent',
      nativeControl: 'MAR_MANAGED',
      externalSessionId: 'managed-reconnect'
    } as NodeAgentSession;
    const turn = (id: string, at: number, clientMessageId: string) =>
      ({
        id,
        sessionId: session.id,
        runId: id === 'runtime-current' ? 'run-current' : null,
        status: id === 'runtime-current' ? 'RUNNING' : 'SUCCEEDED',
        userItemId: `${id}:user`,
        model: null,
        effort: null,
        access: null,
        startedAt: at,
        completedAt: id === 'runtime-current' ? null : at,
        items: [
          {
            id: `${id}:user`,
            kind: 'user_message',
            startedAt: at,
            completedAt: at,
            payload: { clientMessageId }
          }
        ]
      }) as unknown as NodeConversationTurn;
    const runtime = turn('runtime-current', 10, 'current');
    const old = turn('official-old', 2, 'old');
    const laggingCurrent = turn('official-current', 10, 'current');
    const readOfficial = vi.fn(async () => ({ turns: [old, laggingCurrent], nextCursor: null }));
    const service = new ConversationHistoryService({
      runtime: {
        getAgentSession: () => session,
        listConversationTurns: () => ({ turns: [runtime], nextCursor: null })
      },
      runners: {
        require: () => ({
          readConversationHistory: async (readers: {
            official(): Promise<{ turns: NodeConversationTurn[]; nextCursor: null }>;
          }) => ({ ...(await readers.official()), source: 'official' })
        })
      },
      capabilities: () => ({}) as never,
      attachments: {},
      snapshotSequence: () => 1,
      hasManagedActiveRun: () => true,
      setExternalActivity: () => undefined
    } as never);
    service.readOfficial = readOfficial as never;
    service.readNative = async () => undefined;

    const initial = await service.read(session, { limit: 30 });
    const older = await service.readHistoryPage(session, { limit: 30 });
    expect(initial.turns.map((value) => value.id)).toEqual(['runtime-current']);
    expect(older.turns.map((value) => value.id)).toEqual(['official-old']);
    expect(readOfficial).toHaveBeenCalledOnce();
  });

  it('preserves realtime Agent output for the same managed Turn when official history is temporarily unavailable', async () => {
    const database = new NodeDatabase(':memory:', 'node-official-agent-message');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-agent-message',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown): void;
    };
    vi.spyOn(internals.conversationHistoryService, 'readOfficial').mockRejectedValue(
      new Error('RPC_UNAVAILABLE')
    );
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-agent-message'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'agent-message',
      content: 'Please respond'
    }).run;
    internals.emitRunEvent(run.id, 'text.delta', { text: 'the same Agent response' });
    internals.emitRunEvent(run.id, 'run.completed', { status: 'SUCCEEDED' });

    const page = (await operation(connector, 'session.turns.list', { sessionId: session.id })) as {
      turns: { items: { kind: string; payload: { text?: string } }[] }[];
    };
    expect(
      page.turns.flatMap((turn) =>
        turn.items.filter(
          (item) =>
            item.kind === 'assistant_message' && item.payload.text === 'the same Agent response'
        )
      )
    ).toHaveLength(1);
    connector.stop();
  });

  it('presents local Codex command output and Agent text in conversation order', async () => {
    const database = new NodeDatabase(':memory:', 'node-official-item-order');
    const workspace = database.saveWorkspace({
      path: '/workspace/official-item-order',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      nativeSessionProjectionService: NativeSessionProjectionService;
      conversationHistoryService: ConversationHistoryService;
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
        createMessageRun(input: Record<string, unknown>): { run: { id: string } };
        createExecution(runId: string): { id: string };
      };
      emitConversationItem(runId: string, item: Record<string, unknown>): void;
    };
    vi.spyOn(internals.conversationHistoryService, 'readOfficial').mockRejectedValue(
      new Error('RPC_UNAVAILABLE')
    );
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'thread-item-order'
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'hybrid-item-order',
      content: 'check the status'
    }).run;
    internals.runtime.createExecution(run.id);
    internals.emitConversationItem(run.id, {
      itemId: 'local-command',
      kind: 'command_execution',
      status: 'COMPLETED',
      payload: {
        command: 'git status --short',
        cwd: workspace.path,
        outputPreview: 'command output',
        exitCode: 0,
        durationMs: 1,
        truncated: false
      }
    });
    internals.emitConversationItem(run.id, {
      itemId: 'local-agent',
      kind: 'assistant_message',
      status: 'COMPLETED',
      payload: { text: 'checking status', format: 'markdown' }
    });

    const page = (await operation(connector, 'session.turns.list', { sessionId: session.id })) as {
      turns: { items: { kind: string; payload: { text?: string; inputSummary?: string } }[] }[];
    };
    expect(page.turns[0]?.items).toMatchObject([
      { kind: 'user_message', payload: { text: 'check the status' } },
      { kind: 'command_execution', payload: { command: 'git status --short' } },
      { kind: 'assistant_message', payload: { text: 'checking status' } }
    ]);
    connector.stop();
  });

  it('deletes only discovered native sessions and rejects active managed sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-session-remove-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-session-remove');
    const workspace = database.saveWorkspace({
      path: '/workspace/remove',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const adjacentWorkspace = database.saveWorkspace({
      path: '/workspace/remove-adjacent',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const transcriptDirectory = join(home, '.claude', 'projects', 'workspace-remove');
    const writeTranscript = (id: string, text: string, cwd = workspace.path) =>
      writeFile(
        join(transcriptDirectory, `${id}.jsonl`),
        JSON.stringify({
          type: 'user',
          sessionId: id,
          cwd,
          message: { role: 'user', content: text }
        })
      );
    let connector: NodeConnector | undefined;
    try {
      await mkdir(transcriptDirectory, { recursive: true });
      await writeTranscript('claude-remove', 'delete this one');
      await writeTranscript('claude-active', 'keep the active session');
      await writeTranscript('claude-adjacent', 'keep the adjacent session', adjacentWorkspace.path);
      connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true, version: 'codex-cli 0.147.0' },
          claudeCode: { available: true, version: '2.1' }
        }
      });
      const internals = connector as unknown as {
        conversationHistoryService: ConversationHistoryService;
        promptCompletion: { invalidateSession(workspaceId: string, sessionId: string): void };
        discoverWorkspaceSessions(workspaceId: string): Promise<readonly NodeAgentSession[]>;
        send(type: string, payload: unknown): void;
        workspaceSessionService: { invalidateCache(workspaceId: string): void };
        runtime: {
          createAgentSession(input: {
            workspaceId: string;
            runner: 'claude-code';
            externalSessionId: string;
            nativeControl: 'MAR_MANAGED';
            cwd: string;
          }): { readonly id: string };
          createMessageRun(input: {
            sessionId: string;
            clientMessageId: string;
            content: string;
          }): unknown;
        };
      };
      const discoverWorkspaceSessions = vi.spyOn(internals, 'discoverWorkspaceSessions');
      const warmed = (await operation(connector, 'session.list', {
        workspaceId: workspace.id
      })) as { readonly sessions: readonly NodeAgentSession[] };
      expect(warmed.sessions.map((session) => session.id)).toContain('claude-remove');
      const removable = warmed.sessions.find((session) => session.id === 'claude-remove')!;
      const adjacentWarmed = (await operation(connector, 'session.list', {
        workspaceId: adjacentWorkspace.id
      })) as { readonly sessions: readonly NodeAgentSession[] };
      expect(adjacentWarmed.sessions.map((session) => session.id)).toContain('claude-adjacent');
      expect(removable.id).toBe('claude-remove');
      const renamed = (await operation(connector, 'session.metadata.update', {
        sessionId: removable.id,
        customTitle: 'Claude renamed'
      })) as { readonly session: { readonly id: string; readonly customTitle: string | null } };
      expect(renamed.session).toMatchObject({ customTitle: 'Claude renamed' });
      await operation(connector, 'session.metadata.update', {
        sessionId: removable.id,
        pinned: true
      });
      const detailed = (await operation(connector, 'session.get', {
        sessionId: removable.id
      })) as { readonly session: { readonly pinOrder: number | null } };
      expect(detailed.session.pinOrder).toBe(0);
      for (const customTitle of [null, '', '   ']) {
        await expect(
          operation(connector, 'session.metadata.update', {
            sessionId: removable.id,
            customTitle
          })
        ).rejects.toThrow('SESSION_TITLE_REQUIRED');
      }
      const listed = (await operation(connector, 'session.list', {})) as {
        readonly sessions: readonly { readonly id: string; readonly customTitle: string | null }[];
      };
      expect(
        listed.sessions.filter((session) => session.customTitle === 'Claude renamed')
      ).toHaveLength(1);
      const send = vi.spyOn(internals, 'send');
      await operation(connector, 'workspace.watch', {
        workspaceId: workspace.id,
        watchId: 'session-remove-observer',
        workbenchConnectionId: 'history-delete-workbench',
        mode: 'initial',
        topics: { sessions: true }
      });
      await operation(connector, 'workspace.watch', {
        workspaceId: adjacentWorkspace.id,
        watchId: 'session-remove-adjacent-observer',
        workbenchConnectionId: 'history-adjacent-workbench',
        mode: 'initial',
        topics: { sessions: true }
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            watchId: 'session-remove-observer',
            workspaceId: workspace.id,
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: expect.arrayContaining([expect.objectContaining({ id: 'claude-remove' })])
            })
          })
        );
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            watchId: 'session-remove-adjacent-observer',
            workspaceId: adjacentWorkspace.id,
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: expect.arrayContaining([expect.objectContaining({ id: 'claude-adjacent' })])
            })
          })
        );
      });
      send.mockClear();
      const invalidateWorkspaceSessions = vi.spyOn(
        internals.workspaceSessionService,
        'invalidateCache'
      );
      const invalidatePrediction = vi.spyOn(internals.promptCompletion, 'invalidateSession');
      await expect(
        operation(connector, 'session.remove', { sessionId: renamed.session.id })
      ).resolves.toEqual({
        deleted: true
      });
      expect(invalidatePrediction).toHaveBeenCalledExactlyOnceWith(
        workspace.id,
        renamed.session.id
      );
      expect(invalidateWorkspaceSessions).toHaveBeenCalledExactlyOnceWith(workspace.id);
      expect(invalidateWorkspaceSessions).not.toHaveBeenCalledWith(adjacentWorkspace.id);
      const immediatelyRelisted = (await operation(connector, 'session.list', {
        workspaceId: workspace.id
      })) as { readonly sessions: readonly NodeAgentSession[] };
      expect(immediatelyRelisted.sessions.map((session) => session.id)).not.toContain(
        renamed.session.id
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'watch.event',
          expect.objectContaining({
            type: 'watch.workspace.snapshot',
            watchId: 'session-remove-observer',
            workspaceId: workspace.id,
            topic: 'sessions',
            payload: expect.objectContaining({
              sessions: expect.not.arrayContaining([
                expect.objectContaining({ id: renamed.session.id })
              ])
            })
          })
        )
      );
      expect(send).not.toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'watch.workspace.snapshot',
          watchId: 'session-remove-adjacent-observer',
          workspaceId: adjacentWorkspace.id,
          topic: 'sessions'
        })
      );
      const adjacentRelisted = (await operation(connector, 'session.list', {
        workspaceId: adjacentWorkspace.id
      })) as { readonly sessions: readonly NodeAgentSession[] };
      expect(adjacentRelisted.sessions.map((session) => session.id)).toContain('claude-adjacent');
      expect(
        discoverWorkspaceSessions.mock.calls.filter(
          ([workspaceId]) => workspaceId === adjacentWorkspace.id
        )
      ).toHaveLength(1);
      await expect(
        operation(connector, 'session.get', { sessionId: renamed.session.id })
      ).rejects.toThrow('SESSION_NOT_FOUND');

      const active = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'claude-code',
        externalSessionId: 'claude-active',
        nativeControl: 'MAR_MANAGED',
        cwd: workspace.path
      });
      internals.runtime.createMessageRun({
        sessionId: active.id,
        clientMessageId: 'active-remove',
        content: 'still running'
      });
      await expect(
        operation(connector, 'session.remove', { sessionId: active.id })
      ).rejects.toThrow('SESSION_ACTIVE');
    } finally {
      await connector?.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('restores Claude native tool results as realtime-consistent tool cards instead of user messages', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-claude-native-tools-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-claude-native-tools');
    const workspace = database.saveWorkspace({
      path: '/workspace/native-tools',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const transcriptDirectory = join(home, '.claude', 'projects', 'workspace-native-tools');
    try {
      await mkdir(transcriptDirectory, { recursive: true });
      await writeFile(
        join(transcriptDirectory, 'claude-tools.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            sessionId: 'claude-tools',
            cwd: workspace.path,
            message: { role: 'user', content: 'inspect the directory' }
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'claude-tools',
            cwd: workspace.path,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tool-pwd', name: 'Bash', input: { command: 'pwd' } }
              ]
            }
          }),
          JSON.stringify({
            type: 'user',
            sessionId: 'claude-tools',
            cwd: workspace.path,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-pwd',
                  content: '/workspace/native-tools\n'
                }
              ]
            }
          })
        ].join('\n')
      );
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1' }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'claude-code',
        externalSessionId: 'claude-tools',
        cwd: workspace.path,
        title: 'inspect the directory'
      });
      internals.nativeSessionProjectionService.remember([session]);

      const result = (await operation(connector, 'session.turns.list', {
        sessionId: session.id,
        limit: 10
      })) as { readonly turns: readonly unknown[] };
      expect(result.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userItemId: expect.any(String),
            items: [
              expect.objectContaining({
                kind: 'user_message',
                payload: expect.objectContaining({ text: 'inspect the directory' })
              }),
              expect.objectContaining({
                kind: 'command_execution',
                payload: expect.objectContaining({
                  command: 'pwd',
                  output: { blocks: [{ channel: 'COMBINED', text: '/workspace/native-tools\n' }] }
                })
              })
            ]
          })
        ])
      );
    } finally {
      database.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('restores Claude AskUserQuestion history as a completed read-only question item', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-claude-native-question-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const database = new NodeDatabase(':memory:', 'node-claude-native-question');
    const workspace = database.saveWorkspace({
      path: '/workspace/native-question',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const transcriptDirectory = join(home, '.claude', 'projects', 'native-question');
    try {
      await mkdir(transcriptDirectory, { recursive: true });
      await writeFile(
        join(transcriptDirectory, 'claude-question.jsonl'),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-question',
          cwd: workspace.path,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'ask-1',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Choose an implementation approach?',
                      header: 'Implementation approach',
                      options: [
                        { label: 'Option A', description: 'Modify directly' },
                        { label: 'Option B', description: 'Add tests first' }
                      ],
                      multiSelect: false
                    }
                  ]
                }
              }
            ]
          }
        })
      );
      const connector = new NodeConnector({
        reconnect: false,
        database,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: true, version: '2.1' }
        }
      });
      const internals = connector as unknown as {
        nativeSessionProjectionService: NativeSessionProjectionService;
        conversationHistoryService: ConversationHistoryService;
      };
      const session = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'claude-code',
        externalSessionId: 'claude-question',
        cwd: workspace.path
      });
      internals.nativeSessionProjectionService.remember([session]);

      const result = (await operation(connector, 'session.turns.list', {
        sessionId: session.id,
        limit: 10
      })) as { readonly turns: readonly unknown[] };
      expect(result.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userItemId: null,
            items: [
              expect.objectContaining({
                kind: 'user_input_request',
                status: 'COMPLETED',
                payload: {
                  requestId: 'native:ask-1',
                  questions: [
                    expect.objectContaining({
                      prompt: 'Choose an implementation approach?',
                      input: 'SINGLE_SELECT',
                      multiSelect: false,
                      options: [
                        expect.objectContaining({ value: 'Option A' }),
                        expect.objectContaining({ value: 'Option B' })
                      ]
                    })
                  ]
                }
              })
            ]
          })
        ])
      );
      connector.stop();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
