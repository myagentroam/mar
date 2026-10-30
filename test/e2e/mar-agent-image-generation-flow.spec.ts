import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

const executeFile = promisify(execFile);
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

for (const provider of ['CODEX', 'BYTED_ARK'] as const) {
  test(`Independent image settings generate images for a static TEXT model through real Server, Node, and MAR Agent ${provider}`, async ({
    browserName
  }) => {
    test.setTimeout(60_000);
    const toolPrefix = provider === 'CODEX' ? 'codex' : 'byted_ark';
    const imageModelId = provider === 'CODEX' ? 'gpt-image-2' : 'doubao-seedream-5.0-lite';
    test.skip(browserName !== 'chromium', 'The cross-module runtime flow is exercised once.');
    const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-image-generation-e2e-'));
    const workspacePath = join(directory, 'workspace');
    const agentHome = join(directory, 'home');
    const previousHome = process.env['HOME'];
    const modelServer = new ImageToolAnthropicServer(toolPrefix);
    const testDatabase = resolvePlaywrightTestDatabase(
      `${requiredEnvironment('MAR_TEST_RUN_ID')}-image-generation`
    );
    await createPlaywrightTestDatabase(testDatabase);
    const app = (
      await createServerApp({
        databaseUrl: testDatabase.databaseUrl,
        dataDirectory: join(directory, 'server-data'),
        secureCookies: false
      })
    ).app;
    const originalFetch = globalThis.fetch;
    const imageRequests: CapturedImageRequest[] = [];
    let connector: NodeConnector | undefined;

    try {
      await Promise.all([
        prepareGitWorkspace(workspacePath),
        mkdir(agentHome, { recursive: true })
      ]);
      const modelBaseUrl = await modelServer.listen();
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      await prepareAdminAuthentication(testDatabase.databaseUrl);
      const admin = await adminHeaders(app);
      const credentialId = `image-credential-${randomUUID()}`;
      await saveCredentialDocument(testDatabase.databaseUrl, credentialId);
      const catalog = [
        {
          id: 'selected',
          name: 'Selected image',
          enabled: true,
          provider,
          config:
            provider === 'CODEX'
              ? { credentialId, modelId: imageModelId }
              : {
                  url: 'https://images.example.test/custom/generate',
                  apiKey: 'ark-test-key',
                  modelId: imageModelId
                }
        }
      ];
      const imageConfiguration = await app.inject({
        method: 'PUT',
        url: '/api/admin/mar-agent/image-generation',
        headers: admin.headers,
        payload: catalog
      });
      expect(imageConfiguration.statusCode, imageConfiguration.body).toBe(200);
      const readBack = await app.inject({
        method: 'GET',
        url: '/api/admin/mar-agent/image-generation',
        headers: admin.headers
      });
      expect(readBack.json().configuration[0]).toMatchObject({
        provider,
        id: 'selected',
        enabled: true
      });
      expect(readBack.json().configuration[0].config).not.toHaveProperty('apiKey');
      const modelId = await provisionStaticTextModel(testDatabase.databaseUrl, modelBaseUrl);

      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === 'string' || input instanceof URL
            ? String(input)
            : input instanceof Request
              ? input.url
              : String(input);
        if (
          ![
            'https://chatgpt.com/backend-api/codex/images/generations',
            'https://chatgpt.com/backend-api/codex/images/edits',
            'https://images.example.test/custom/generate'
          ].includes(url)
        )
          return originalFetch(input, init);
        const headers = new Headers(init?.headers);
        imageRequests.push({
          authorization: headers.get('authorization'),
          accountId: headers.get('chatgpt-account-id'),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>
        });
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      process.env['HOME'] = agentHome;
      const nodeDisplayName = `MAR Agent image generation ${randomUUID()}`;
      const registration = await app.inject({
        method: 'POST',
        url: '/api/node-registration-tokens',
        headers: admin.headers,
        payload: { displayName: nodeDisplayName }
      });
      expect(registration.statusCode, registration.body).toBe(200);
      connector = new NodeConnector({
        configPath: join(directory, 'node.json'),
        config: {
          serverUrl: baseUrl,
          allowedRoots: [directory],
          dataDirectory: join(directory, 'node-data'),
          registrationToken: registration.json<{ token: string }>().token
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
          marAgentRuntimeCredentials: {
            apiVersion: 1,
            websocket: true,
            httpVersions: ['1.1', '2']
          }
        }
      });
      await connector.start();
      const nodeId = await waitForConnectedNode(app, admin.headers.cookie, nodeDisplayName);
      const workspaceId = await createWorkspace(app, admin.headers, nodeId, workspacePath);

      const started = await app.inject({
        method: 'POST',
        url: '/api/agent-sessions/start',
        headers: admin.headers,
        payload: {
          nodeId,
          workspaceId,
          runner: 'mar-agent',
          cwd: workspacePath,
          clientMessageId: 'image-generation-real-flow',
          content: `Load the ${toolPrefix}-imagegen skill, then call ${toolPrefix}_image_gen exactly once to generate a simple blue square on a white background, no text. Do not use other tools. Report the generated path.`,
          modelId: modelId,
          effort: '',
          access: 'full-access'
        }
      });
      expect(started.statusCode, started.body).toBe(201);
      const result = started.json<{ session: { id: string }; run: { id: string } }>();
      await expectRunReleased(app, admin.headers.cookie, nodeId, result.run.id);

      expect(modelServer.sawImageTool()).toBe(true);
      expect(modelServer.toolResult()).toContain('Generated image saved to');
      expect(imageRequests).toHaveLength(1);
      expect(imageRequests[0]?.authorization).toBe(
        provider === 'CODEX' ? 'Bearer image-access-token' : 'Bearer ark-test-key'
      );
      expect(imageRequests[0]?.body.model).toBe(imageModelId);
      const generatedDirectory = join(
        agentHome,
        '.mar',
        'agent',
        'sessions',
        result.session.id,
        'generated_images'
      );
      const generatedFiles = await readdir(generatedDirectory);
      expect(generatedFiles).toHaveLength(1);
      const imagePath = join(generatedDirectory, generatedFiles[0]!);
      const pixels = await readFile(imagePath);
      expect(pixels.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(pixels).toEqual(Buffer.from(PNG_BASE64, 'base64'));

      const edited = await app.inject({
        method: 'POST',
        url: `/api/agent-sessions/${result.session.id}/messages`,
        headers: admin.headers,
        payload: {
          nodeId,
          workspaceId,
          clientMessageId: 'image-edit-flow',
          modelId: modelId,
          content: `Load ${toolPrefix}-imagegen if needed. Use ${toolPrefix}_image_gen once with referenced_image_paths=[${JSON.stringify(imagePath)}] to change the blue square to a red square, preserve white background. Do not use view_image or other tools. Return saved path.`
        }
      });
      expect(edited.statusCode, edited.body).toBe(202);
      await expectRunReleased(app, admin.headers.cookie, nodeId, edited.json().run.id);
      const editedFiles = (await readdir(generatedDirectory)).filter(
        (file) => !generatedFiles.includes(file)
      );
      expect(editedFiles).toHaveLength(1);
      const editedPixels = await readFile(join(generatedDirectory, editedFiles[0]!));
      expect(editedPixels.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(imageRequests).toHaveLength(2);
      expect(imageRequests[1]?.body[provider === 'CODEX' ? 'images' : 'image']).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      await connector?.stop();
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      try {
        await app.close();
      } finally {
        await modelServer.close();
        await rm(directory, { recursive: true, force: true });
        await dropPlaywrightTestDatabase(testDatabase);
      }
    }
  });
}

interface CapturedImageRequest {
  readonly authorization: string | null;
  readonly accountId: string | null;
  readonly body: Record<string, unknown>;
}

interface AnthropicRequest {
  readonly messages?: unknown;
  readonly tools?: unknown;
}

class ImageToolAnthropicServer {
  readonly #server = createServer((request, response) => void this.#handle(request, response));
  #sawImageTool = false;
  #toolResult = '';
  #sequence = 0;
  constructor(private readonly prefix: string) {}

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string')
      throw new Error('FAKE_MODEL_ADDRESS_INVALID');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  sawImageTool(): boolean {
    return this.#sawImageTool;
  }

  toolResult(): string {
    return this.#toolResult;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readRequest(request)) as AnthropicRequest;
      const tools = Array.isArray(body.tools) ? body.tools : [];
      this.#sawImageTool ||= tools.some(
        (tool) =>
          isRecord(tool) &&
          (tool['name'] === `${this.prefix}_image_gen` ||
            (isRecord(tool['function']) && tool['function']['name'] === `${this.prefix}_image_gen`))
      );
      if (toolResult(body.messages, 'load-image-skill') === undefined) {
        sendTools(response, this.#nextId(), [
          {
            id: 'load-image-skill',
            name: 'skill',
            input: { name: `${this.prefix}-imagegen` }
          }
        ]);
        return;
      }
      const reference = JSON.stringify(body.messages).match(
        /referenced_image_paths=\[\\"(.*?)\\"\]/u
      )?.[1];
      const callId = reference ? 'edit-image' : 'generate-image';
      const imageResult = toolResult(body.messages, callId);
      if (imageResult === undefined) {
        sendTools(response, this.#nextId(), [
          {
            id: callId,
            name: `${this.prefix}_image_gen`,
            input: {
              prompt: 'A simple square.',
              ...(reference ? { referenced_image_paths: [reference] } : {})
            }
          }
        ]);
        return;
      }
      this.#toolResult = imageResult;
      sendText(response, this.#nextId(), 'Image generated.');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  #nextId(): string {
    return `image-message-${++this.#sequence}`;
  }
}

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

function toolResult(messages: unknown, toolUseId: string): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (
        isRecord(block) &&
        block['type'] === 'tool_result' &&
        block['tool_use_id'] === toolUseId &&
        typeof block['content'] === 'string'
      )
        return block['content'];
    }
  }
  return undefined;
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function saveCredentialDocument(databaseUrl: string, credentialId: string): Promise<void> {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const now = Date.now();
    await connection.execute(
      `INSERT INTO system_settings (setting_key,setting_value,updated_at)
       VALUES ('mar_agent_credentials',CAST(? AS JSON),?)`,
      [
        JSON.stringify({
          version: 3,
          credentials: [
            {
              id: credentialId,
              name: 'Image generation credential',
              type: 'CODEX_OAUTH',
              ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 },
              status: 'ACTIVE',
              accessToken: 'image-access-token',
              refreshToken: 'image-refresh-token',
              accountId: 'image-account',
              accessTokenExpiresAt: now + 60 * 60 * 1000,
              lastRefreshAt: now,
              lastCheckedAt: now,
              proxy: null,
              revision: 1,
              createdAt: now,
              updatedAt: now
            }
          ]
        }),
        now
      ]
    );
  } finally {
    await connection.end();
  }
}

async function provisionStaticTextModel(databaseUrl: string, baseUrl: string): Promise<string> {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [users] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT id FROM users WHERE username='admin' LIMIT 1"
    );
    const userId = Number(users[0]?.['id']);
    if (!Number.isSafeInteger(userId)) throw new Error('ADMIN_USER_MISSING');
    const id = `image-flow-${randomUUID()}`;
    const now = Date.now();
    await connection.execute(
      "INSERT INTO mar_agent_models (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,input_capabilities,output_capabilities,reasoning_efforts,hosted_web_search,responses_previous_response_id,enabled,sort_order,last_test_status,owner_type,owner_user_id,owner_organization_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNVERIFIED',?,?,?,?,?,?)",
      [
        id,
        `Image flow ${id}`,
        `image flow ${id}`,
        'ANTHROPIC_MESSAGES',
        baseUrl,
        JSON.stringify({ type: 'INLINE_API_KEY', value: 'static-text-key' }),
        'coding',
        200_000,
        4_096,
        JSON.stringify(['TEXT']),
        JSON.stringify(['TEXT']),
        JSON.stringify([]),
        false,
        false,
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

async function prepareGitWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await executeFile('git', ['init', path]);
  await executeFile('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  await executeFile('git', ['-C', path, 'config', 'user.name', 'MyAgentRoam Test']);
  await writeFile(join(path, 'README.md'), 'image generation workspace\n');
  await executeFile('git', ['-C', path, 'add', 'README.md']);
  await executeFile('git', ['-C', path, 'commit', '-m', 'test']);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
