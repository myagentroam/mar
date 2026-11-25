import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { createServerApp, type ServerApplication } from '../../ee/server/src/app.js';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { FakeRunner } from '../../mar-node/src/fake-runner.js';
import type { CodexAppServerClient } from '../../mar-node/src/codex-app-server.js';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import {
  CORE_MYSQL_MIGRATIONS,
  MYSQL_NOTIFICATION_GROUPS_SCHEMA
} from '../../packages/server-core/src/mysql-schema.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';

test('Scheduled task MySQL migrations preserve existing rows on retry', async () => {
  const database = resolvePlaywrightTestDatabase(
    `${process.env.MAR_TEST_RUN_ID}-scheduled-migration-${randomUUID()}`
  );
  await createPlaywrightTestDatabase(database);
  const pool = mysql.createPool(database.databaseUrl);
  let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
  try {
    connection = await pool.getConnection();
    await connection.execute(MYSQL_NOTIFICATION_GROUPS_SCHEMA.workbench_notifications!);
    await connection.execute(`INSERT INTO workbench_notifications
      (id,user_id,source_id,source_key,kind,title,message,node_id,workspace_id,session_id,
       session_title,run_id,created_at,expires_at)
      VALUES ('legacy',1,'legacy','legacy','run','Title','Legacy message','node','workspace',
              'native-session','Session','run',1,2)`);

    const index = CORE_MYSQL_MIGRATIONS.find((migration) => migration.version === 41)!;
    const notifications = CORE_MYSQL_MIGRATIONS.find((migration) => migration.version === 42)!;
    await index.up(connection);
    await notifications.up(connection);
    await connection.execute(`INSERT INTO scheduled_task_index
      (node_id,workspace_id,task_id,owner_user_id,name,runner,target_kind,enabled,next_run_at,synced_at)
      VALUES ('node','workspace','task',1,'Task','mar-agent','newSession',1,2,1)`);
    await connection.execute(`INSERT INTO workbench_notifications
      (id,user_id,source_id,source_key,kind,title,message,node_id,workspace_id,session_title,
       run_id,created_at,expires_at,target_type,task_id,task_reference)
      VALUES ('scheduled',1,'scheduled','scheduled','schedule','Title','Task message','node',
              'workspace','Task','',1,2,'SCHEDULED_TASK','task',
              JSON_OBJECT('kind','occurrence','occurrenceId','occurrence'))`);

    await index.up(connection);
    await notifications.up(connection);
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id,target_type,session_id,
      task_id,task_reference,message FROM workbench_notifications ORDER BY id`);
    expect(rows).toEqual([
      {
        id: 'legacy',
        target_type: 'WORKSPACE_SESSION',
        session_id: 'native-session',
        task_id: null,
        task_reference: null,
        message: 'Legacy message'
      },
      {
        id: 'scheduled',
        target_type: 'SCHEDULED_TASK',
        session_id: null,
        task_id: 'task',
        task_reference: { kind: 'occurrence', occurrenceId: 'occurrence' },
        message: 'Task message'
      }
    ]);
    const [tasks] = await connection.execute<RowDataPacket[]>(
      'SELECT task_id,next_run_at FROM scheduled_task_index'
    );
    expect(tasks).toEqual([{ task_id: 'task', next_run_at: 2 }]);
  } finally {
    connection?.release();
    await pool.end();
    await dropPlaywrightTestDatabase(database);
  }
});

test('Scheduled tasks run through the real Server, Node and execution history', async ({
  playwright
}) => {
  test.setTimeout(180_000);
  const database = resolvePlaywrightTestDatabase(
    `${process.env.MAR_TEST_RUN_ID}-scheduled-${randomUUID()}`
  );
  const root = await mkdtemp(join(tmpdir(), 'mar-scheduled-execution-'));
  const workspace = join(root, 'workspace');
  let node: NodeConnector | undefined;
  let app: ServerApplication | undefined;
  let requestContext: APIRequestContext | undefined;
  let databaseCreated = false;
  const previousTZ = process.env.TZ;
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[homeKey];
  process.env.TZ = 'UTC';
  process.env[homeKey] = root;
  const inputs: unknown[] = [];
  try {
    await mkdir(workspace);
    await createPlaywrightTestDatabase(database);
    databaseCreated = true;
    ({ app } = await createServerApp({
      databaseUrl: database.databaseUrl,
      dataDirectory: join(root, 'server'),
      secureCookies: false
    }));
    const baseURL = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = (requestContext = await playwright.request.newContext({ baseURL }));
    const login = await read<{ csrfToken: string }>(
      await request.post('/api/auth/login', {
        data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
      })
    );
    const changed = await read<{ csrfToken: string }>(
      await request.post('/api/auth/change-password', {
        headers: { 'x-csrf-token': login.csrfToken },
        data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'ScheduledExecutionTest123!' }
      })
    );
    const headers = { 'x-csrf-token': changed.csrfToken };
    const registration = await read<{ token: string }>(
      await request.post('/api/node-registration-tokens', {
        headers,
        data: { displayName: 'Scheduled execution test Node' }
      })
    );
    const capabilities = {
      platform: 'linux' as const,
      architecture: 'x64',
      nodeAppVersion: nodePackage.version,
      nodeVersion: process.version,
      codex: { available: true },
      claudeCode: { available: false }
    };
    node = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: baseURL,
        allowedRoots: [workspace],
        dataDirectory: join(root, 'node'),
        registrationToken: registration.token
      },
      capabilities,
      capabilityDetector: () => capabilities,
      reconnect: false,
      codexProfileClientFactory: () =>
        ({
          start: async () => undefined,
          stop: () => undefined,
          listModels: async () => ({ data: [], nextCursor: null })
        }) as unknown as CodexAppServerClient,
      fakeRunner: new FakeRunner(),
      fakeScript(input) {
        inputs.push(input);
        return [{ type: 'success' }];
      }
    });
    await node.start();
    let nodeId = '';
    await expect
      .poll(
        async () => {
          const { nodes } = await read<{ nodes: { id: string; connected: boolean }[] }>(
            await request.get('/api/nodes')
          );
          nodeId = nodes.find((entry) => entry.connected)?.id ?? '';
          return nodeId;
        },
        { timeout: 15_000 }
      )
      .not.toBe('');
    const created = await read<{ workspace: { id: string } }>(
      await request.post('/api/workspaces', {
        headers,
        data: { nodeId, path: workspace }
      }),
      201
    );
    const scope = { nodeId, workspaceId: created.workspace.id };
    const seeded = await read<{ session: { id: string } }>(
      await request.post('/api/agent-sessions/start', {
        headers,
        data: {
          ...scope,
          runner: 'codex',
          cwd: workspace,
          modelId: 'gpt-5.6-sol',
          title: 'Schedule integration',
          content: 'Seed the conversation',
          clientMessageId: 'schedule-seed'
        }
      }),
      201
    );
    const sessionId = seeded.session.id;
    await expect
      .poll(async () => {
        const { runs } = await read<{ runs: { status: string }[] }>(
          await request.get(`/api/agent-sessions/${encodeURIComponent(sessionId)}/runs`, {
            params: { nodeId }
          })
        );
        return runs.map((run) => run.status);
      })
      .toEqual(['SUCCEEDED']);

    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const dueAt = base + (Date.now() - base > 48_000 ? 120_000 : 60_000);
    const at = (timestamp: number) => {
      const iso = new Date(timestamp).toISOString();
      return {
        days: { kind: 'dates', dates: [iso.slice(0, 10)] },
        times: { kind: 'times', times: [iso.slice(11, 16)] }
      };
    };
    const schedule = async (name: string, objective: string, groups: ReturnType<typeof at>[]) =>
      (
        await read<{ task: { id: string; revision: number } }>(
          await request.post('/api/scheduled-tasks', {
            headers,
            data: { ...scope, target: { kind: 'existing', sessionId }, name, objective, groups }
          })
        )
      ).task;
    const a = await schedule('Later task', 'Do not run yet', [at(dueAt + 3_600_000)]);
    const b = await schedule('Due task', 'Old instruction', [at(dueAt), at(dueAt + 7_200_000)]);
    expect(a.id).not.toBe(b.id);
    await read(
      await request.put(`/api/scheduled-tasks/${b.id}`, {
        headers,
        data: {
          ...scope,
          expectedRevision: b.revision,
          patch: { objective: 'Use the revised instruction' }
        }
      })
    );
    const { items } = await read<{ items: { id: string }[] }>(
      await request.get('/api/scheduled-tasks', { params: { ...scope, sessionId } })
    );
    expect(items.map((task) => task.id).sort()).toEqual([a.id, b.id].sort());
    const history = async () =>
      await read<{
        page: number;
        pageSize: number;
        total: number;
        hasMore: boolean;
        items: {
          occurrenceId: string;
          taskId: string;
          state: string;
          dueAt: number;
          run: { runId: string; sessionId: string };
        }[];
      }>(
        await request.get('/api/scheduled-occurrences', {
          params: { ...scope, sessionId, page: 99, limit: 1 }
        })
      );
    await expect
      .poll(async () => (await history()).items.map((item) => item.state), {
        timeout: 125_000,
        intervals: [250, 1000]
      })
      .toEqual(['SUCCEEDED']);
    const historyPage = await history();
    expect(historyPage).toMatchObject({ page: 1, pageSize: 1, total: 1, hasMore: false });
    const [entry] = historyPage.items;
    expect(entry).toMatchObject({ taskId: b.id, dueAt, run: { sessionId } });
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[1])).toContain('Use the revised instruction');
    expect(JSON.stringify(inputs[1])).not.toContain('Old instruction');
    const detail = await read(
      await request.get(`/api/scheduled-occurrences/${entry!.occurrenceId}`, { params: scope })
    );
    expect(detail).toMatchObject({
      snapshot: { revision: 2, objective: 'Use the revised instruction' }
    });
    const run = await read(
      await request.get(`/api/agent-runs/${entry!.run.runId}`, { params: scope })
    );
    expect(run).toMatchObject({
      run: { id: entry!.run.runId, status: 'SUCCEEDED', sessionId, workspaceId: scope.workspaceId }
    });
  } finally {
    try {
      try {
        await node?.stop();
      } finally {
        try {
          await requestContext?.dispose();
        } finally {
          await app?.shutdown();
        }
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
      if (previousHome === undefined) delete process.env[homeKey];
      else process.env[homeKey] = previousHome;
      if (databaseCreated) await dropPlaywrightTestDatabase(database);
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function read<T = unknown>(response: APIResponse, status = 200): Promise<T> {
  const body = (await response.json()) as T & { code?: string; error?: { code?: string } };
  expect(
    response.status(),
    `${new URL(response.url()).pathname} ${body?.error?.code ?? body?.code ?? ''}`
  ).toBe(status);
  return body;
}
