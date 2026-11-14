import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import { NodeConnector } from '../../../mar-node/src/connector.js';
import { createServerApp } from '../../../ee/server/src/app.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from '../support/playwright-test-database.js';
import { INITIAL_ADMIN_PASSWORD } from '../../../packages/server-core/src/password.js';
import { ModelSettingsStore } from '../../../packages/server-core/src/model-settings.js';

const executeFile = promisify(execFile);

test('MAR Agent restores resources through the real Server and NodeConnector and releases them on Session deletion', async ({
  browserName
}) => {
  test.skip(
    browserName !== 'chromium',
    'Cross-module API coverage only runs in one browser project'
  );
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-mar-agent-warm-e2e-'));
  const workspacePath = join(directory, 'workspace');
  const agentHome = join(directory, 'home');
  const pidPath = join(directory, 'warm-process.pid');
  const previousHome = process.env['HOME'];
  const fakeAnthropic = new FakeAnthropicServer(pidPath);
  const testDatabase = resolvePlaywrightTestDatabase(
    `${requiredEnvironment('MAR_TEST_RUN_ID')}-warm-recovery`
  );
  await createPlaywrightTestDatabase(testDatabase);
  const databaseUrl = testDatabase.databaseUrl;
  const nodeAppVersion = await projectVersion();
  const nodeDisplayName = `MAR Agent warm recovery ${randomUUID()}`;
  const app = (
    await createServerApp({
      databaseUrl,
      dataDirectory: join(directory, 'server-data'),
      secureCookies: false
    })
  ).app;
  let connector: NodeConnector | undefined;
  try {
    await Promise.all([prepareGitWorkspace(workspacePath), mkdir(agentHome, { recursive: true })]);
    const modelBaseUrl = await fakeAnthropic.listen();
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await prepareAdminAuthentication(databaseUrl);
    const admin = await adminHeaders(app);
    const modelId = await provisionModel(databaseUrl, modelBaseUrl);
    fakeAnthropic.modelId = modelId;
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin.headers,
      payload: { displayName: nodeDisplayName }
    });
    expect(token.statusCode, token.body).toBe(200);

    process.env['HOME'] = agentHome;
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseUrl,
        allowedRoots: [directory],
        registrationToken: token.json<{ token: string }>().token
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion,
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: false },
        marAgent: { available: true, version: nodeAppVersion }
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
        clientMessageId: 'mar-agent-warm-start',
        content: 'start warm resources',
        modelId,
        effort: '',
        access: 'full-access'
      }
    });
    expect(started.statusCode, started.body).toBe(201);
    const sessionId = started.json<{ session: { id: string } }>().session.id;
    const firstRunId = started.json<{ run: { id: string } }>().run.id;
    await expectRunReleased(app, admin.headers.cookie, nodeId, firstRunId);
    const firstResources = fakeAnthropic.firstResources();
    expect(firstResources.processId).toMatch(/^p_[0-9a-f]{12}$/u);
    expect(firstResources.agentId).toMatch(/^[0-9a-f-]+$/u);
    await fakeAnthropic.childStarted;
    await expect.poll(() => fakeAnthropic.childTitleResponses).toBeGreaterThan(0);
    const pid = Number(await readFile(pidPath, 'utf8'));
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(processAlive(pid)).toBe(true);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/agent-sessions/${sessionId}/messages`,
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId,
        clientMessageId: 'mar-agent-warm-resume',
        content: 'resume warm resources',
        modelId
      }
    });
    expect(resumed.statusCode, resumed.body).toBe(202);
    const secondRunId = resumed.json<{ run: { id: string } }>().run.id;
    await expectRunReleased(app, admin.headers.cookie, nodeId, secondRunId);

    expect(fakeAnthropic.resumedProcess()).toMatchObject({
      status: 'running',
      processId: firstResources.processId
    });
    expect(fakeAnthropic.resumedTask()).toMatchObject({
      agents: [{ status: 'RUNNING', agentId: firstResources.agentId }]
    });

    const activeRemoval = await app.inject({
      method: 'DELETE',
      url: `/api/agent-sessions/${sessionId}?nodeId=${encodeURIComponent(nodeId)}`,
      headers: admin.headers
    });
    expect(activeRemoval.statusCode, activeRemoval.body).toBe(400);
    expect(activeRemoval.json<{ error: { code: string } }>().error.code).toBe('SESSION_ACTIVE');

    const stopping = await app.inject({
      method: 'POST',
      url: `/api/agent-sessions/${sessionId}/messages`,
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId,
        clientMessageId: 'mar-agent-stop-child',
        content: 'stop warm child',
        modelId
      }
    });
    expect(stopping.statusCode, stopping.body).toBe(202);
    await expectRunReleased(
      app,
      admin.headers.cookie,
      nodeId,
      stopping.json<{ run: { id: string } }>().run.id
    );
    expect(fakeAnthropic.stoppedTaskStatus()).toBe('INTERRUPTED');
    const childRuns = await app.inject({
      method: 'GET',
      url: `/api/agent-sessions/${firstResources.agentId}/runs?nodeId=${nodeId}`,
      headers: admin.headers
    });
    expect(childRuns.statusCode, childRuns.body).toBe(200);
    expect(
      childRuns.json<{ runs: { status: string; interruptionReason?: string }[] }>().runs
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'INTERRUPTED', interruptionReason: 'USER_STOP' })
      ])
    );
    await expect(
      Promise.race([
        fakeAnthropic.childAborted,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Child request was not aborted.')),
            5_000
          );
          timer.unref();
        })
      ])
    ).resolves.toBeUndefined();

    await expect
      .poll(async () => {
        const removed = await app.inject({
          method: 'DELETE',
          url: `/api/agent-sessions/${sessionId}?nodeId=${encodeURIComponent(nodeId)}`,
          headers: admin.headers
        });
        if (removed.statusCode === 200) {
          expect(removed.json()).toEqual({ deleted: true });
          return true;
        }
        expect(removed.json<{ error: { code: string } }>().error.code).toBe('SESSION_ACTIVE');
        return false;
      })
      .toBe(true);
    await expect.poll(() => processAlive(pid), { timeout: 5_000 }).toBe(false);
  } finally {
    connector?.stop();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    try {
      await app.close();
    } finally {
      await fakeAnthropic.close();
      await rm(directory, { recursive: true, force: true });
      await dropPlaywrightTestDatabase(testDatabase);
    }
  }
});

test('MAR Agent Goal continues through the real Server and NodeConnector and completes', async ({
  browserName
}) => {
  test.skip(
    browserName !== 'chromium',
    'Cross-module API coverage only runs in one browser project'
  );
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-mar-agent-goal-e2e-'));
  const workspacePath = join(directory, 'workspace');
  const agentHome = join(directory, 'home');
  const previousHome = process.env['HOME'];
  const fakeAnthropic = new FakeAnthropicServer(join(directory, 'unused.pid'));
  const testDatabase = resolvePlaywrightTestDatabase(
    `${requiredEnvironment('MAR_TEST_RUN_ID')}-goal`
  );
  await createPlaywrightTestDatabase(testDatabase);
  const databaseUrl = testDatabase.databaseUrl;
  const nodeAppVersion = await projectVersion();
  const nodeDisplayName = `MAR Agent goal ${randomUUID()}`;
  const app = (
    await createServerApp({
      databaseUrl,
      dataDirectory: join(directory, 'server-data'),
      secureCookies: false
    })
  ).app;
  let connector: NodeConnector | undefined;
  try {
    await Promise.all([prepareGitWorkspace(workspacePath), mkdir(agentHome, { recursive: true })]);
    const modelBaseUrl = await fakeAnthropic.listen();
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await prepareAdminAuthentication(databaseUrl);
    const admin = await adminHeaders(app);
    const modelId = await provisionModel(databaseUrl, modelBaseUrl);
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin.headers,
      payload: { displayName: nodeDisplayName }
    });
    expect(token.statusCode, token.body).toBe(200);

    process.env['HOME'] = agentHome;
    connector = new NodeConnector({
      configPath: join(directory, 'node.json'),
      config: {
        serverUrl: baseUrl,
        allowedRoots: [directory],
        registrationToken: token.json<{ token: string }>().token
      },
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeAppVersion,
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false },
        openCode: { available: false },
        marAgent: { available: true, version: nodeAppVersion }
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
        clientMessageId: 'mar-agent-goal-session',
        content: 'prepare goal session',
        modelId,
        effort: '',
        access: 'full-access'
      }
    });
    expect(started.statusCode, started.body).toBe(201);
    const sessionId = started.json<{ session: { id: string } }>().session.id;
    await expectRunReleased(
      app,
      admin.headers.cookie,
      nodeId,
      started.json<{ run: { id: string } }>().run.id
    );

    const command = await app.inject({
      method: 'POST',
      url: `/api/agent-sessions/${sessionId}/commands`,
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId,
        modelId,
        commandId: 'goal',
        input: '/goal 完成并验证跨轮任务'
      }
    });
    expect(command.statusCode, command.body).toBe(202);
    const goalRunId = command.json<{ run: { id: string } }>().run.id;

    await expect
      .poll(
        () =>
          fakeAnthropic
            .goalPrompts()
            .some((prompt) => prompt.includes('Continue the active Goal.')),
        { timeout: 15_000 }
      )
      .toBe(true);
    await expectRunReleased(app, admin.headers.cookie, nodeId, goalRunId);
    expect(fakeAnthropic.goalPrompts()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('A Goal has started or changed.'),
        expect.stringContaining('Continue the active Goal.'),
        expect.stringContaining('完成并验证跨轮任务')
      ])
    );

    const idleCommand = await app.inject({
      method: 'POST',
      url: `/api/agent-sessions/${sessionId}/commands`,
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId,
        modelId,
        commandId: 'goal',
        input: '/goal 验证空转自动收口'
      }
    });
    expect(idleCommand.statusCode, idleCommand.body).toBe(202);
    await expectRunReleased(
      app,
      admin.headers.cookie,
      nodeId,
      idleCommand.json<{ run: { id: string } }>().run.id
    );
    expect(
      fakeAnthropic.goalPrompts().filter((prompt) => prompt.includes('验证空转自动收口'))
    ).toHaveLength(3);
    const settled = await app.inject({
      method: 'GET',
      url: `/api/agent-sessions/${sessionId}?nodeId=${encodeURIComponent(nodeId)}`,
      headers: admin.headers
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(
      settled.json<{ session: { commandStates?: Array<{ commandId: string }> } }>().session
        .commandStates ?? []
    ).not.toContainEqual(expect.objectContaining({ commandId: 'goal' }));
  } finally {
    await connector?.stop();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    try {
      await app.close();
    } finally {
      await fakeAnthropic.close();
      await rm(directory, { recursive: true, force: true });
      await dropPlaywrightTestDatabase(testDatabase);
    }
  }
});

class FakeAnthropicServer {
  modelId = '';
  childTitleResponses = 0;
  #stoppedTask?: Record<string, unknown>;
  readonly childStarted: Promise<void>;
  readonly childAborted: Promise<void>;
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response);
  });
  readonly #pidPath: string;
  #resolveChildStarted!: () => void;
  #resolveChildAborted!: () => void;
  #childStarted = false;
  #childAborted = false;
  #firstProcess?: Record<string, unknown>;
  #firstTask?: Record<string, unknown>;
  #polledProcess?: Record<string, unknown>;
  #polledTask?: Record<string, unknown>;
  #resumeSystem = '';
  #goalPrompts: string[] = [];
  #responseSequence = 0;

  constructor(pidPath: string) {
    this.#pidPath = pidPath;
    this.childStarted = new Promise<void>((resolve) => (this.#resolveChildStarted = resolve));
    this.childAborted = new Promise<void>((resolve) => (this.#resolveChildAborted = resolve));
  }

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

  firstResources(): { processId: string; agentId: string } {
    const processId = this.#firstProcess?.['processId'];
    const agentId = this.#firstTask?.['agentId'];
    if (typeof processId !== 'string' || typeof agentId !== 'string')
      throw new Error(
        `WARM_RESOURCE_IDS_MISSING: ${JSON.stringify({ process: this.#firstProcess, task: this.#firstTask })}`
      );
    return { processId, agentId };
  }

  stoppedTaskStatus(): unknown {
    return (this.#stoppedTask?.['agents'] as Array<Record<string, unknown>> | undefined)?.[0]?.[
      'status'
    ];
  }

  resumeSystem(): string {
    return this.#resumeSystem;
  }

  resumedProcess(): Record<string, unknown> | undefined {
    return this.#polledProcess;
  }

  resumedTask(): Record<string, unknown> | undefined {
    return this.#polledTask;
  }

  goalPrompts(): readonly string[] {
    return [...this.#goalPrompts];
  }

  async #handle(
    request: import('node:http').IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readRequest(request)) as AnthropicRequest;
      const system = systemText(body.system);
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        if (userTextIncludes(body.messages, 'Wait until the parent Session is deleted.'))
          this.childTitleResponses++;
        sendText(response, this.#nextResponseId(), 'Warm resources');
        return;
      }
      if (userTextIncludes(body.messages, 'Wait until the parent Session is deleted.')) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        response.write(
          `data: ${JSON.stringify({
            type: 'message_start',
            message: { id: this.#nextResponseId(), usage: { input_tokens: 1 } }
          })}\n\n`
        );
        if (!this.#childStarted) {
          this.#childStarted = true;
          this.#resolveChildStarted();
        }
        response.once('close', () => {
          if (this.#childAborted) return;
          this.#childAborted = true;
          this.#resolveChildAborted();
        });
        return;
      }
      const toolResults = requestToolResults(body.messages);
      const prompt = latestUserText(body.messages);
      if (prompt?.includes('验证空转自动收口')) {
        this.#goalPrompts.push(prompt);
        sendText(response, this.#nextResponseId(), 'No more work to do.');
        return;
      }
      if (prompt?.includes('A Goal has started or changed.')) {
        this.#goalPrompts.push(prompt);
        sendText(response, this.#nextResponseId(), 'Continue the Goal.');
        return;
      }
      if (prompt?.includes('Continue the active Goal.')) {
        this.#goalPrompts.push(prompt);
        if (toolResults.has('goal-complete')) {
          sendText(response, this.#nextResponseId(), 'Goal completed.');
          return;
        }
        sendTools(response, this.#nextResponseId(), [
          {
            id: 'goal-complete',
            name: 'mcp__mar_goal__update_goal',
            input: { status: 'completed' }
          }
        ]);
        return;
      }
      if (prompt === 'start warm resources') {
        if (toolResults.has('warm-exec-start') && toolResults.has('warm-task-start')) {
          this.#firstProcess = parseJsonRecord(toolResults.get('warm-exec-start'));
          this.#firstTask = parseJsonRecord(toolResults.get('warm-task-start'));
          sendText(response, this.#nextResponseId(), 'Resources started.');
          return;
        }
        const script = `require('node:fs').writeFileSync(${JSON.stringify(
          this.#pidPath
        )}, String(process.pid)); setInterval(() => {}, 1000)`;
        sendTools(response, this.#nextResponseId(), [
          {
            id: 'warm-exec-start',
            name: 'exec',
            input: {
              action: 'start',
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
              yieldMs: 100,
              timeoutMs: 20_000
            }
          },
          {
            id: 'warm-task-start',
            name: 'agent_start',
            input: {
              title: 'Hold a warm subagent',
              content: 'Wait until the parent Session is deleted.',
              modelId: this.modelId
            }
          }
        ]);
        return;
      }
      if (prompt === 'resume warm resources') {
        if (toolResults.has('warm-exec-poll') && toolResults.has('warm-task-output')) {
          this.#polledProcess = parseJsonRecord(toolResults.get('warm-exec-poll'));
          this.#polledTask = parseJsonRecord(toolResults.get('warm-task-output'));
          sendText(response, this.#nextResponseId(), 'Resources resumed.');
          return;
        }
        const resources = this.firstResources();
        this.#resumeSystem = system;
        sendTools(response, this.#nextResponseId(), [
          {
            id: 'warm-exec-poll',
            name: 'exec_wait',
            input: { action: 'poll', processId: resources.processId, yieldMs: 0 }
          },
          {
            id: 'warm-task-output',
            name: 'agent_wait',
            input: { agentIds: [resources.agentId], waitMs: 0 }
          }
        ]);
        return;
      }
      if (prompt === 'stop warm child') {
        if (toolResults.has('warm-child-stopped')) {
          this.#stoppedTask = parseJsonRecord(toolResults.get('warm-child-stopped'));
          sendText(response, this.#nextResponseId(), 'Child stopped.');
          return;
        }
        if (toolResults.has('warm-child-stop')) {
          sendTools(response, this.#nextResponseId(), [
            {
              id: 'warm-child-stopped',
              name: 'agent_wait',
              input: {
                agentIds: [this.firstResources().agentId],
                waitFor: 'completion',
                waitMs: 5_000
              }
            }
          ]);
          return;
        }
        sendTools(response, this.#nextResponseId(), [
          {
            id: 'warm-child-stop',
            name: 'agent_stop',
            input: { agentId: this.firstResources().agentId }
          }
        ]);
        return;
      }
      sendText(response, this.#nextResponseId(), 'Unexpected request.');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'FAKE_MODEL_REQUEST_FAILED'
        })
      );
    }
  }

  #nextResponseId(): string {
    return `fake-message-${++this.#responseSequence}`;
  }
}

interface AnthropicRequest {
  readonly system?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
}

function sendTools(
  response: ServerResponse,
  responseId: string,
  tools: readonly { id: string; name: string; input: Record<string, unknown> }[]
): void {
  sendEvents(response, [
    {
      type: 'message_start',
      message: { id: responseId, usage: { input_tokens: 10 } }
    },
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
    {
      type: 'message_start',
      message: { id: responseId, usage: { input_tokens: 10 } }
    },
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

async function readRequest(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function systemText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((item) => (isRecord(item) && typeof item['text'] === 'string' ? [item['text']] : []))
    .join('\n');
}

function latestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message['role'] !== 'user') continue;
    const content = message['content'];
    if (typeof content === 'string') {
      if (!content.startsWith('# Contextual instruction "')) return content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of [...content].reverse())
      if (
        isRecord(block) &&
        block['type'] === 'text' &&
        typeof block['text'] === 'string' &&
        !block['text'].startsWith('# Contextual instruction "')
      )
        return block['text'];
  }
  return undefined;
}

function userTextIncludes(messages: unknown, text: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!isRecord(message) || message['role'] !== 'user') return false;
    const content = message['content'];
    if (typeof content === 'string') return content.includes(text);
    return (
      Array.isArray(content) &&
      content.some(
        (block) =>
          isRecord(block) &&
          block['type'] === 'text' &&
          typeof block['text'] === 'string' &&
          block['text'].includes(text)
      )
    );
  });
}

function requestToolResults(messages: unknown): Map<string, string> {
  const results = new Map<string, string>();
  if (!Array.isArray(messages)) return results;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (
        !isRecord(block) ||
        block['type'] !== 'tool_result' ||
        typeof block['tool_use_id'] !== 'string' ||
        typeof block['content'] !== 'string'
      )
        continue;
      results.set(block['tool_use_id'], block['content']);
    }
  }
  return results;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> {
  const parsed = value === undefined ? undefined : JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('FAKE_MODEL_TOOL_RESULT_INVALID');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function provisionModel(databaseUrl: string, baseUrl: string): Promise<string> {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [users] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT id FROM users WHERE username='admin' LIMIT 1"
    );
    const userId = Number(users[0]?.['id']);
    if (!Number.isSafeInteger(userId)) throw new Error('ADMIN_USER_MISSING');
    const id = `warm-${randomUUID()}`;
    const now = Date.now();
    await connection.execute(
      "INSERT INTO mar_agent_models (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,subagent_model,enabled,sort_order,last_test_status,owner_type,owner_user_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNVERIFIED',?,?,?,?,?)",
      [
        id,
        `Warm ${id}`,
        `warm ${id}`,
        'ANTHROPIC_MESSAGES',
        baseUrl,
        JSON.stringify({ type: 'INLINE_API_KEY', value: 'fake-key' }),
        'coding',
        200_000,
        4_096,
        JSON.stringify(['TEXT']),
        JSON.stringify(['TEXT']),
        JSON.stringify(['medium']),
        'medium',
        true,
        true,
        0,
        'PERSONAL',
        userId,
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

async function prepareGitWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await executeFile('git', ['init', path]);
  await executeFile('git', ['-C', path, 'config', 'user.email', 'test@example.invalid']);
  await executeFile('git', ['-C', path, 'config', 'user.name', 'MyAgentRoam Test']);
  await writeFile(join(path, 'README.md'), 'mar agent warm recovery workspace\n');
  await executeFile('git', ['-C', path, 'add', 'README.md']);
  await executeFile('git', ['-C', path, 'commit', '-m', 'test']);
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

async function waitForConnectedNode(
  app: Awaited<ReturnType<typeof createServerApp>>['app'],
  cookieHeader: string,
  displayName: string
) {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function projectVersion(): Promise<string> {
  const value = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof value.version !== 'string' || value.version.length === 0)
    throw new Error('PROJECT_VERSION_INVALID');
  return value.version;
}

function cookie(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) throw new Error('COOKIE_MISSING');
  return raw.split(';')[0] ?? raw;
}
