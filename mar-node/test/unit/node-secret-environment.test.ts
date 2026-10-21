import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { TerminalManager, type TerminalPty } from '../../src/terminal.js';
import { parseSecretEnvironment } from '../../src/util/secret-environment.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { capabilities, eventually } from './support/codex-connector.js';

describe('Node secret environment', () => {
  it('accepts only bounded string environment-variable maps', () => {
    expect(parseSecretEnvironment({ API_KEY: 'secret' })).toEqual({ API_KEY: 'secret' });
    expect(() => parseSecretEnvironment({ 'BAD-NAME': 'secret' })).toThrow(
      'SECRET_ENVIRONMENT_INVALID'
    );
    expect(() => parseSecretEnvironment({ API_KEY: 'x'.repeat(16 * 1024 + 1) })).toThrow(
      'SECRET_ENVIRONMENT_LIMIT_EXCEEDED'
    );
  });

  it('merges the secret environment when creating a terminal without exposing values in the terminal summary', async () => {
    let spawnedEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    const manager = new TerminalManager({
      terminate: async () => undefined,
      ptyFactory: (_shell, _args, options) => {
        spawnedEnvironment = options.env;
        return fakePty();
      }
    });
    const terminal = manager.open({
      environment: { API_KEY: 'terminal-secret', MAR_USERNAME: 'alice' }
    });

    expect(spawnedEnvironment?.['API_KEY']).toBe('terminal-secret');
    expect(spawnedEnvironment?.['MAR_NODE_CONTEXT']).toBe('1');
    expect(spawnedEnvironment?.['MAR_USERNAME']).toBe('alice');
    expect(spawnedEnvironment?.['Path'] ?? spawnedEnvironment?.['PATH']).toContain(
      join('node_modules', '.bin')
    );
    expect(JSON.stringify(terminal)).not.toContain('terminal-secret');
    expect(JSON.stringify(terminal)).not.toContain('alice');
    await manager.shutdown();
  });

  it('Codex isolates environment and lifetime for each Run client', () => {
    const clients: Array<{
      stop: ReturnType<typeof vi.fn>;
      configureEnvironment: ReturnType<typeof vi.fn>;
      clearEnvironment: ReturnType<typeof vi.fn>;
      startThread: ReturnType<typeof vi.fn>;
    }> = [];
    const createClient = () => {
      const client = {
        onNotification: () => () => undefined,
        stop: vi.fn(),
        configureEnvironment: vi.fn(),
        clearEnvironment: vi.fn(),
        startThread: vi.fn(async () => ({ thread: { id: 'thread' } }))
      };
      clients.push(client);
      return client as unknown as CodexAppServerClient;
    };
    const runner = new CodexRunner(createClient(), undefined, createClient);

    runner.prepareEnvironment({ API_KEY: 'one' }, 'run-1');
    runner.prepareEnvironment({ API_KEY: 'one' }, 'run-2');
    runner.prepareEnvironment({ API_KEY: 'two' }, 'run-3');

    expect(clients).toHaveLength(4);
    expect(clients[1]?.configureEnvironment).toHaveBeenCalledWith({ API_KEY: 'one' });
    expect(clients[2]?.configureEnvironment).toHaveBeenCalledWith({ API_KEY: 'one' });
    expect(clients[3]?.configureEnvironment).toHaveBeenCalledWith({ API_KEY: 'two' });
    void runner.startThread('/workspace-one', undefined, 'run-1');
    void runner.startThread('/workspace-two', undefined, 'run-3');
    expect(clients[1]?.startThread).toHaveBeenCalledWith('/workspace-one', undefined);
    expect(clients[3]?.startThread).toHaveBeenCalledWith('/workspace-two', undefined);
    runner.releaseEnvironment('run-1');
    expect(clients[1]?.stop).toHaveBeenCalledOnce();
    runner.releaseEnvironment('run-2');
    expect(clients[2]?.stop).toHaveBeenCalledOnce();
    expect(clients[2]?.clearEnvironment).toHaveBeenCalledOnce();
    expect(clients[3]?.stop).not.toHaveBeenCalled();
    runner.releaseEnvironment('run-3');
    expect(clients[3]?.stop).toHaveBeenCalledOnce();
  });

  it('Codex releases the dedicated App Server after the last empty-environment lease', () => {
    const sharedClient = {
      onNotification: () => () => undefined,
      stop: vi.fn(),
      configureEnvironment: vi.fn(),
      clearEnvironment: vi.fn()
    } as unknown as CodexAppServerClient;
    const runClient = {
      onNotification: () => () => undefined,
      stop: vi.fn(),
      configureEnvironment: vi.fn(),
      clearEnvironment: vi.fn()
    } as unknown as CodexAppServerClient;
    const runner = new CodexRunner(sharedClient, undefined, () => runClient);

    runner.prepareEnvironment({}, 'run-empty');
    runner.releaseEnvironment('run-empty');

    expect(sharedClient.stop).not.toHaveBeenCalled();
    expect(runClient.stop).toHaveBeenCalledOnce();
    expect(runClient.configureEnvironment).not.toHaveBeenCalled();
    expect(runClient.clearEnvironment).toHaveBeenCalledOnce();
  });

  it('concurrent Codex Goal and regular sessions resolve their environments independently without changing the shared environment', async () => {
    const database = new NodeDatabase(':memory:', 'node-goal-mcp-secret-isolation');
    const workspace = database.saveWorkspace({
      path: '/workspace-goal-mcp-secret-isolation',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    let threadSequence = 0;
    const configureEnvironment = vi.fn();
    const startThread = vi.fn<CodexAppServerClient['startThread']>(async () => ({
      thread: { id: `thread-${++threadSequence}` }
    }));
    const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async (threadId) => ({
      turn: { id: `turn-${threadId}` }
    }));
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: {
        onNotification: () => () => undefined,
        start: async () => undefined,
        startThread,
        startTurn,
        configureEnvironment,
        clearEnvironment: vi.fn(),
        stop: vi.fn()
      } as unknown as CodexAppServerClient
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
      };
      handleMessage(raw: string): void;
    };
    try {
      for (const index of [1, 2]) {
        const session = internals.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: workspace.path
        });
        const run = internals.runtime.createMessageRun({
          sessionId: session.id,
          clientMessageId: `goal-message-${index}`,
          content: 'Goal Start'
        }).run;
        internals.handleMessage(
          JSON.stringify(
            createEnvelope('run.start', {
              runId: run.id,
              sessionId: session.id,
              runner: 'codex',
              input: `goal-${index}`,
              cwd: workspace.path,
              secretEnvironment: { MAR_USERNAME: `user-${index}` },
              executionMcpServers: [
                {
                  name: 'mar_goal',
                  origin: 'BUILTIN',
                  lifecycle: 'EXECUTION',
                  transport: 'STDIO',
                  command: process.execPath,
                  args: ['/goal-mcp-stdio.js'],
                  environment: {
                    MAR_GOAL_MCP_ENDPOINT: '/goal-mcp.sock',
                    MAR_GOAL_MCP_TOKEN: `token-${index}`,
                    MAR_USERNAME: 'forged-mcp-user'
                  }
                }
              ]
            })
          )
        );
      }
      const regularSession = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path
      });
      const regularRun = internals.runtime.createMessageRun({
        sessionId: regularSession.id,
        clientMessageId: 'regular-message',
        content: 'Regular session'
      }).run;
      internals.handleMessage(
        JSON.stringify(
          createEnvelope('run.start', {
            runId: regularRun.id,
            sessionId: regularSession.id,
            runner: 'codex',
            input: 'Regular session',
            cwd: workspace.path,
            secretEnvironment: {}
          })
        )
      );

      await eventually(() => startThread.mock.calls.length === 3);
      expect(configureEnvironment).toHaveBeenCalledTimes(3);
      for (const [index, [environment]] of configureEnvironment.mock.calls.entries()) {
        expect(environment).toMatchObject({
          MAR_CTL_CONTEXT_REQUIRED: '1',
          MAR_NODE_CONTEXT: '1',
          MAR_USERNAME: index < 2 ? `user-${index + 1}` : ''
        });
        expect(environment.Path ?? environment.PATH).toContain(join('node_modules', '.bin'));
        expect(environment).not.toHaveProperty('MAR_GOAL_MCP_TOKEN');
      }
      expect(startThread.mock.calls.map((call) => call[1])).toEqual([
        expect.objectContaining({
          mcpServers: {
            mar_goal: expect.objectContaining({
              env: expect.objectContaining({
                MAR_GOAL_MCP_TOKEN: 'token-1',
                MAR_USERNAME: 'user-1'
              })
            })
          }
        }),
        expect.objectContaining({
          mcpServers: {
            mar_goal: expect.objectContaining({
              env: expect.objectContaining({
                MAR_GOAL_MCP_TOKEN: 'token-2',
                MAR_USERNAME: 'user-2'
              })
            })
          }
        }),
        { mcpServers: {} }
      ]);
    } finally {
      connector.stop();
    }
  });
});

function fakePty(): TerminalPty {
  return {
    pid: 123,
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() }))
  };
}
