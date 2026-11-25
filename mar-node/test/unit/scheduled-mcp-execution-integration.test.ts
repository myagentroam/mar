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
import { SessionScheduleService } from '../../src/session/session-schedule-service.js';
import { dailyTriggers } from './scheduled-task-fixtures.js';

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

function makeBridge(database: NodeDatabase, runtime: NodeRuntimeState, changed = vi.fn()) {
  const service = new SessionScheduleService({
    database: () => database,
    runtime,
    projection: { rename: async () => undefined } as never,
    emitSession: vi.fn(),
    changed
  });
  return new ScheduleMcpBridge(
    async (capability) =>
      runtime.resolveMcpExecution({ ...capability, userId: capability.actorUserId })?.sessionId,
    (scope, tool, payload) => service.invokeMcp(scope, tool, payload)
  );
}

it('reads committed writes after lost IPC replies without replay or capability renewal', async () => {
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
    externalSessionId: 'native-session',
    cwd: home
  });
  database.saveNativeSessionMetadata({
    runner: 'mar-agent',
    externalSessionId: session.id,
    workspaceId: workspace.id
  });
  const store = new ScheduledSessionStore(database.raw);
  const changed = vi.fn();
  const bridge = makeBridge(database, runtime, changed);
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
      arguments: {
        name: 'Daily check',
        objective: 'Created despite lost reply',
        triggers: dailyTriggers('09:00')
      }
    });
    expect(lostCreate.isError).toBe(true);
    expect(scheduleToolText(lostCreate)).toContain('SCHEDULE_IPC_RESPONSE_INVALID');
    expect(changed).toHaveBeenCalledTimes(1);
    const recovered = await createClient.callTool({ name: 'list_scheduled_tasks', arguments: {} });
    const listed = JSON.parse(scheduleToolText(recovered)) as {
      items: { taskId: string; revision: number }[];
    };
    expect(listed.items).toEqual([expect.objectContaining({ name: 'Daily check', revision: 1 })]);
    const { taskId } = listed.items[0]!;
    expect(proxy.responses.some((response) => 'token' in response)).toBe(false);
    expect(proxy.requests.every((request) => request.token === createToken)).toBe(true);

    proxy.dropNextResponse('update_scheduled_task');
    const patch = {
      taskId,
      expectedRevision: 1,
      patch: { objective: 'Updated despite lost reply' }
    };
    const lostUpdate = await createClient.callTool({
      name: 'update_scheduled_task',
      arguments: patch
    });
    expect(lostUpdate.isError).toBe(true);
    expect(scheduleToolText(lostUpdate)).toContain('SCHEDULE_IPC_RESPONSE_INVALID');
    const readback = await createClient.callTool({
      name: 'get_scheduled_task',
      arguments: { taskId }
    });
    expect(JSON.parse(scheduleToolText(readback))).toMatchObject({
      taskId,
      objective: 'Updated despite lost reply',
      revision: 2
    });
    expect(JSON.stringify(readback)).not.toContain(createToken);
    const stale = await createClient.callTool({ name: 'update_scheduled_task', arguments: patch });
    expect(stale.isError).toBe(true);
    expect(scheduleToolText(stale)).toContain('SCHEDULE_REVISION_CONFLICT');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(store.getById(taskId)).toMatchObject({ revision: 2 });

    store.remove(taskId, 2);
    const replacement = store.create({
      sessionId: session.id,
      workspaceId: workspace.id,
      runner: 'mar-agent',
      ownerUserId: 7,
      name: 'Daily check',
      objective: 'Replacement with new ID',
      triggers: dailyTriggers('09:00'),
      timezone: 'UTC'
    });
    expect(replacement.id).not.toBe(taskId);
    for (const [name, args] of [
      ['get_scheduled_task', { taskId }],
      ['update_scheduled_task', patch]
    ] as const) {
      const deleted = await createClient.callTool({ name, arguments: args });
      expect(deleted.isError).toBe(true);
      expect(scheduleToolText(deleted)).toContain('SCHEDULE_NOT_FOUND');
    }
    expect(store.getById(replacement.id)).toMatchObject({
      revision: 1,
      objective: 'Replacement with new ID'
    });
    runtime.revokeExecutionMcps(createExecution.id);
    const released = await createClient.callTool({ name: 'list_scheduled_tasks', arguments: {} });
    expect(released.isError).toBe(true);
    expect(scheduleToolText(released)).toContain('SCHEDULE_CAPABILITY_STALE');
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await proxy?.close();
    await bridge.close();
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
      externalSessionId: 'native-session',
      cwd: home
    });
    database.saveNativeSessionMetadata({
      runner: 'mar-agent',
      externalSessionId: session.id,
      workspaceId: workspace.id
    });
    const server = makeBridge(database, runtime);
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
      const action = `mcp__mar_schedule__${query ? 'list_scheduled_tasks' : 'create_scheduled_task'}`;
      const toolInput = query
        ? {}
        : { name: 'Build check', objective: 'Check the build', triggers: dailyTriggers('09:00') };
      const programmatic = configuration.codeMode;
      const name = programmatic ? 'code_exec' : action;
      const arguments_ = programmatic
        ? { code: `observe.result(await tools.${action}(${JSON.stringify(toolInput)}));` }
        : toolInput;
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
                ? { type: 'custom_tool_call', input: 'code' in arguments_ ? arguments_.code : '' }
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
              list_scheduled_tasks: ['direct', 'programmatic'],
              list_scheduled_task_runs: ['direct', 'programmatic'],
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
      await expect(pools[0]!.call('mcp__mar_schedule__list_scheduled_tasks', {})).rejects.toThrow(
        'SCHEDULE_CAPABILITY_STALE'
      );
      await coordinator.dispatch(session.id);
      const secondExecution = runtime.currentExecutionId(first.run.id)!;
      await bind(starts[1]!);
      expect(
        (await sdkSession.run({ prompt: 'Create a daily scheduled task.' }).result()).status
      ).toBe('completed');
      const tasks = store.list(workspace.id, undefined, 10, session.id).tasks;
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task).toMatchObject({
        objective: 'Check the build',
        triggers: dailyTriggers('09:00'),
        ownerUserId: 7
      });
      const taskId = task.id;
      expect(requests).toHaveLength(4);
      expect(requests[0]!.tools).toEqual(requests[2]!.tools);
      expect(
        (await pools[1]!.call('mcp__mar_schedule__get_scheduled_task', { taskId })).content
      ).toContain('Check the build');
      for (const [index, objective] of ['Updated once', 'Updated twice'].entries()) {
        const result = await pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          taskId,
          expectedRevision: index + 1,
          patch: { objective }
        });
        expect(JSON.parse(result.content)).toEqual({
          taskId,
          revision: index + 2,
          nextRunAt: task.nextRunAt
        });
        expect(store.getById(taskId)).toMatchObject({ objective, revision: index + 2 });
      }

      // Client order does not waive the revision precondition on parallel writes.
      const parallel = await Promise.allSettled([
        pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          taskId,
          expectedRevision: 3,
          patch: { objective: 'Parallel objective' }
        }),
        pools[1]!.call('mcp__mar_schedule__update_scheduled_task', {
          taskId,
          expectedRevision: 3,
          patch: { triggers: dailyTriggers('10:30') }
        })
      ]);
      expect(parallel[0]).toMatchObject({ status: 'fulfilled' });
      expect(parallel[1]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringContaining('SCHEDULE_REVISION_CONFLICT')
        })
      });
      expect(store.getById(taskId)).toMatchObject({
        objective: 'Parallel objective',
        triggers: dailyTriggers('09:00'),
        revision: 4
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
        expect(scheduledTool?.description).toContain('The objective is what to do at each trigger');
        expect(scheduledTool?.description).toContain('system cron');
        if (action === 'create') {
          expect(scheduledTool?.description).toContain('Daily at 10:00 and 20:00');
          expect(scheduledTool?.description).toContain('{"kind":"hourly","minutes":[15,45]}');
          expect(scheduledTool?.description).toContain('Once on a chosen date');
        } else {
          expect(scheduledTool?.description).toContain('triggers replaces the full schedule');
        }
        const metadata = JSON.stringify(scheduledTool);
        expect(metadata).toContain('Instructions to execute at each trigger');
        expect(metadata).toContain('Hourly takes minutes 0–59 instead of time');
        expect(metadata).toContain('Once requires a concrete date');
        expect(metadata).not.toContain('"groups"');
        expect(metadata).not.toContain('verbatim as a user message');
        expect(metadata).not.toContain('starts without');
      }
      if (configuration.codeMode)
        expect(requests[0]!.tools.find((tool) => tool.name === 'code_exec')!.description).toContain(
          'mcp__mar_schedule__get_scheduled_task'
        );
      runtime.revokeExecutionMcps(secondExecution);
      await expect(
        pools[1]!.call('mcp__mar_schedule__get_scheduled_task', { taskId })
      ).rejects.toThrow('SCHEDULE_CAPABILITY_STALE');
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
