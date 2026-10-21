import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../../packages/protocol/src/index.js';
import { CodexAppServerClient } from '../../src/codex-app-server.js';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { fakeServer, captureSocket, capabilities, eventually } from './support/codex-connector.js';

function expectRunProjection(
  sent: Array<{ type: string; payload: Record<string, unknown> }>,
  status: string
) {
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: 'workbench.event',
      payload: expect.objectContaining({
        category: 'run',
        payload: expect.objectContaining({ run: expect.objectContaining({ status }) })
      })
    })
  );
}

describe('Codex Run lifecycle and control', () => {
  it('locates the active Run through the current Node Lease when stopping a session, even if the browser Run snapshot is stale', async () => {
    const database = new NodeDatabase(':memory:', 'node-session-interrupt');
    const workspace = database.saveWorkspace({
      path: '/workspace-session-interrupt',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
        transitionRun(runId: string, status: 'STARTING'): unknown;
      };
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'session-interrupt',
      content: 'stop me'
    }).run;
    internals.runtime.transitionRun(run.id, 'STARTING');

    await expect(
      internals.executeNodeOperation('session.interrupt', { sessionId: session.id })
    ).resolves.toMatchObject({ run: { id: run.id, status: 'CANCELLING' } });

    connector.stop();
  });

  it('marks the session as managed-active when the Run enters STARTING without waiting for a native Turn ID', () => {
    const database = new NodeDatabase(':memory:', 'node-session-activity');
    const workspace = database.saveWorkspace({
      path: '/workspace-session-activity',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    const internals = connector as unknown as {
      runtime: {
        createAgentSession(input: Record<string, unknown>): { readonly id: string };
        createMessageRun(input: Record<string, unknown>): { readonly run: { readonly id: string } };
      };
      emitRunEvent(runId: string, eventType: string, payload: unknown, status: 'STARTING'): void;
    };
    const session = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path
    });
    const run = internals.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'session-activity-message',
      content: 'start running'
    }).run;
    internals.emitRunEvent(run.id, 'run.started', {}, 'STARTING');

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'workbench.event',
        payload: expect.objectContaining({
          category: 'session',
          payload: expect.objectContaining({
            session: expect.objectContaining({ id: session.id, activity: 'MANAGED_ACTIVE' })
          })
        })
      })
    );
    database.close();
  });

  it('coalesces text deltas in a short window and flushes them in order before later state events', () => {
    vi.useFakeTimers();
    try {
      const database = new NodeDatabase(':memory:', 'node-stream-coalescing');
      const workspace = database.saveWorkspace({
        path: '/workspace-stream-coalescing',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        capabilities: capabilities(),
        database
      });
      const sent: { type: string; payload: Record<string, unknown> }[] = [];
      (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
      const internals = connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { readonly id: string };
          createMessageRun(input: Record<string, unknown>): {
            readonly run: { readonly id: string };
          };
          getRun(runId: string): unknown | undefined;
        };
        emitRunEvent(
          runId: string,
          eventType: string,
          payload: unknown,
          status?: 'STARTING' | 'RUNNING' | 'SUCCEEDED'
        ): void;
      };
      const session = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path
      });
      const run = internals.runtime.createMessageRun({
        sessionId: session.id,
        clientMessageId: 'stream-coalescing-message',
        content: 'streamed response'
      }).run;
      internals.emitRunEvent(run.id, 'run.started', {}, 'STARTING');
      internals.emitRunEvent(run.id, 'run.running', {}, 'RUNNING');
      sent.length = 0;

      internals.emitRunEvent(run.id, 'text.delta', { text: 'Hel' });
      internals.emitRunEvent(run.id, 'text.delta', { text: 'lo' });
      expect(sent).toHaveLength(0);
      internals.emitRunEvent(run.id, 'run.completed', {}, 'SUCCEEDED');

      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'workbench.event',
          payload: expect.objectContaining({
            category: 'conversation',
            payload: expect.objectContaining({
              delta: expect.objectContaining({
                text: 'Hello'
              })
            })
          })
        })
      );
      expectRunProjection(sent, 'SUCCEEDED');
      expect(internals.runtime.getRun(run.id)).toBeUndefined();
      (connector as unknown as { socket: unknown }).socket = undefined;
      connector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the local managed Codex App Server when the Node stops', async () => {
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer]
    });
    const stop = vi.spyOn(codex, 'stop');
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      codexClient: codex
    });

    await connector.stop();

    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects writes to an active thread not created by the current Node App Server', () => {
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true },
        claudeCode: { available: false }
      }
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'run-external',
          sessionId: 'session-external',
          runner: 'codex',
          input: 'do not inject',
          cwd: '/workspace',
          externalSessionId: 'foreign-thread'
        })
      )
    );
    expectRunProjection(sent, 'FAILED');
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'workbench.event',
        payload: expect.objectContaining({
          category: 'session',
          payload: expect.objectContaining({
            session: expect.objectContaining({
              activity: 'IDLE',
              control: expect.objectContaining({ level: 'MANAGED' })
            })
          })
        })
      })
    );
  });

  it('rejects startup when Codex is unavailable without exposing a session unavailable state', () => {
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false, version: 'codex-cli 9.9.9' },
        claudeCode: { available: false }
      }
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: 'run-unavailable',
          sessionId: 'session-unavailable',
          runner: 'codex',
          input: 'must not run',
          cwd: '/workspace'
        })
      )
    );
    expectRunProjection(sent, 'FAILED');
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'workbench.event',
        payload: expect.objectContaining({
          category: 'session',
          payload: expect.objectContaining({
            session: expect.objectContaining({ activity: 'IDLE' })
          })
        })
      })
    );
  });

  it('ends the Run as INTERRUPTED and releases its lease after Codex acknowledges interrupt', async () => {
    const database = new NodeDatabase(':memory:', 'node-1');
    database.saveWorkspace({
      id: 'workspace-cancel',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: ['-e', fakeServer]
    });
    await codex.start();
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database,
      codexClient: codex
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    const runtime = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
          transitionRun(id: string, state: 'STARTING' | 'RUNNING'): unknown;
          getRun(id: string): { status: string } | undefined;
        };
      }
    ).runtime;
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-cancel',
      runner: 'codex',
      cwd: '/workspace'
    });
    const created = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'cancel-message',
      content: 'long running'
    });
    runtime.transitionRun(created.run.id, 'STARTING');
    runtime.transitionRun(created.run.id, 'RUNNING');
    (
      connector as unknown as { codexClient: { execution: { runs: Map<string, unknown> } } }
    ).codexClient.execution.runs.set(created.run.id, {
      sessionId: session.id,
      threadId: 'thread-cancel',
      turnId: 'turn-cancel',
      cwd: '/workspace'
    });
    await (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation('run.cancel', { runId: created.run.id });
    await eventually(() => runtime.getRun(created.run.id) === undefined);
    expectRunProjection(sent, 'INTERRUPTED');
    codex.stop();
    database.close();
  });

  it('settles an early Codex cancellation as INTERRUPTED instead of leaving the Run in CANCELLING', async () => {
    const database = new NodeDatabase(':memory:', 'node-early-cancel');
    database.saveWorkspace({
      id: 'workspace-early-cancel',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    const runtime = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
          transitionRun(id: string, state: 'STARTING'): unknown;
          getRun(id: string): { status: string } | undefined;
        };
      }
    ).runtime;
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-early-cancel',
      runner: 'codex',
      cwd: '/workspace'
    });
    const created = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'early-cancel-message',
      content: 'cancel before turn/start'
    });
    runtime.transitionRun(created.run.id, 'STARTING');
    (
      connector as unknown as { codexClient: { execution: { runs: Map<string, unknown> } } }
    ).codexClient.execution.runs.set(created.run.id, {
      sessionId: session.id,
      threadId: 'thread-started-without-turn',
      cwd: '/workspace'
    });

    await (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation('run.cancel', { runId: created.run.id });

    (connector as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(
        createEnvelope('run.start', {
          runId: created.run.id,
          sessionId: session.id,
          runner: 'claude-code',
          input: 'must not start after cancellation',
          cwd: '/workspace'
        })
      )
    );

    expect(runtime.getRun(created.run.id)).toBeUndefined();
    expectRunProjection(sent, 'INTERRUPTED');
    expect(
      sent.filter(
        (message) => message.type === 'workbench.event' && message.payload.category === 'run'
      )
    ).toHaveLength(1);
    database.close();
  });

  it('settles an early Codex interruption as INTERRUPTED instead of treating it as startup failure', async () => {
    const database = new NodeDatabase(':memory:', 'node-early-interrupt');
    database.saveWorkspace({
      id: 'workspace-early-interrupt',
      path: '/workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      capabilities: capabilities(),
      database
    });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    (connector as unknown as { socket: unknown }).socket = captureSocket(sent, connector);
    const runtime = (
      connector as unknown as {
        runtime: {
          createAgentSession(input: Record<string, unknown>): { id: string };
          createMessageRun(input: Record<string, unknown>): { run: { id: string } };
          transitionRun(id: string, state: 'STARTING'): unknown;
          getRun(id: string): { status: string } | undefined;
        };
      }
    ).runtime;
    const session = runtime.createAgentSession({
      workspaceId: 'workspace-early-interrupt',
      runner: 'codex',
      cwd: '/workspace'
    });
    const created = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'early-interrupt-message',
      content: 'interrupt before turn/start'
    });
    runtime.transitionRun(created.run.id, 'STARTING');
    (
      connector as unknown as { codexClient: { execution: { runs: Map<string, unknown> } } }
    ).codexClient.execution.runs.set(created.run.id, {
      sessionId: session.id,
      threadId: 'thread-interrupted-before-turn',
      cwd: '/workspace'
    });

    await (
      connector as unknown as {
        executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
      }
    ).executeNodeOperation('run.interrupt', { runId: created.run.id });

    expect(runtime.getRun(created.run.id)).toBeUndefined();
    expectRunProjection(sent, 'INTERRUPTED');
    database.close();
  });
});
