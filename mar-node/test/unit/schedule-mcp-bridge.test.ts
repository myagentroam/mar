import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { NodeDatabase } from '../../src/database.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';

function invoke(
  endpoint: string,
  token: string,
  tool: string,
  args: object = {}
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ token, tool, arguments: args })}\n`)
    );
    socket.on('data', (chunk) => {
      body += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('scheduled task MCP capability', () => {
  it('is available before a task exists and can create a MAR task in the current session', async () => {
    const database = new NodeDatabase(':memory:', 'node-schedule-mcp-create');
    const workspace = database.saveWorkspace({
      path: '/schedule-mcp-create',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveNativeSessionMetadata({
      runner: 'codex',
      externalSessionId: 'native-session',
      workspaceId: workspace.id
    });
    const store = new ScheduledSessionStore(database.raw);
    const create = vi.fn(
      async (input: {
        sessionId: string;
        workspaceId: string;
        actorUserId: number;
        objective: string;
        cron: string;
      }) =>
        store.create({
          ...input,
          sessionId: 'native-session',
          runner: 'codex',
          ownerUserId: input.actorUserId,
          timezone: 'UTC'
        })
    );
    const server = new ScheduleMcpBridge(
      () => store,
      vi.fn(),
      vi.fn(),
      create,
      () => 'native-session'
    );
    try {
      const executionServer = await server.prepare({
        executionId: 'new-run',
        sessionId: 'bootstrap-session',
        workspaceId: workspace.id,
        actorUserId: 3
      });
      expect(executionServer).toMatchObject({
        name: 'mar_schedule',
        origin: 'BUILTIN',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: process.execPath,
        allowedToolCallers: {
          get_scheduled_task: ['direct', 'programmatic'],
          create_scheduled_task: ['direct', 'programmatic'],
          update_scheduled_task: ['direct', 'programmatic']
        }
      });
      const endpoint = executionServer.environment!.MAR_SCHEDULE_MCP_ENDPOINT!;
      const token = executionServer.environment!.MAR_SCHEDULE_MCP_TOKEN!;
      expect((await invoke(endpoint, token, 'get_scheduled_task')).result).toBeNull();
      expect(
        (
          await invoke(endpoint, token, 'create_scheduled_task', {
            objective: 'Check build',
            cron: '0 9 * * *'
          })
        ).result
      ).toMatchObject({ objective: 'Check build', ownerUserId: 3 });
      expect(create).toHaveBeenCalledWith({
        sessionId: 'bootstrap-session',
        workspaceId: workspace.id,
        actorUserId: 3,
        objective: 'Check build',
        cron: '0 9 * * *'
      });
      expect((await invoke(endpoint, token, 'get_scheduled_task')).result).toMatchObject({
        objective: 'Check build'
      });
      expect((await invoke(endpoint, token, 'mar_get_scheduled_task')).error).toBe(
        'SCHEDULE_TOOL_INVALID'
      );
      expect(
        (
          await invoke(endpoint, token, 'create_scheduled_task', {
            objective: 'Duplicate',
            cron: '0 9 * * *'
          })
        ).error
      ).toBe('SCHEDULE_ALREADY_EXISTS');
    } finally {
      await server.close();
      database.close();
    }
  });

  it('lets task owners edit in any execution and collaborators propose', async () => {
    const database = new NodeDatabase(':memory:', 'node-schedule-mcp');
    const workspace = database.saveWorkspace({
      path: '/schedule-mcp',
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
    const changed = vi.fn();
    const proposed = vi.fn();
    const server = new ScheduleMcpBridge(() => store, changed, proposed);
    try {
      const owner = await server.prepare({
        executionId: 'owner-run',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: task.revision,
        actorUserId: 1
      });
      const endpoint = owner.environment!.MAR_SCHEDULE_MCP_ENDPOINT!;
      const token = owner.environment!.MAR_SCHEDULE_MCP_TOKEN!;
      expect(
        (await invoke(endpoint, token, 'update_scheduled_task', { objective: 'Updated' })).result
      ).toMatchObject({ objective: 'Updated', revision: 2, ownerUserId: 1 });
      expect((await invoke(endpoint, token, 'get_scheduled_task')).result).toMatchObject({
        objective: 'Updated',
        revision: 2
      });
      expect(changed).toHaveBeenCalledWith(task.sessionId);

      const collaborator = await server.prepare({
        executionId: 'other-run',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: 2,
        actorUserId: 2
      });
      const proposal = (
        await invoke(
          endpoint,
          collaborator.environment!.MAR_SCHEDULE_MCP_TOKEN!,
          'update_scheduled_task',
          { objective: 'Proposed' }
        )
      ).result as Record<string, unknown>;
      expect(proposal.status).toBe('PENDING');
      expect(proposed).toHaveBeenCalledWith(task.sessionId, proposal.proposalId);
      expect(store.get(task.sessionId)?.objective).toBe('Updated');

      const automatic = await server.prepare({
        executionId: 'auto-run',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: 2,
        actorUserId: 1
      });
      expect(
        (
          await invoke(
            endpoint,
            automatic.environment!.MAR_SCHEDULE_MCP_TOKEN!,
            'update_scheduled_task',
            { objective: 'Automatic update' }
          )
        ).result
      ).toMatchObject({ objective: 'Automatic update', revision: 3, ownerUserId: 1 });
      expect(store.get(task.sessionId)?.objective).toBe('Automatic update');
      expect(
        (await invoke(endpoint, token, 'update_scheduled_task', { objective: 'Stale' })).error
      ).toBe('SCHEDULE_CAPABILITY_STALE');
      const paused = store.update(task.sessionId, 3, { enabled: false });
      const pausedRun = await server.prepare({
        executionId: 'paused-run',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: paused.revision,
        actorUserId: 1
      });
      const pausedToken = pausedRun.environment!.MAR_SCHEDULE_MCP_TOKEN!;
      expect((await invoke(endpoint, pausedToken, 'get_scheduled_task')).result).toMatchObject({
        enabled: false
      });
      expect(
        (await invoke(endpoint, pausedToken, 'update_scheduled_task', { objective: 'Later' }))
          .result
      ).toMatchObject({ objective: 'Later', enabled: false });
      const pausedCollaborator = await server.prepare({
        executionId: 'paused-other-run',
        sessionId: task.sessionId,
        taskId: task.id,
        revision: 5,
        actorUserId: 2
      });
      expect(
        (
          await invoke(
            endpoint,
            pausedCollaborator.environment!.MAR_SCHEDULE_MCP_TOKEN!,
            'update_scheduled_task',
            { objective: 'Proposed later' }
          )
        ).result
      ).toMatchObject({ status: 'PENDING' });
      server.revoke('owner-run');
      expect((await invoke(endpoint, token, 'get_scheduled_task')).error).toBe(
        'SCHEDULE_CAPABILITY_INVALID'
      );
    } finally {
      await server.close();
      database.close();
    }
  });
});
