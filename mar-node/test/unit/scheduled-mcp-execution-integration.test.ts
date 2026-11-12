import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
