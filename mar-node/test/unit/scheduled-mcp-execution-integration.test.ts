import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { LocalAgentHost } from '../../../mar-agent/src/host.js';
import {
  SecretValue,
  createAgent,
  type AgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';
import { MarAgentMcpClientPool } from '../../src/runner/mar-agent/mcp-client-pool.js';
import { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import { ScheduledSessionStore } from '../../src/service/scheduled-session-store.js';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';

interface ScheduleIpcRequest {
  readonly token: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

type ScheduleIpcResponse = Record<string, unknown>;

async function createScheduleResponseProxy(bridgeEndpoint: string, directory: string) {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-schedule-proxy-${randomUUID()}`
      : join(directory, 'schedule-proxy.sock');
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const requests: ScheduleIpcRequest[] = [];
  const responses: ScheduleIpcResponse[] = [];
  let dropNextTool: string | undefined;
  const server = createServer((client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('error', () => undefined);
    const upstream = connect(bridgeEndpoint);
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => client.destroy());
    let requestBody = '';
    let responseBody = '';
    client.setEncoding('utf8');
    upstream.setEncoding('utf8');
    client.on('data', (chunk) => {
      requestBody += chunk;
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      responseBody += chunk;
    });
    upstream.once('end', () => {
      const request = JSON.parse(
        requestBody.slice(0, requestBody.indexOf('\n'))
      ) as ScheduleIpcRequest;
      const response = JSON.parse(
        responseBody.slice(0, responseBody.indexOf('\n'))
      ) as ScheduleIpcResponse;
      requests.push(request);
      responses.push(response);
      if (request.tool === dropNextTool) {
        dropNextTool = undefined;
        client.end();
      } else client.end(responseBody);
    });
    client.once('close', () => upstream.destroy());
  });
  server.listen(endpoint);
  await once(server, 'listening');
  return {
    endpoint,
    requests,
    responses,
    dropNextResponse(tool: string) {
      dropNextTool = tool;
    },
    async close() {
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  };
}

function scheduleToolText(result: unknown): string {
  const content =
    typeof result === 'object' && result !== null && 'content' in result
      ? result.content
      : undefined;
  const block = Array.isArray(content) ? content[0] : undefined;
  if (
    block === undefined ||
    typeof block !== 'object' ||
    block === null ||
    !('text' in block) ||
    typeof block.text !== 'string'
  )
    throw new Error('SCHEDULE_MCP_TEXT_RESULT_EXPECTED');
  return block.text;
}

it('reads committed creates and updates after lost renewals without renewing or replaying the old token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-schedule-lost-renewal-'));
  const database = new NodeDatabase(':memory:', 'schedule-mcp-lost-renewal');
  const workspace = database.saveWorkspace({ path: home, kind: 'DIRECTORY', gitSummary: null });
  const runtime = new NodeRuntimeState(
    () => 'node-test',
    (id) => database.getWorkspace(id)
  );
  const session = runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'mar-agent',
    cwd: home
  });
  database.saveNativeSessionMetadata({
    runner: 'mar-agent',
    externalSessionId: session.id,
    workspaceId: workspace.id
  });
  const store = new ScheduledSessionStore(database.raw);
  const createWrite = vi.spyOn(store, 'create');
  const updateWrite = vi.spyOn(store, 'updateFromAgent');
  const changed = vi.fn();
  const proposed = vi.fn();
  const createTask = vi.fn(
    async (input: {
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly actorUserId: number;
      readonly objective: string;
      readonly cron: string;
    }) =>
      store.create({
        ...input,
        runner: 'mar-agent',
        ownerUserId: input.actorUserId,
        timezone: 'UTC'
      })
  );
  const bridge = new ScheduleMcpBridge(
    () => store,
    changed,
    proposed,
    (capability) =>
      runtime.resolveMcpExecution({ ...capability, userId: capability.actorUserId })?.sessionId,
    createTask
  );
  const clients: Client[] = [];
  let proxy: Awaited<ReturnType<typeof createScheduleResponseProxy>> | undefined;
  const connectClient = async (descriptor: ResolvedMcpServer) => {
    const client = new Client({ name: 'schedule-lost-renewal-fixture', version: '1' });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: descriptor.command!,
        args: [...(descriptor.args ?? [])],
        env: { ...descriptor.environment, MAR_SCHEDULE_MCP_ENDPOINT: proxy!.endpoint }
      })
    );
    return client;
  };

  try {
    const createRun = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'lost-create-response',
      content: 'Create schedule',
      initiatedByUserId: 7
    }).run;
    const createExecution = runtime.createExecution(createRun.id);
    const createServer = await bridge.prepare({
      executionId: createExecution.id,
      sessionId: session.id,
      workspaceId: workspace.id,
      actorUserId: 7
    });
    const bridgeEndpoint = createServer.environment!.MAR_SCHEDULE_MCP_ENDPOINT!;
    proxy = await createScheduleResponseProxy(bridgeEndpoint, home);
    const createToken = createServer.environment!.MAR_SCHEDULE_MCP_TOKEN!;
    const createClient = await connectClient(createServer);

    proxy.dropNextResponse('create_scheduled_task');
    const lostCreate = await createClient.callTool({
      name: 'create_scheduled_task',
      arguments: { objective: 'Created before lost renewal', cron: '0 9 * * *' }
    });
    expect(lostCreate.isError).toBe(true);
    expect(scheduleToolText(lostCreate)).toContain('SCHEDULE_IPC_RESPONSE_INVALID');
    const created = store.get(session.id)!;
    expect(created).toMatchObject({ objective: 'Created before lost renewal', revision: 1 });
    expect(createTask).toHaveBeenCalledOnce();
    expect(createWrite).toHaveBeenCalledOnce();
    expect(proxy.requests.at(-1)!.token).toBe(createToken);
    expect(proxy.responses.at(-1)).toMatchObject({
      result: { id: created.id, revision: 1 },
      token: expect.any(String)
    });
    expect(proxy.responses.at(-1)!.token).not.toBe(createToken);

    const createdRead = await createClient.callTool({ name: 'get_scheduled_task', arguments: {} });
    expect(createdRead.isError).not.toBe(true);
    expect(JSON.parse(scheduleToolText(createdRead))).toMatchObject({
      id: created.id,
      objective: 'Created before lost renewal',
      revision: 1
    });
    expect(proxy.requests.at(-1)!.token).toBe(createToken);
    expect(proxy.responses.at(-1)).not.toHaveProperty('token');
    expect(JSON.stringify(createdRead)).not.toContain('"token"');
    expect(createWrite).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(proposed).not.toHaveBeenCalled();

    const staleCreateWrite = await createClient.callTool({
      name: 'update_scheduled_task',
      arguments: { objective: 'Must stay stale after readback' }
    });
    expect(staleCreateWrite.isError).toBe(true);
    expect(scheduleToolText(staleCreateWrite)).toContain('SCHEDULE_CAPABILITY_STALE');
    expect(updateWrite).not.toHaveBeenCalled();
    expect(store.get(session.id)).toMatchObject({ id: created.id, revision: 1 });
    runtime.revokeExecutionMcps(createExecution.id);
    const releasedRead = await createClient.callTool({
      name: 'get_scheduled_task',
      arguments: {}
    });
    expect(releasedRead.isError).toBe(true);
    expect(scheduleToolText(releasedRead)).toContain('SCHEDULE_CAPABILITY_STALE');

    runtime.finishRun(createRun.id, 'SUCCEEDED');
    const updateRun = runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'lost-update-response',
      content: 'Update schedule',
      initiatedByUserId: 7
    }).run;
    const updateExecution = runtime.createExecution(updateRun.id);
    const updateServer = await bridge.prepare({
      executionId: updateExecution.id,
      sessionId: session.id,
      workspaceId: workspace.id,
      taskId: created.id,
      revision: created.revision,
      actorUserId: 7
    });
    const updateToken = updateServer.environment!.MAR_SCHEDULE_MCP_TOKEN!;
    const updateClient = await connectClient(updateServer);

    proxy.dropNextResponse('update_scheduled_task');
    const lostUpdate = await updateClient.callTool({
      name: 'update_scheduled_task',
      arguments: { objective: 'Updated before lost renewal' }
    });
    expect(lostUpdate.isError).toBe(true);
    expect(scheduleToolText(lostUpdate)).toContain('SCHEDULE_IPC_RESPONSE_INVALID');
    const updated = store.get(session.id)!;
    expect(updated).toMatchObject({
      id: created.id,
      objective: 'Updated before lost renewal',
      revision: 2
    });
    expect(updateWrite).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(session.id);
    expect(proposed).not.toHaveBeenCalled();
    expect(proxy.requests.at(-1)!.token).toBe(updateToken);
    expect(proxy.responses.at(-1)).toMatchObject({
      result: { id: created.id, revision: 2 },
      token: expect.any(String)
    });
    expect(proxy.responses.at(-1)!.token).not.toBe(updateToken);

    const updatedRead = await updateClient.callTool({ name: 'get_scheduled_task', arguments: {} });
    expect(updatedRead.isError).not.toBe(true);
    expect(JSON.parse(scheduleToolText(updatedRead))).toMatchObject({
      id: created.id,
      objective: 'Updated before lost renewal',
      revision: 2
    });
    expect(proxy.requests.at(-1)!.token).toBe(updateToken);
    expect(proxy.responses.at(-1)).not.toHaveProperty('token');
    expect(JSON.stringify(updatedRead)).not.toContain('"token"');
    expect(updateWrite).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();

    const staleUpdate = await updateClient.callTool({
      name: 'update_scheduled_task',
      arguments: { objective: 'Must not replay after readback' }
    });
    expect(staleUpdate.isError).toBe(true);
    expect(scheduleToolText(staleUpdate)).toContain('SCHEDULE_CAPABILITY_STALE');
    expect(store.get(session.id)).toMatchObject({
      id: created.id,
      objective: 'Updated before lost renewal',
      revision: 2
    });
    expect(updateWrite).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();

    store.removeForSession(session.id);
    const replacement = store.create({
      sessionId: session.id,
      workspaceId: workspace.id,
      runner: 'mar-agent',
      ownerUserId: 7,
      objective: 'Replacement with the same revision',
      cron: '0 9 * * *',
      timezone: 'UTC'
    });
    expect(replacement.id).not.toBe(created.id);
    const changedIdentityRead = await updateClient.callTool({
      name: 'get_scheduled_task',
      arguments: {}
    });
    expect(changedIdentityRead.isError).toBe(true);
    expect(scheduleToolText(changedIdentityRead)).toContain('SCHEDULE_CAPABILITY_STALE');
    const changedIdentityWrite = await updateClient.callTool({
      name: 'update_scheduled_task',
      arguments: { objective: 'Must not target a replacement task' }
    });
    expect(changedIdentityWrite.isError).toBe(true);
    expect(scheduleToolText(changedIdentityWrite)).toContain('SCHEDULE_CAPABILITY_STALE');
    expect(store.get(session.id)).toMatchObject({
      id: replacement.id,
      objective: 'Replacement with the same revision',
      revision: 1
    });
    expect(updateWrite).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await proxy?.close();
    await bridge.close();
    createWrite.mockRestore();
    updateWrite.mockRestore();
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(
  [{ protocol: 'OPENAI_RESPONSES' as const }, { protocol: 'ANTHROPIC_MESSAGES' as const }].flatMap(
    (configuration) => [false, true].map((codeMode) => ({ ...configuration, codeMode }))
  )
)(
  'creates a scheduled task after queue handoff with stable tool exposure and revoked old capability: $protocol codeMode=$codeMode',
  async (configuration) => {
    const home = await mkdtemp(join(tmpdir(), 'mar-schedule-handoff-'));
    const database = new NodeDatabase(':memory:', 'schedule-handoff');
    const workspace = database.saveWorkspace({ path: home, kind: 'DIRECTORY', gitSummary: null });
    const store = new ScheduledSessionStore(database.raw);
    const runtime = new NodeRuntimeState(
      () => 'node-test',
      (id) => database.getWorkspace(id)
    );
    const session = runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: home
    });
    database.saveNativeSessionMetadata({
      runner: 'mar-agent',
      externalSessionId: session.id,
      workspaceId: workspace.id
    });
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
          runner: 'mar-agent',
          ownerUserId: input.actorUserId,
          timezone: 'UTC'
        })
    );
    const server = new ScheduleMcpBridge(
      () => store,
      vi.fn(),
      vi.fn(),
      (capability) =>
        runtime.resolveMcpExecution({ ...capability, userId: capability.actorUserId })?.sessionId,
      create
    );
    const starts: Record<string, unknown>[] = [];
    const coordinator = new ContinuousRunCoordinator({
      executionTerminating: () => undefined,
      keepRunActive: () => false,
      runtime,
      emitQueue: vi.fn(),
      emitConversation: vi.fn(),
      clearImages: vi.fn(),
      cleanupAttachments: vi.fn(),
      migrateAssets: vi.fn(),
      emitRun: vi.fn(),
      control: (_operation, payload) => starts.push(payload),
      stopped: () => false,
      markInterrupted: vi.fn(),
      mcps: () => [],
      scheduleMcp: async (input) => {
        const run = runtime.getRun(input.runId);
        if (run?.initiatedByUserId === undefined) return undefined;
        return server.prepare({
          executionId: input.runId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          actorUserId: run.initiatedByUserId
        });
      }
    });
    const host = new LocalAgentHost({ homeDirectory: home, workspace: home });
    const requests: Array<{
      tools: Array<{ name: string; description: string }>;
      toolSetId?: string;
    }> = [];
    const model: AgentModelConfiguration = {
      ...configuration,
      id: 'fake',
      name: 'Fake',
      modelId: 'fake',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture'),
      contextWindowTokens: 100000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      enabled: true,
      titleGeneration: false
    };
    // Exercise public SDK adapters without depending on package-internal test seams.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const round = requests.length;
      const body = JSON.parse(String(init?.body));
      const liteTools = body.input?.find(
        (item: { type?: string }) => item.type === 'additional_tools'
      );
      requests.push({
        tools: body.tools ?? liteTools?.tools,
        ...(liteTools ? { toolSetId: liteTools.id } : {})
      });
      const toolCall = round === 0 || round === 2;
      const query = round === 0;
      const code = query
        ? 'observe.result(await tools.mcp__mar_schedule__get_scheduled_task({}));'
        : 'observe.result(await tools.mcp__mar_schedule__create_scheduled_task({ objective: "Check the build", cron: "0 9 * * *" }));';
      const programmatic = configuration.codeMode;
      const name = programmatic
        ? 'code_exec'
        : `mcp__mar_schedule__${query ? 'get' : 'create'}_scheduled_task`;
      const arguments_ = programmatic
        ? { code }
        : query
          ? {}
          : { objective: 'Check the build', cron: '0 9 * * *' };
      let events: unknown[];
      if (configuration.protocol === 'ANTHROPIC_MESSAGES') {
        events = [
          {
            type: 'message_start',
            message: { id: `message-${round}`, usage: { input_tokens: 1 } }
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: toolCall
              ? { type: 'tool_use', id: `call-${round}`, name, input: {} }
              : { type: 'text', text: '' }
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: toolCall
              ? { type: 'input_json_delta', partial_json: JSON.stringify(arguments_) }
              : { type: 'text_delta', text: 'done' }
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: 1 }
          },
          { type: 'message_stop' }
        ];
      } else {
        const item = toolCall
          ? {
              id: `item-${round}`,
              call_id: `call-${round}`,
              name,
              ...(programmatic
                ? { type: 'custom_tool_call', input: code }
                : { type: 'function_call', arguments: JSON.stringify(arguments_) })
            }
          : {
              id: `item-${round}`,
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'done' }]
            };
        events = [
          { type: 'response.created', response: { id: `response-${round}` } },
          ...(!toolCall
            ? [{ type: 'response.output_text.done', item_id: `item-${round}`, text: 'done' }]
            : []),
          { type: 'response.output_item.done', item },
          {
            type: 'response.completed',
            response: {
              id: `response-${round}`,
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
        ];
      }
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    });
    let agent: Awaited<ReturnType<typeof createAgent>> | undefined;
    const pools: MarAgentMcpClientPool[] = [];
    const prepare = (id: string) =>
      coordinator.prepare(id, {
        runId: id,
        sessionId: session.id,
        workspaceId: workspace.id,
        executionContext: { runner: 'mar-agent' },
        input: 'schedule',
        attachments: [],
        attachmentPaths: [],
        cwd: home,
        externalSessionId: session.id,
        modelId: null,
        effort: null,
        access: null,
        collaborationMode: 'default',
        secretEnvironment: {}
      });
    const bind = async (start: Record<string, unknown>) => {
      const servers = new MarAgentRunner().mcpConfiguration(
        start.mcpInstallations,
        start.secretEnvironment as Record<string, string>,
        start.executionMcpServers as readonly ResolvedMcpServer[]
      ) as readonly ResolvedMcpServer[];
      const pool = await MarAgentMcpClientPool.connect(servers, home);
      pools.push(pool);
      return host.bindExecutionMcp({
        tools: pool.definitions(),
        catalog: () => pool.catalog(),
        call: (call, signal, context) =>
          pool.call(call.name, call.arguments, signal, context?.expectedTool)
      });
    };
    try {
      agent = await createAgent({ mode: 'normal', host, models: [model] });
      const sdkSession = await agent.createSession({ workspace: home, title: 'Queued schedule' });
      const first = coordinator.accept({
        runId: 'first-run',
        sessionId: session.id,
        clientMessageId: 'first',
        content: 'read',
        initiatedByUserId: 7
      });
      prepare(first.run.id);
      await coordinator.dispatch(session.id);
      const firstExecution = runtime.currentExecutionId(first.run.id)!;
      expect(starts[0]).toMatchObject({
        mcpInstallations: [],
        executionMcpServers: [
          {
            name: 'mar_schedule',
            origin: 'BUILTIN',
            lifecycle: 'EXECUTION',
            transport: 'STDIO',
            allowedToolCallers: {
              get_scheduled_task: ['direct', 'programmatic'],
              create_scheduled_task: ['direct', 'programmatic'],
              update_scheduled_task: ['direct', 'programmatic']
            }
          }
        ]
      });
      const firstBinding = await bind(starts[0]!);
      expect((await sdkSession.run({ prompt: 'Read the scheduled task.' }).result()).status).toBe(
        'completed'
      );
      const queued = coordinator.accept({
        runId: 'queued-input',
        sessionId: session.id,
        clientMessageId: 'queued',
        content: 'create',
        initiatedByUserId: 7
      });
      prepare(queued.queueItem!.id);
      runtime.appendRunEvent({
        runId: firstExecution,
        sequence: 1,
        eventType: 'run.completed',
        payload: {},
        status: 'SUCCEEDED'
      });
      runtime.revokeExecutionMcps(firstExecution);
      coordinator.remove(firstExecution);
      host.unbindExecutionMcp(firstBinding);
      await expect(pools[0]!.call('mcp__mar_schedule__get_scheduled_task', {})).rejects.toThrow(
        'SCHEDULE_CAPABILITY_STALE'
      );
      await coordinator.dispatch(session.id);
      const secondExecution = runtime.currentExecutionId(first.run.id)!;
      await bind(starts[1]!);
      expect(
        (await sdkSession.run({ prompt: 'Create a daily scheduled task.' }).result()).status
      ).toBe('completed');
      expect(store.get(session.id)).toMatchObject({
        objective: 'Check the build',
        cron: '0 9 * * *',
        ownerUserId: 7
      });
      expect(create).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(4);
      expect(requests[0]!.tools).toEqual(requests[2]!.tools);

      // The real stdio client must privately renew after create and every owner update.
      expect((await pools[1]!.call('mcp__mar_schedule__get_scheduled_task', {})).content).toContain(
        'Check the build'
      );
      for (const [index, objective] of ['Updated once', 'Updated twice'].entries()) {
        const result = await pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          objective
        });
        expect(result.content).toContain(objective);
        expect(JSON.stringify(result)).not.toContain('"token"');
        expect(store.get(session.id)).toMatchObject({ objective, revision: index + 2 });
      }

      // Concurrent calls from this one client must consume its own renewed scope in order.
      const parallel = await Promise.all([
        pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          objective: 'Parallel objective'
        }),
        pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          cron: '30 10 * * *'
        })
      ]);
      expect(parallel).toHaveLength(2);
      expect(store.get(session.id)).toMatchObject({
        objective: 'Parallel objective',
        cron: '30 10 * * *',
        revision: 5
      });

      expect(
        requests[0]!.tools.some((tool) => tool.name === 'mcp__mar_schedule__create_scheduled_task')
      ).toBe(!configuration.codeMode);
      expect(
        requests[0]!.tools.some((tool) => tool.name === 'mcp__mar_schedule__get_scheduled_task')
      ).toBe(!configuration.codeMode);
      for (const action of ['create', 'update']) {
        const name = `mcp__mar_schedule__${action}_scheduled_task`;
        const scheduledTool = configuration.codeMode
          ? pools[0]!.definitions().find((tool) => tool.name === name)
          : requests[0]!.tools.find((tool) => tool.name === name);
        expect(scheduledTool?.description).toContain('admitted trigger');
        expect(scheduledTool?.description).toContain('system cron');
        const metadata = JSON.stringify(scheduledTool);
        expect(metadata).toContain('Task body for one scheduled run');
        expect(metadata).toContain('Do not phrase it as a request to create or change a schedule');
        expect(metadata).toContain('repeat cron/time-zone settings');
        expect(metadata).toContain('MAR handles scheduling and skipped triggers');
        expect(metadata).not.toContain('verbatim as a user message');
        expect(metadata).not.toContain('starts without');
      }
      if (configuration.codeMode)
        expect(requests[0]!.tools.find((tool) => tool.name === 'code_exec')!.description).toContain(
          'mcp__mar_schedule__get_scheduled_task'
        );
      runtime.revokeExecutionMcps(secondExecution);
      await expect(pools[1]!.call('mcp__mar_schedule__get_scheduled_task', {})).rejects.toThrow(
        'SCHEDULE_CAPABILITY_STALE'
      );
    } finally {
      coordinator.clear();
      await agent?.dispose();
      fetch.mockRestore();
      await Promise.all(pools.map((pool) => pool.close()));
      await server.close();
      database.close();
      await rm(home, { recursive: true, force: true });
    }
  }
);
