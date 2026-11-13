import { once } from 'node:events';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { GoalMcpBridge } from '../../src/service/goal-mcp-bridge.js';
import { GoalRuntime } from '../../src/service/goal-runtime.js';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof net>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

const cases = [
  {
    name: 'Goal',
    async create() {
      const runtime = new GoalRuntime(() => undefined);
      const goal = runtime.start('session-1', 'objective');
      const changed = vi.fn();
      const authorize = vi.fn((capability: { sessionId: string }) => capability.sessionId);
      const bridge = new GoalMcpBridge(runtime, changed, authorize);
      const descriptor = await bridge.prepare({
        executionId: 'execution-1',
        sessionId: goal.sessionId,
        goalId: goal.id,
        revision: goal.revision
      });
      return {
        endpoint: descriptor.environment!.MAR_GOAL_MCP_ENDPOINT!,
        request: JSON.stringify({
          token: descriptor.environment!.MAR_GOAL_MCP_TOKEN!,
          tool: 'update_goal',
          arguments: { status: 'completed' }
        }),
        effects: () => changed.mock.calls.length,
        authorize,
        close: () => bridge.close()
      };
    }
  },
  {
    name: 'Schedule',
    async create() {
      const database = new NodeDatabase(':memory:', 'node-builtin-mcp-ipc');
      const workspace = database.saveWorkspace({
        path: '/builtin-mcp-ipc',
        kind: 'DIRECTORY',
        gitSummary: null
      });
      database.saveNativeSessionMetadata({
        runner: 'codex',
        externalSessionId: 'session-1',
        workspaceId: workspace.id
      });
      const store = new ScheduledSessionStore(database.raw);
      const task = store.create({
        sessionId: 'session-1',
        workspaceId: workspace.id,
        runner: 'codex',
        ownerUserId: 1,
        objective: 'Original',
        cron: '0 * * * *',
        timezone: 'UTC'
      });
      const authorize = vi.fn((capability: { sessionId: string }) => capability.sessionId);
      const bridge = new ScheduleMcpBridge(() => store, vi.fn(), vi.fn(), authorize);
      const descriptor = await bridge.prepare({
        executionId: 'execution-1',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: task.revision,
        actorUserId: 2
      });
      return {
        endpoint: descriptor.environment!.MAR_SCHEDULE_MCP_ENDPOINT!,
        request: JSON.stringify({
          token: descriptor.environment!.MAR_SCHEDULE_MCP_TOKEN!,
          tool: 'update_scheduled_task',
          arguments: { objective: 'Proposed' }
        }),
        effects: () => store.pendingProposals(task.id).length,
        authorize,
        async close() {
          try {
            await bridge.close();
          } finally {
            database.close();
          }
        }
      };
    }
  }
];

describe.each(cases)('$name MCP IPC', ({ create }) => {
  let fixture: Awaited<ReturnType<typeof create>>;
  let client: net.Socket;
  let peer: net.Socket;
  let errors: Error[];

  beforeEach(async () => {
    errors = [];
    const accepted = Promise.withResolvers<net.Socket>();
    const { createServer } = await vi.importActual<typeof net>('node:net');
    vi.mocked(net.createServer).mockImplementation((...args) => {
      const server = createServer(...args);
      server.once('connection', (socket) => {
        socket.on('error', (error) => errors.push(error));
        accepted.resolve(socket);
      });
      return server;
    });
    fixture = await create();
    client = net.connect({ path: fixture.endpoint, allowHalfOpen: true });
    client.on('error', () => undefined);
    peer = await accepted.promise;
  });

  afterEach(async () => {
    client?.destroy();
    try {
      await fixture?.close();
    } finally {
      vi.mocked(net.createServer).mockReset();
    }
  });

  it('assembles a fragmented request and ignores chunks after the first response', async () => {
    const split = Math.floor(fixture.request.length / 2);
    const partial = once(peer, 'data');
    client.write(fixture.request.slice(0, split));
    await partial;
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.effects()).toBe(0);

    const response = once(client, 'data');
    client.write(`${fixture.request.slice(split)}\n`);
    const [body] = await response;
    expect(JSON.parse(String(body))).toHaveProperty('result');
    expect(fixture.effects()).toBe(1);

    const extra = once(peer, 'data');
    client.end('\n');
    await extra;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.effects()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('rejects an oversized complete request without authorization or side effects', () => {
    const request = JSON.parse(fixture.request) as { arguments: Record<string, unknown> };
    request.arguments.padding = 'x'.repeat(65_000);
    // Deliver one transport chunk regardless of platform-specific socket buffering.
    peer.emit('data', `${JSON.stringify(request)}\n`);
    expect(peer.destroyed).toBe(true);
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.effects()).toBe(0);
  });

  it('destroys the connection on a transport error without dispatching a request', () => {
    peer.emit('error', new Error('IPC fixture transport failure'));
    expect(peer.destroyed).toBe(true);
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.effects()).toBe(0);
  });
});
