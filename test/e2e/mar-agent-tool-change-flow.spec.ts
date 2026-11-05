import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { createServerApp } from '../../ee/server/src/app.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import { ModelSettingsStore } from '../../packages/server-core/src/model-settings.js';

test('real Server and Node resume captured Auto calls after online approval and preserve immutable changes', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium');
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'mar-tool-diff-flow-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  const previousHome = process.env['HOME'];
  const db = resolvePlaywrightTestDatabase(`${requiredEnvironment('MAR_TEST_RUN_ID')}-tool-diff`);
  await createPlaywrightTestDatabase(db);
  const app = (
    await createServerApp({
      databaseUrl: db.databaseUrl,
      dataDirectory: join(root, 'server'),
      secureCookies: false
    })
  ).app;
  let phase = 0;
  let askFirst = true;
  let awaitingResult = false;
  const model = createServer(async (request, response) => {
    try {
      const body = JSON.parse(await readRequest(request));
      const tools = body.tools ?? [];
      const code = tools.find((entry: { name: string }) => entry.name === 'code_exec');
      if (!code || awaitingResult) {
        awaitingResult = false;
        sendText(response, randomUUID(), 'Change completed.');
        return;
      }
      if (askFirst) {
        askFirst = false;
        const key = Object.keys(code.input_schema.properties).find(
          (name) => name !== 'permission'
        )!;
        sendTools(response, randomUUID(), [
          {
            id: 'outer-ask',
            name: 'code_exec',
            input: {
              [key]: 'await tools.exec({command:"touch rejected.txt"});',
              permission: { action: 'ask', reason: 'Confirm this Code Mode call.' }
            }
          }
        ]);
        return;
      }
      const before = phase === 0 ? 'A' : 'B',
        after = phase++ === 0 ? 'B' : 'C';
      const patch = `*** Begin Patch\n*** Update File: file.txt\n@@\n-${before}\n+${after}\n*** End Patch`;
      awaitingResult = true;
      const key = Object.keys(code.input_schema.properties)[0]!;
      sendTools(response, randomUUID(), [
        {
          id: `change-${phase}`,
          name: 'code_exec',
          input: {
            [key]: `await tools.apply_patch({patch:${JSON.stringify(patch)}});`,
            ...(phase === 1
              ? { permission: { action: 'ask', reason: 'Confirm this captured change.' } }
              : {})
          }
        }
      ]);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  let connector: NodeConnector | undefined;
  try {
    await mkdir(workspace);
    await mkdir(home);
    await writeFile(join(workspace, 'file.txt'), 'A\n');
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const address = model.address() as { port: number };
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await prepareAdminAuthentication(db.databaseUrl);
    const { headers } = await adminHeaders(app);
    const modelId = await provisionStaticTextModel(
      db.databaseUrl,
      `http://127.0.0.1:${address.port}`
    );
    const connection = await mysql.createConnection(db.databaseUrl);
    try {
      await connection.execute(
        'UPDATE mar_agent_models SET code_mode=TRUE,title_generation=FALSE WHERE id=?',
        [modelId]
      );
    } finally {
      await connection.end();
    }
    process.env['HOME'] = home;
    const displayName = `Diff Node ${randomUUID()}`;
    const registration = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers,
      payload: { displayName }
    });
    expect(registration.statusCode, registration.body).toBe(200);
    connector = new NodeConnector({
      configPath: join(root, 'node.json'),
      config: {
        serverUrl: baseUrl,
        allowedRoots: [root],
        dataDirectory: join(root, 'node'),
        registrationToken: registration.json().token
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion: await projectVersion(),
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: false },
        marAgent: { available: true, version: await projectVersion() },
        marAgentRuntimeCredentials: { apiVersion: 1, websocket: true, httpVersions: ['1.1', '2'] }
      }
    });
    await connector.start();
    const nodeId = await waitForConnectedNode(app, headers.cookie, displayName);
    const workspaceId = await createWorkspace(app, headers, nodeId, workspace);
    const start = await app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers,
      payload: {
        nodeId,
        workspaceId,
        runner: 'mar-agent',
        cwd: workspace,
        clientMessageId: randomUUID(),
        content: 'Change A to B.',
        modelId: modelId,
        effort: ''
      }
    });
    expect(start.statusCode, start.body).toBe(201);
    const sessionId = start.json().session.id;
    expect(start.json().session.access).toBe('auto');
    async function pendingApproval(reason: string) {
      let approvalId = '';
      await expect
        .poll(async () => {
          const response = await app.inject({
            url: `/api/agent-sessions/${sessionId}/turns?nodeId=${nodeId}&limit=100`,
            headers
          });
          expect(response.statusCode, response.body).toBe(200);
          const walk = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            const record = value as Record<string, unknown>;
            if (
              record.approvalStatus === 'PENDING' &&
              JSON.stringify(record.approval).includes(reason)
            )
              approvalId = String(record.approvalId);
            else Object.values(record).forEach(walk);
          };
          walk(response.json());
          return approvalId;
        })
        .not.toBe('');
      return approvalId;
    }
    async function decide(approvalId: string, decision: 'APPROVED' | 'REJECTED') {
      const response = await app.inject({
        method: 'POST',
        url: `/api/agent-runs/${start.json().run.id}/approvals/${approvalId}/decision`,
        headers,
        payload: { nodeId, decision }
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const rejectedId = await pendingApproval('Confirm this Code Mode call.');
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('A\n');
    await decide(rejectedId, 'REJECTED');
    const approvedId = await pendingApproval('Confirm this captured change.');
    expect(approvedId).not.toBe(rejectedId);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('A\n');
    await decide(approvedId, 'APPROVED');
    await expectRunReleased(app, headers.cookie, nodeId, start.json().run.id);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('B\n');
    await expect(readFile(join(workspace, 'rejected.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
    async function changes() {
      const response = await app.inject({
        url: `/api/agent-sessions/${sessionId}/turns?nodeId=${nodeId}&limit=100`,
        headers
      });
      expect(response.statusCode, response.body).toBe(200);
      const result: { changeId: string; diff: { status: string; resourceRef: string } }[] = [];
      const walk = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if ('changeId' in value && 'diff' in value) result.push(value as (typeof result)[number]);
        else Object.values(value).forEach(walk);
      };
      walk(response.json());
      return result;
    }
    const first = (await changes())[0]!;
    expect(first.diff.status).toBe('available');
    const readUrl = `/api/agent-sessions/${sessionId}/tool-resources/${first.diff.resourceRef}?nodeId=${nodeId}&workspaceId=${workspaceId}`;
    const read = await app.inject({ url: readUrl, headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().content).toContain('-A\n+B\n');
    const followup = await app.inject({
      method: 'POST',
      url: `/api/agent-sessions/${sessionId}/messages`,
      headers,
      payload: {
        nodeId,
        workspaceId,
        modelId: modelId,
        clientMessageId: randomUUID(),
        content: 'Change B to C.'
      }
    });
    expect(followup.statusCode, followup.body).toBe(202);
    await expectRunReleased(app, headers.cookie, nodeId, followup.json().run.id);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('C\n');
    const history = await changes();
    expect(new Set(history.map((entry) => entry.changeId)).size).toBe(2);
    await rm(join(workspace, 'file.txt'));
    expect((await app.inject({ url: readUrl, headers })).json().content).toBe(read.json().content);
    expect(
      (await app.inject({ url: readUrl.replace(workspaceId, 'wrong-workspace'), headers }))
        .statusCode
    ).not.toBe(200);
  } finally {
    await connector?.stop();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await app.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await dropPlaywrightTestDatabase(db);
  }
});

function sendTools(
  response: ServerResponse,
  responseId: string,
  tools: readonly { id: string; name: string; input: Record<string, unknown> }[]
): void {
  sendEvents(response, [
    { type: 'message_start', message: { id: responseId, usage: { input_tokens: 10 } } },
    ...tools.flatMap((tool, index) => [
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: tool.input
        }
      },
      { type: 'content_block_stop', index }
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 10, output_tokens: 10 }
    },
    { type: 'message_stop' }
  ]);
}

function sendText(response: ServerResponse, responseId: string, text: string): void {
  sendEvents(response, [
    { type: 'message_start', message: { id: responseId, usage: { input_tokens: 10 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text }
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, output_tokens: 5 }
    },
    { type: 'message_stop' }
  ]);
}

function sendEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache'
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function provisionStaticTextModel(databaseUrl: string, baseUrl: string): Promise<string> {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [users] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT id FROM users WHERE username='admin' LIMIT 1"
    );
    const userId = Number(users[0]?.['id']);
    if (!Number.isSafeInteger(userId)) throw new Error('ADMIN_USER_MISSING');
    const id = `tool-diff-flow-${randomUUID()}`;
    const now = Date.now();
    await connection.execute(
      "INSERT INTO mar_agent_models (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,enabled,sort_order,last_test_status,owner_type,owner_user_id,owner_organization_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNVERIFIED',?,?,?,?,?,?)",
      [
        id,
        `Tool diff flow ${id}`,
        `tool diff flow ${id}`,
        'ANTHROPIC_MESSAGES',
        baseUrl,
        JSON.stringify({ type: 'INLINE_API_KEY', value: 'static-text-key' }),
        'coding',
        200_000,
        4_096,
        JSON.stringify(['TEXT']),
        JSON.stringify(['TEXT']),
        JSON.stringify(['medium']),
        'medium',
        true,
        0,
        'PERSONAL',
        userId,
        null,
        userId,
        now,
        now
      ]
    );
    await new ModelSettingsStore().write(
      id,
      'ANTHROPIC_MESSAGES',
      { version: 1, gcEnabled: true },
      connection
    );
    return id;
  } finally {
    await connection.end();
  }
}

async function prepareAdminAuthentication(databaseUrl: string): Promise<void> {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    await connection.execute(
      "UPDATE users SET must_change_password=FALSE WHERE username='admin' AND is_fixed_admin=TRUE"
    );
  } finally {
    await connection.end();
  }
}

async function adminHeaders(app: Awaited<ReturnType<typeof createServerApp>>['app']) {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
  });
  expect(login.statusCode, login.body).toBe(200);
  const body = login.json<{ csrfToken: string; mustChangePassword: boolean }>();
  expect(body.mustChangePassword).toBe(false);
  return {
    headers: {
      cookie: cookie(login.headers['set-cookie']),
      'x-csrf-token': body.csrfToken
    }
  };
}

async function createWorkspace(
  app: Awaited<ReturnType<typeof createServerApp>>['app'],
  headers: Record<string, string>,
  nodeId: string,
  workspacePath: string
): Promise<string> {
  const workspace = await app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers,
    payload: { nodeId, path: workspacePath }
  });
  expect(workspace.statusCode, workspace.body).toBe(201);
  return workspace.json<{ workspace: { id: string } }>().workspace.id;
}

async function waitForConnectedNode(
  app: Awaited<ReturnType<typeof createServerApp>>['app'],
  cookieHeader: string,
  displayName: string
): Promise<string> {
  await expect
    .poll(async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/nodes',
        headers: { cookie: cookieHeader }
      });
      return response
        .json<{ nodes: { id: string; displayName: string | null; connected: boolean }[] }>()
        .nodes.find((node) => node.displayName === displayName);
    })
    .toMatchObject({ connected: true });
  const response = await app.inject({
    method: 'GET',
    url: '/api/nodes',
    headers: { cookie: cookieHeader }
  });
  return (
    response
      .json<{ nodes: { id: string; displayName: string | null }[] }>()
      .nodes.find((node) => node.displayName === displayName)?.id ?? ''
  );
}

async function expectRunReleased(
  app: Awaited<ReturnType<typeof createServerApp>>['app'],
  cookieHeader: string,
  nodeId: string,
  runId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/agent-runs/${runId}?nodeId=${nodeId}`,
          headers: { cookie: cookieHeader }
        });
        return response.json<{ error?: { code?: string } }>().error?.code;
      },
      { timeout: 15_000 }
    )
    .toBe('RUN_NOT_FOUND');
}

async function projectVersion(): Promise<string> {
  const value = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof value.version !== 'string') throw new Error('PROJECT_VERSION_INVALID');
  return value.version;
}

function cookie(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined) throw new Error('SESSION_COOKIE_MISSING');
  return header.split(';', 1)[0]!;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
