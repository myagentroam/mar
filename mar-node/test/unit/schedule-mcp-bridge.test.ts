import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { SessionScheduleService } from '../../src/session/session-schedule-service.js';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import { dailyTriggers } from './scheduled-task-fixtures.js';

function fixture() {
  const database = new NodeDatabase(':memory:', 'node-schedule-mcp');
  const workspace = database.saveWorkspace({
    path: '/schedule-mcp',
    kind: 'DIRECTORY',
    gitSummary: null
  });
  const runtime = new NodeRuntimeState(
    () => 'node-schedule-mcp',
    (id) => database.getWorkspace(id)
  );
  const createSession = (id: string) => {
    const session = runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: id
    });
    database.saveNativeSessionMetadata({
      runner: session.runner,
      externalSessionId: session.id,
      workspaceId: workspace.id,
      pinned: true
    });
    return session;
  };
  const first = createSession('first');
  const sibling = createSession('sibling');
  const changed = vi.fn();
  const proposed = vi.fn();
  const service = new SessionScheduleService({
    database: () => database,
    runtime,
    projection: { createMetadataProjection: async () => undefined } as never,
    emitSession: vi.fn(),
    changed,
    proposed
  });
  let active = true;
  const bridge = new ScheduleMcpBridge(
    async ({ sessionId }) => (active ? sessionId : undefined),
    service.invokeMcp.bind(service)
  );
  const clients: Client[] = [];
  const open = async (actorUserId: number, sessionId = first.id) => {
    const config = await bridge.prepare({
      executionId: 'execution-1',
      sessionId,
      workspaceId: workspace.id,
      actorUserId
    });
    if (config.transport !== 'STDIO' || config.command === undefined || config.args === undefined)
      throw new Error('Test requires stdio');
    const client = new Client({ name: 'schedule-contract-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        env: { ...config.environment }
      })
    );
    return client;
  };
  const close = async () => {
    await Promise.all(clients.map((client) => client.close()));
    await bridge.close();
    database.close();
  };
  return {
    database,
    workspace,
    first,
    sibling,
    changed,
    proposed,
    open,
    close,
    revoke: () => {
      active = false;
    }
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { text: string }[];
  if (response.isError === true) throw new Error(content[0]?.text);
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const input = (name: string, objective: string) => ({
  name,
  objective,
  triggers: dailyTriggers('10:00', '20:00')
});

describe('scheduled task MCP capability', () => {
  it('publishes only task inputs and minimal projections; creates two tasks, pages and updates by ID', async () => {
    const f = fixture();
    try {
      const owner = await f.open(7);
      const catalog = (await owner.listTools()).tools;
      expect(catalog.map((tool) => tool.name)).toEqual([
        'list_scheduled_tasks',
        'get_scheduled_task',
        'create_scheduled_task',
        'update_scheduled_task',
        'list_scheduled_task_runs'
      ]);
      expect(
        Object.keys(
          catalog.find((tool) => tool.name === 'create_scheduled_task')!.inputSchema.properties!
        )
      ).toEqual(['name', 'objective', 'triggers']);
      expect(await call(owner, 'list_scheduled_tasks')).toEqual({ items: [] });
      const a = await call(owner, 'create_scheduled_task', input('A', 'First'));
      const b = await call(owner, 'create_scheduled_task', input('B', 'Second'));
      expect(a.taskId).not.toBe(b.taskId);
      expect(Object.keys(b).sort()).toEqual(['nextRunAt', 'revision', 'taskId', 'timezone']);
      const legacy = await owner.callTool({
        name: 'create_scheduled_task',
        arguments: { ...input('Legacy', 'Must reject'), groups: dailyTriggers('11:00') }
      });
      expect(legacy.isError).toBe(true);
      const page = await call(owner, 'list_scheduled_tasks', { limit: 1 });
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(page.items).toEqual([
        expect.objectContaining({ taskId: expect.any(String), name: expect.any(String) })
      ]);
      const next = await call(owner, 'list_scheduled_tasks', { limit: 1, cursor: page.nextCursor });
      expect([...(page.items as object[]), ...(next.items as object[])].map(Object.keys)).toEqual([
        ['taskId', 'revision', 'nextRunAt', 'name', 'state'],
        ['taskId', 'revision', 'nextRunAt', 'name', 'state']
      ]);
      const updated = await call(owner, 'update_scheduled_task', {
        taskId: b.taskId,
        expectedRevision: 1,
        patch: { objective: 'Updated', triggers: dailyTriggers('10:00') }
      });
      expect(updated).toEqual({
        taskId: b.taskId,
        revision: 2,
        nextRunAt: expect.any(Number)
      });
      await expect(
        call(owner, 'update_scheduled_task', {
          taskId: b.taskId,
          expectedRevision: 1,
          patch: { name: 'Stale' }
        })
      ).rejects.toThrow('SCHEDULE_REVISION_CONFLICT');
      const detail = await call(owner, 'get_scheduled_task', { taskId: b.taskId });
      expect(detail).toEqual({
        ...updated,
        name: 'B',
        state: 'SCHEDULED',
        objective: 'Updated',
        triggers: dailyTriggers('10:00'),
        timezone: b.timezone
      });
      expect(await call(owner, 'get_scheduled_task', { taskId: a.taskId })).toHaveProperty(
        'objective',
        'First'
      );
      const store = new ScheduledSessionStore(f.database.raw);
      const claim = store.claim(String(b.taskId), Number(updated.nextRunAt), 2)!;
      store.finish(claim, 'SUCCEEDED', undefined, 'scheduled-run');
      expect(await call(owner, 'list_scheduled_task_runs', { taskId: b.taskId })).toEqual({
        items: [{ dueAt: updated.nextRunAt, state: 'SUCCEEDED', runId: 'scheduled-run' }]
      });
      expect(f.changed).toHaveBeenCalledTimes(3);
    } finally {
      await f.close();
    }
  });

  it('does not accept client scope, expose sibling tasks or permit editing after execution revocation', async () => {
    const f = fixture();
    try {
      const owner = await f.open(7);
      const collaborator = await f.open(8);
      const sibling = await f.open(8, f.sibling.id);
      const a = await call(owner, 'create_scheduled_task', input('A', 'First'));
      await expect(
        call(owner, 'create_scheduled_task', { ...input('B', 'Second'), ownerUserId: 1 })
      ).rejects.toThrow('ownerUserId');
      await expect(call(sibling, 'get_scheduled_task', { taskId: a.taskId })).rejects.toThrow(
        'SCHEDULE_NOT_FOUND'
      );
      await expect(call(sibling, 'list_scheduled_task_runs', { taskId: a.taskId })).rejects.toThrow(
        'SCHEDULE_NOT_FOUND'
      );
      const proposed = await call(collaborator, 'update_scheduled_task', {
        taskId: a.taskId,
        expectedRevision: 1,
        patch: { objective: 'Proposal' }
      });
      expect(proposed).toEqual({ proposalId: expect.any(String), baseRevision: 1 });
      expect(f.proposed).toHaveBeenCalledWith(a.taskId, proposed.proposalId);
      expect(await call(owner, 'get_scheduled_task', { taskId: a.taskId })).toHaveProperty(
        'objective',
        'First'
      );
      f.revoke();
      await expect(
        call(owner, 'create_scheduled_task', input('Late', 'Do not save'))
      ).rejects.toThrow('SCHEDULE_CAPABILITY_STALE');
      expect(new ScheduledSessionStore(f.database.raw).list(f.workspace.id).tasks).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
