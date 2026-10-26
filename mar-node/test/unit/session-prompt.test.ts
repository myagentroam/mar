import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { capabilities, codexProfileClientFactory, eventually } from './support/codex-connector.js';

async function primeCodexProfile(connector: NodeConnector): Promise<void> {
  await (
    connector as unknown as {
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    }
  ).executeNodeOperation('runner.profiles.list', {});
}

function createCodexClient(
  startTurn: CodexAppServerClient['startTurn'] = async () => ({ turn: { id: 'turn-default' } })
): CodexAppServerClient {
  return {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    configureEnvironment: () => undefined,
    clearEnvironment: () => undefined,
    startThread: async () => ({ thread: { id: 'thread-new' } }),
    resumeThread: async (threadId: string) => ({ thread: { id: threadId } }),
    startTurn
  } as unknown as CodexAppServerClient;
}

describe('Workspace Session Prompt', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mar-session-prompt-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('updates and clears independent session prompts in Node metadata', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-prompt-metadata');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({ reconnect: false, database });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
      executeNodeOperation(
        operation: string,
        input: unknown
      ): Promise<{
        session: { id: string; sessionPrompt: string | null };
      }>;
    };

    const first = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      externalSessionId: 'thread-prompt-first',
      nativeControl: 'MAR_MANAGED',
      cwd: workspace.path
    });
    const second = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      externalSessionId: 'thread-prompt-second',
      nativeControl: 'MAR_MANAGED',
      cwd: workspace.path
    });

    try {
      await expect(
        internals.executeNodeOperation('session.metadata.update', {
          sessionId: first.id,
          sessionPrompt: '  First session rule  '
        })
      ).resolves.toMatchObject({ session: { sessionPrompt: 'First session rule' } });
      await internals.executeNodeOperation('session.metadata.update', {
        sessionId: second.id,
        sessionPrompt: 'Second session rule'
      });

      expect(
        database.getNativeSessionMetadata('codex', 'thread-prompt-first', workspace.id)
      ).toMatchObject({ sessionPrompt: 'First session rule' });
      expect(
        database.getNativeSessionMetadata('codex', 'thread-prompt-second', workspace.id)
      ).toMatchObject({ sessionPrompt: 'Second session rule' });

      await expect(
        internals.executeNodeOperation('session.metadata.update', {
          sessionId: first.id,
          sessionPrompt: '  '
        })
      ).resolves.toMatchObject({ session: { sessionPrompt: null } });
      expect(
        database.getNativeSessionMetadata('codex', 'thread-prompt-first', workspace.id)
      ).toMatchObject({ sessionPrompt: null });
      expect(
        database.getNativeSessionMetadata('codex', 'thread-prompt-second', workspace.id)
      ).toMatchObject({ sessionPrompt: 'Second session rule' });

      await expect(
        internals.executeNodeOperation('session.metadata.update', {
          sessionId: first.id,
          sessionPrompt: 'x'.repeat(20_001)
        })
      ).rejects.toThrow('SESSION_PROMPT_INVALID');
      expect(
        database.getNativeSessionMetadata('codex', 'thread-prompt-first', workspace.id)
      ).toMatchObject({ sessionPrompt: null });
    } finally {
      await connector.stop();
    }
  });

  it('preserves Session Prompt through native discovery projection and external-session recovery', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-prompt-recovery');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'mar-agent',
      externalSessionId: 'thread-prompt-recovered',
      workspaceId: workspace.id,
      sessionPrompt: 'Persisted session rule'
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        marAgent: { available: true, version: '0.9.134' }
      }
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      nativeSessionProjectionService: {
        project(input: Record<string, unknown>): {
          id: string;
          sessionPrompt: string | null;
        };
        remember(sessions: readonly unknown[]): void;
      };
      externalSessionResumeService: {
        resume(session: { id: string }): Promise<
          | {
              id: string;
              sessionPrompt: string | null;
              nativeControl: string;
            }
          | undefined
        >;
      };
    };

    try {
      const discovered = internals.nativeSessionProjectionService.project({
        workspace,
        runner: 'mar-agent',
        externalSessionId: 'thread-prompt-recovered',
        cwd: workspace.path
      });
      expect(discovered.sessionPrompt).toBe('Persisted session rule');
      internals.nativeSessionProjectionService.remember([discovered]);

      await expect(
        internals.externalSessionResumeService.resume(discovered)
      ).resolves.toMatchObject({
        id: discovered.id,
        sessionPrompt: 'Persisted session rule',
        nativeControl: 'MAR_MANAGED'
      });
    } finally {
      await connector.stop();
    }
  });

  it('merges instructions once per execution, keeps them out of message text, and refreshes queued work', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-prompt-execution');
    const workspace = database.saveWorkspace({
      path: root,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let turnNumber = 0;
    const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
      turn: { id: `turn-${++turnNumber}` }
    }));
    const client = createCodexClient(startTurn);
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: client,
      codexRunClientFactory: () => client,
      codexProfileClientFactory
    });
    await primeCodexProfile(connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { id: string };
      };
      codexRunController: {
        handleNotification(notification: { method: string; params: unknown }): void;
      };
      executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      externalSessionId: 'thread-session-prompt-execution',
      nativeControl: 'MAR_MANAGED',
      cwd: workspace.path
    });

    try {
      await internals.executeNodeOperation('session.metadata.update', {
        sessionId: session.id,
        sessionPrompt: 'Initial session rule'
      });
      await internals.executeNodeOperation('session.message', {
        sessionId: session.id,
        clientMessageId: 'prompt-first-message',
        content: 'Visible first message',
        personalInstructions: {
          common: 'Shared rule',
          codex: 'Codex rule',
          claudeCode: '',
          openCode: '',
          marAgent: ''
        }
      });
      await eventually(() => startTurn.mock.calls.length === 1);
      expect(startTurn.mock.calls[0]?.[1]).toBe('Visible first message');
      expect(startTurn.mock.calls[0]?.[3]).toMatchObject({
        developerInstructions: 'Shared rule\n\nCodex rule\n\nInitial session rule'
      });

      const queued = (await internals.executeNodeOperation('session.message', {
        sessionId: session.id,
        clientMessageId: 'prompt-queued-message',
        content: 'Visible queued message',
        deliveryIntent: 'QUEUE'
      })) as { delivery: string };
      expect(queued.delivery).toBe('QUEUED');
      await internals.executeNodeOperation('session.metadata.update', {
        sessionId: session.id,
        sessionPrompt: 'Updated session rule'
      });

      internals.codexRunController.handleNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-session-prompt-execution',
          turn: { id: 'turn-1', status: 'completed' }
        }
      });
      await eventually(() => startTurn.mock.calls.length === 2);
      expect(startTurn.mock.calls[1]?.[1]).toBe('Visible queued message');
      expect(startTurn.mock.calls[1]?.[3]).toMatchObject({
        developerInstructions: 'Updated session rule'
      });

      await internals.executeNodeOperation('session.metadata.update', {
        sessionId: session.id,
        sessionPrompt: null
      });
      internals.codexRunController.handleNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-session-prompt-execution',
          turn: { id: 'turn-2', status: 'completed' }
        }
      });
      await internals.executeNodeOperation('session.command.execute', {
        sessionId: session.id,
        commandId: 'goal',
        input: '/goal Verify the Session Prompt continuation',
        personalInstructions: { common: 'Goal account rule' }
      });
      await eventually(() => startTurn.mock.calls.length === 3);
      expect(startTurn.mock.calls[2]?.[3]).toMatchObject({
        developerInstructions: 'Goal account rule'
      });
      await internals.executeNodeOperation('session.metadata.update', {
        sessionId: session.id,
        sessionPrompt: 'Continuation session rule'
      });
      internals.codexRunController.handleNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-session-prompt-execution',
          turn: { id: 'turn-3', status: 'completed' }
        }
      });
      await eventually(() => startTurn.mock.calls.length === 4);
      expect(startTurn.mock.calls[3]?.[3]).toMatchObject({
        developerInstructions: 'Goal account rule\n\nContinuation session rule'
      });
    } finally {
      await connector.stop();
    }
  });
});
