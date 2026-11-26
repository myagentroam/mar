import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import * as executionPaths from '../../src/workspace/path-access.js';
import { FakeRunner } from '../../src/fake-runner.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import { AgentNetworkService } from '../../src/orchestration/agent-network/agent-network-service.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import type { GoalRuntime } from '../../src/service/goal-runtime.js';
import { actorForAuthenticatedTerminal } from '../../src/orchestration/agent-network/agent-network-bindings.js';
import {
  agentNetworkExecutionCommand,
  agentNetworkInvoke,
  invokeAgentNetwork
} from '../../src/orchestration/agent-network/agent-network-invoke.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import {
  SESSION_CONTEXT_PROVIDER,
  type ExtensionOperationContext
} from '@myagentroam/agent/extensions';
import { orchestrationExtension } from '../../src/orchestration/orchestration-extension.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent
} from '../../src/orchestration/agent-network/agent-network-observations.js';
import { waitForAgentTargets } from '../../src/orchestration/agent-network/agent-network-wait.js';
import { NodeRequestService } from '../../src/service/node-request-service.js';
import { createEnvelope } from '@myagentroam/protocol';
import { LocalAgentHost } from '../../../mar-agent/dist/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../../mar-agent/dist/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import type { ModelEvent, ModelRequest } from '../../../mar-agent/dist/model/contracts.js';
import { NodeOrchestration } from '../../src/orchestration/node-orchestration.js';
import { WhiteboardService } from '../../src/orchestration/whiteboard/whiteboard-service.js';
import { WhiteboardStore } from '../../src/orchestration/whiteboard/whiteboard-store.js';

describe('Node Agent Network owner integration', () => {
  it('inherits the board through real Node start, Goal and idle-send admission without switching an already active board', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-orchestration-admission-'));
    const database = new NodeDatabase(':memory:', 'orchestration-admission');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }],
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        marAgent: { available: true },
        codex: { available: false },
        claudeCode: { available: false }
      }
    });
    const core = connector as unknown as {
      runtime: NodeRuntimeState;
      orchestration: NodeOrchestration;
      agentNetworkService: AgentNetworkService;
      sessionLifecycleService: import('../../src/session/session-lifecycle-service.js').SessionLifecycleService;
    };
    const model = {
      id: 'fixture',
      name: 'Fixture',
      modelId: 'fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      credential: { type: 'INLINE_API_KEY', value: 'fixture-only' },
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      hostedWebSearch: false,
      titleGeneration: false,
      codeMode: false,
      conversationModel: true,
      subagentModel: true,
      enabled: true,
      sortOrder: 0
    };
    const resources = { marAgentModel: model, marAgentModels: [model] };
    const create = async (clientMessageId: string, content?: string) => {
      const result = await core.sessionLifecycleService.operations()[
        content ? 'session.start' : 'session.create'
      ]!({
        workspaceId: workspace.id,
        cwd: directory,
        runner: 'mar-agent',
        modelId: model.id,
        __requestUserId: 7,
        clientMessageId,
        ...(content === undefined ? {} : { content }),
        ...resources
      });
      return (result as { session: { id: string } }).session.id;
    };
    const actor = (sessionId: string) => ({
      sessionId,
      runId: core.runtime.activeSessionRun(sessionId)!.id,
      requestUserId: 7,
      runnerConfiguration: resources
    });
    const board = core.orchestration.whiteboard;
    const seeBoards = (sessionId: string, boardAgentId?: string) =>
      vi.waitFor(() => {
        const runId = core.runtime.activeSessionRun(sessionId)!.id;
        expect(board.capture(runId, []).views.map(({ snapshot }) => snapshot.boardId)).toEqual(
          boardAgentId ? [sessionId, boardAgentId] : [sessionId]
        );
      });
    try {
      const a = await create('orchestration-root', 'Own the board');
      const other = await create('orchestration-independent', 'Independent work');
      const b = (
        (await core.agentNetworkService.start(actor(a), {
          title: 'First child',
          content: 'Coordinate',
          modelId: model.id,
          goal: { objective: 'Complete the delegated work' }
        })) as { agentId: string }
      ).agentId;
      await seeBoards(b, a);
      const c = (
        (await core.agentNetworkService.start(actor(b), {
          title: 'Grandchild',
          content: 'Continue the work',
          modelId: model.id
        })) as { agentId: string }
      ).agentId;
      await seeBoards(c, a);
      const side = await create('orchestration-side');
      const idleBoard = 'known-idle-mar-session';
      database.saveNativeSessionMetadata({
        runner: 'mar-agent',
        externalSessionId: idleBoard,
        workspaceId: workspace.id
      });
      expect(board.read(actor(a).runId, idleBoard)).toMatchObject({
        boardAgentId: idleBoard,
        entries: []
      });
      await core.agentNetworkService.send(actor(a), { agentId: side, content: 'Join the work' });
      await seeBoards(side, a);
      const goalSide = await create('orchestration-side-goal');
      await core.agentNetworkService.send(actor(a), {
        agentId: goalSide,
        goal: { objective: 'Join with a Goal' }
      });
      await seeBoards(goalSide, a);
      await core.agentNetworkService.send(actor(a), {
        agentId: other,
        content: 'This does not switch boards'
      });
      await seeBoards(other);
      expect(board.join(actor(a).runId, other)).toEqual({ boardAgentId: other, changed: true });
      await seeBoards(a, other);
      await seeBoards(b, a);
    } finally {
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('wakes on edits, appends a clear, and reports detachment only on tool use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-orchestration-whiteboard-'));
    const database = new NodeDatabase(':memory:', 'orchestration-board');
    const storage = new WhiteboardStore(database.raw);
    const runs = new Map(
      ['owner', 'worker', 'other'].map((id) => [
        id,
        { id, sessionId: id, workspaceId: 'workspace', initiatedByUserId: 7 }
      ])
    );
    const board = new WhiteboardService({
      store: () => storage,
      activeRun: (id) => runs.get(id),
      activeOwnerRunId: (id) => runs.get(id)?.id,
      boardInWorkspace: (id, workspaceId) => workspaceId === 'workspace' && runs.has(id)
    });
    const orchestration = new NodeOrchestration(board);
    orchestration.prepareInput('worker', 'initial', { runId: 'owner', hasMessage: true }, true);
    const context = orchestration.context(() => 'worker', { collect: () => [] });
    const edit = (ops: Parameters<typeof board.update>[1]['ops']) =>
      board.update('owner', { expectedBoardId: 'owner', ops });
    edit([{ op: 'add', content: 'INITIAL_SHARED_DECISION' }]);
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture'),
      modelId: 'fixture',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const requests: ModelRequest[] = [];
    const invokeBoard = vi.fn<
      import('../../src/orchestration/whiteboard/whiteboard-tool.js').WhiteboardInvoke
    >((_id, input) => {
      if (input.action === 'read') return { data: board.read('worker', input.boardAgentId) };
      if (input.action === 'join') return { data: board.join('worker', input.boardAgentId) };
      if (input.action === 'leave') return { data: board.leave('worker') };
      const { entryChanges, ...data } = board.update('worker', {
        expectedBoardId: input.boardAgentId,
        ops: input.ops
      });
      return { data, entryChanges };
    });
    const blocks = (request: ModelRequest) =>
      request.messages.filter((m) => m.contextualBlock?.id === 'request:mar.node.whiteboard');
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration],
        extensions: [
          {
            id: 'orchestration-board-test',
            apiVersion: '1.0',
            attachSession(session) {
              session.services.provide(SESSION_CONTEXT_PROVIDER, { collect: () => [], ...context });
            }
          },
          orchestrationExtension(vi.fn(), () => 'worker', invokeBoard)
        ]
      },
      () => ({
        configuration,
        async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
          requests.push(request);
          const round = requests.length;
          if (round === 1)
            for (const [callId, args] of [
              ['invalid-board-read', { action: 'read', entryId: 'w1' }],
              ['padded-board-read', { action: 'read', boardAgentId: null, ops: null }]
            ] as const)
              yield { type: 'client_tool.call', callId, name: 'whiteboard', arguments: args };
          if (round === 5) {
            yield {
              type: 'client_tool.call',
              callId: 'edit-after-detach',
              name: 'whiteboard',
              arguments: {
                action: 'update',
                boardAgentId: 'owner',
                ops: [{ op: 'add', content: 'must not write' }]
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          if (round >= 7 && round <= 9) {
            const action = round === 7 ? 'read' : round === 8 ? 'join' : 'leave';
            yield {
              type: 'client_tool.call',
              callId: `${action}-other`,
              name: 'whiteboard',
              arguments: action === 'leave' ? { action } : { action, boardAgentId: 'other' }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          if (round < 3) {
            yield {
              type: 'client_tool.call',
              callId: `sleep-${round}`,
              name: 'sleep',
              arguments: { durationMs: 300000 }
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: directory });
      const execution = session.run({ prompt: 'Coordinate the work', clientMessageId: 'initial' });
      const wakeReasons = [];
      const boardErrors = [];
      const boardEventData = [];
      for await (const event of execution) {
        if (event.type === 'sleep.started' && event.callId === 'sleep-1')
          edit([
            { op: 'update', id: 'w1', expectedRevision: 1, content: 'REVISED_SHARED_DECISION' }
          ]);
        if (event.type === 'sleep.started' && event.callId === 'sleep-2')
          edit([{ op: 'clear', expectedBoardRevision: 2 }]);
        if (event.type === 'tool.completed' && event.toolName === 'sleep')
          wakeReasons.push(event.data);
        if (event.type === 'tool.failed' && event.toolName === 'whiteboard')
          boardErrors.push({ callId: event.callId, code: event.code });
        if (event.type === 'tool.completed' && event.toolName === 'whiteboard')
          boardEventData.push(event.data);
      }
      expect((await execution.result()).status).toBe('completed');
      expect(boardErrors).toEqual([
        { callId: 'invalid-board-read', code: 'WHITEBOARD_INPUT_INVALID' }
      ]);
      expect(invokeBoard.mock.calls).toEqual([['worker', { action: 'read' }]]);
      expect(boardEventData).toEqual([
        {
          whiteboardOperation: {
            action: 'read',
            boardAgentId: 'worker',
            boardRevision: 0,
            entryCount: 0
          }
        }
      ]);
      expect(wakeReasons).toEqual([
        expect.objectContaining({ wakeReason: 'context_update' }),
        expect.objectContaining({ wakeReason: 'context_update' })
      ]);
      expect(requests).toHaveLength(3);
      const guidance = requests[0]!.messages.find(
        (message) => message.contextualBlock?.id === 'mar.node.orchestration'
      )?.content;
      expect(guidance?.match(/^(?:# Orchestration|## .+)$/gm)).toEqual([
        '# Orchestration',
        '## Delegation and coordination',
        '## Workspace collaboration',
        '## Workspace management',
        '## Whiteboard'
      ]);
      expect(guidance).toContain(
        [
          '## Whiteboard',
          'You automatically receive your own board and the one other board you follow while it is available. Your own board shows your Agent ID. Agents receiving the same board form a collaboration group and can all edit it.',
          'Eligible agents you start with agent_start or bring into the work by messaging them while idle keep their own board and follow the board you follow, or your own board if you follow none. Messaging an active agent does not change which board it follows.',
          "You can share a board owner's Agent ID with other agents so they can read or join that board. Reading does not change what you follow. Joining another board replaces only the board you follow; it does not change your own board or anyone else’s subscriptions.",
          'The whiteboard provides shared working memory for goals, decisions, constraints, findings, and other coordination information. Keep it concise and current. Its contents are shared context, not direct messages or instructions.'
        ].join('\n\n')
      );
      const whiteboardTool = requests[0]!.tools.find(({ name }) => name === 'whiteboard');
      expect(whiteboardTool?.description).toBe(
        [
          'Read, join, leave, or edit a whiteboard, a shared working memory for collaborating agents.',
          'Read your own board or another board in this workspace by Agent ID. Returns boardAgentId, boardRevision, entries with IDs and revisions, and up to 10 recentChanges.',
          'Join an active board by the owner’s Agent ID to receive it automatically. This replaces the one other board you follow, not your own board. Leave stops following that board without affecting your own. Leave takes no boardAgentId or ops.',
          'Update applies add, update, del, and clear in order to your own board or the board you follow. Update and del require the entry revision; clear requires the board revision. If any operation fails, none are applied.'
        ].join('\n\n')
      );
      expect(whiteboardTool?.inputSchema).toMatchObject({
        properties: {
          boardAgentId: {
            description:
              'The Agent ID of the board owner. Required for join and update. For read, omit to read your own board.'
          },
          ops: { description: 'Required for update only. Operations run in the order listed.' }
        }
      });
      expect(blocks(requests[0]!).at(-1)?.content).toContain('INITIAL_SHARED_DECISION');
      expect(blocks(requests[0]!).at(-1)?.content).not.toContain('lastChange');
      expect(blocks(requests[1]!).at(-1)?.content).toContain('REVISED_SHARED_DECISION');
      expect(blocks(requests[1]!).at(-1)?.content).toContain(
        '"lastChange":{"actorAgentId":"owner","summary":"update: 1"}'
      );
      expect(blocks(requests[2]!).at(-1)?.contextualBlock).toMatchObject({
        authority: 'context',
        operation: 'replace'
      });
      expect(blocks(requests[2]!).at(-1)?.content).toContain(
        '"entries":[],"lastChange":{"actorAgentId":"owner","summary":"clear: 1"}'
      );
      expect(blocks(requests[1]!).at(-1)?.content).not.toContain('recentChanges');

      edit([{ op: 'add', content: 'SHARED_BEFORE_DETACH' }]);
      expect((await session.run({ prompt: 'Continue while shared' }).result()).status).toBe(
        'completed'
      );
      const lastSharedRequest = requests[3]!;
      expect(blocks(lastSharedRequest).at(-1)?.content).toContain('SHARED_BEFORE_DETACH');
      const wakeOnDetach = vi.fn();
      const unsubscribe = context.wake!.subscribe(wakeOnDetach);
      runs.delete('owner');
      orchestration.release('owner', 'workspace');
      unsubscribe();
      expect(board.isDetached('worker')).toBe(true);
      expect(context.wake!.pending()).toBe(false);
      expect(wakeOnDetach).not.toHaveBeenCalled();
      expect(requests).toHaveLength(4);
      board.update('worker', {
        expectedBoardId: 'worker',
        ops: [{ op: 'add', content: 'OWN_AFTER_DETACH' }]
      });
      expect((await session.run({ prompt: 'Continue independently' }).result()).status).toBe(
        'completed'
      );
      expect(requests).toHaveLength(6);
      for (const request of requests.slice(4))
        expect(blocks(request)).toEqual(blocks(lastSharedRequest));
      const own = (request: ModelRequest) =>
        request.messages.filter(
          ({ contextualBlock }) => contextualBlock?.id === 'request:mar.node.whiteboard.own'
        );
      expect(own(requests[0]!).at(-1)?.content).toContain('your Agent ID: "worker"');
      expect(own(requests[4]!).at(-1)?.content).toContain('OWN_AFTER_DETACH');
      expect(
        requests[5]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'edit-after-detach'
        )
      ).toMatchObject({
        isError: true,
        content: expect.stringContaining('ask its owner to send you a new agent_send message')
      });

      expect(
        (await session.run({ prompt: 'Read, join, then stop following another board' }).result())
          .status
      ).toBe('completed');
      expect(requests).toHaveLength(10);
      expect(blocks(requests[7]!)).toEqual(blocks(lastSharedRequest));
      const joined = blocks(requests[8]!).at(-1);
      expect(joined?.contextualBlock?.operation).toBe('replace');
      expect(joined?.content).toContain('{"boardAgentId":"other","boardRevision":0,"entries":[]}');
      expect(own(requests[8]!)).toEqual(own(requests[4]!));
      expect(blocks(requests[9]!)).toEqual(blocks(requests[8]!));
      expect(own(requests[9]!)).toEqual(own(requests[8]!));
      expect(board.capture('worker', []).views.map(({ role }) => role)).toEqual(['own']);
      expect(
        requests[9]!.messages.find(
          (message) => message.callId === 'leave-other' && message.role === 'tool'
        )
      ).toMatchObject({
        isError: false,
        content: expect.stringContaining('"changed":true')
      });
      expect(
        requests[7]!.messages.find(
          (message) => message.callId === 'read-other' && message.role === 'tool'
        )
      ).toMatchObject({
        isError: false,
        content: expect.stringContaining('"boardAgentId":"other"')
      });

      for (let index = 1; index < requests.length; index++) {
        const prior = requests[index - 1]!;
        const current = requests[index]!;
        expect(current.messages.slice(0, prior.messages.length)).toEqual(prior.messages);
        expect(current.system).toEqual(prior.system);
        expect(current.tools).toEqual(prior.tools);
      }
    } finally {
      await agent.dispose();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'allows parallel reads while publishing resolved wait titles and replaying history (nested=%s)',
    async (nested) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-network-wait-titles-'));
      await writeFile(join(directory, 'input.txt'), 'NETWORK_PARALLEL_READ_OK\n');
      const network = new AgentNetworkObservations();
      const observer = network.attach('parent');
      const children = ['a', 'b'].map(
        (id, index) =>
          ({
            id,
            parentSessionId: 'parent',
            customTitle: index ? null : 'First task',
            runnerTitle: index ? 'Second task' : null,
            createdAt: index
          }) as NodeAgentSession
      );
      let completed = false;
      const service = new AgentNetworkService({
        observations: network,
        target: async (_actor, id) => children.find((session) => session.id === id)!,
        authorize: async () => {},
        validateSend: async () => {},
        observe: () => {},
        freezeExecution: (session) => ({
          agentId: session.id,
          runId: `run-${session.id}`,
          executionId: `exec-${session.id}`,
          read: () => ({ status: completed && session.id === 'a' ? 'SUCCEEDED' : 'RUNNING' })
        })
      } satisfies Partial<
        ConstructorParameters<typeof AgentNetworkService>[0]
      > as unknown as ConstructorParameters<typeof AgentNetworkService>[0]);
      const configuration: AgentModelConfiguration = {
        id: 'fixture',
        name: 'Fixture',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('fixture-secret'),
        modelId: 'fixture',
        contextWindowTokens: 200000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: nested,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      let requests = 0;
      const agent = await createAgentWithAdapter(
        {
          mode: 'node',
          host: new LocalAgentHost({
            mode: 'node',
            homeDirectory: directory,
            workspace: directory
          }),
          models: [configuration],
          extensions: [
            orchestrationExtension(
              (_execution, action, input, context, onResolved) =>
                invokeAgentNetwork(
                  service,
                  { sessionId: 'parent' },
                  action,
                  input,
                  context,
                  undefined,
                  onResolved
                ),
              () => 'execution'
            )
          ]
        },
        () => ({
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            if (requests++ === 0) {
              const input = { agentIds: ['a', 'b'], mode: 'any', waitMs: 30000 };
              yield {
                type: 'client_tool.call',
                callId: 'wait-call',
                name: nested ? 'code_exec' : 'agent_wait',
                arguments: nested
                  ? {
                      code: `await Promise.all([tools.agent_wait(${JSON.stringify(input)}), tools.read({reads:[{path:"input.txt"}]})]);`
                    }
                  : input
              };
              if (!nested)
                yield {
                  type: 'client_tool.call',
                  callId: 'read-call',
                  name: 'read',
                  arguments: { reads: [{ path: 'input.txt' }] }
                };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield { type: 'text.completed', itemId: 'answer', text: 'done' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace: directory });
        const run = session.run({ prompt: 'wait for both' });
        const normalizer = new MarAgentConversationNormalizer();
        const targets = [
          expect.objectContaining({ agentId: 'a', sessionId: 'a', title: 'First task' }),
          expect.objectContaining({ agentId: 'b', sessionId: 'b', title: 'Second task' })
        ];
        const completedTargets = [
          expect.objectContaining({
            agentId: 'a',
            sessionId: 'a',
            title: 'First task',
            status: 'SUCCEEDED'
          }),
          expect.objectContaining({
            agentId: 'b',
            sessionId: 'b',
            title: 'Second task',
            status: 'RUNNING'
          })
        ];
        let running = false;
        let finished = false;
        let readCompleted = false;
        for await (const event of run) {
          const items = normalizer.normalize(event);
          if (event.type === 'tool.updated' && event.toolName === 'agent_wait') {
            running = true;
            expect(completed).toBe(false);
            expect(items[0]).toMatchObject({
              status: 'IN_PROGRESS',
              payload: { agentOperation: { targets } }
            });
            const history = await agent.sessionHistory(session.id);
            const projected = projectMarAgentHistory(
              {
                id: session.id,
                modelId: null,
                effort: null,
                access: null
              } as unknown as NodeAgentSession,
              history.entries
            );
            expect(projected.flatMap((turn) => turn.items)).toContainEqual(
              expect.objectContaining({
                status: 'IN_PROGRESS',
                payload: expect.objectContaining({
                  agentOperation: expect.objectContaining({ targets })
                })
              })
            );
          }
          if (event.type === 'tool.completed' && event.toolName === 'read') {
            expect(completed).toBe(false);
            readCompleted = true;
          }
          if (running && readCompleted && !completed) {
            completed = true;
            network.publishChild({
              parentId: 'parent',
              childId: 'a',
              runId: 'run-a',
              executionId: 'exec-a',
              kind: 'terminal',
              value: 'SUCCEEDED'
            });
          }
          if (event.type === 'tool.completed' && event.toolName === 'agent_wait') {
            finished = true;
            expect(items[0]).toMatchObject({
              status: 'COMPLETED',
              payload: {
                agentOperation: {
                  targets: completedTargets,
                  detail: { wait: { mode: 'any', waitFor: 'completion', waitMs: 30000 } }
                }
              }
            });
          }
        }
        expect({ running, finished, readCompleted }).toEqual({
          running: true,
          finished: true,
          readCompleted: true
        });
        expect(await run.result()).toMatchObject({ status: 'completed' });
        const history = await agent.sessionHistory(session.id);
        const projected = projectMarAgentHistory(
          {
            id: session.id,
            modelId: null,
            effort: null,
            access: null
          } as unknown as NodeAgentSession,
          history.entries
        );
        expect(projected.flatMap((turn) => turn.items)).toContainEqual(
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              agentOperation: expect.objectContaining({ targets: completedTargets })
            })
          })
        );
      } finally {
        observer.close();
        await agent.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it.each(['send', 'wait'] as const)(
    'repairs automatic direct-child observations through %s but never for non-children',
    async (operation) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-network-parent-observation-'));
      const database = new NodeDatabase(':memory:', 'network-parent-observation');
      const workspace = database.saveWorkspace({
        path: directory,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        fakeRunner: new FakeRunner(),
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true, version: 'codex-cli 0.147.0' },
          claudeCode: { available: false }
        }
      });
      const core = connector as unknown as {
        runtime: NodeRuntimeState;
        agentNetworkService: AgentNetworkService;
        agentNetworkObservations: AgentNetworkObservations;
      };
      const create = (id: string, parentSessionId?: string) => {
        const session = core.runtime.createAgentSession({
          workspaceId: workspace.id,
          runner: 'codex',
          cwd: directory,
          externalSessionId: id,
          modelId: 'gpt-5.3-codex',
          effort: 'medium',
          nativeControl: 'MAR_MANAGED',
          ...(parentSessionId ? { parentSessionId } : {})
        });
        const run = core.runtime.createMessageRun({
          sessionId: session.id,
          clientMessageId: id,
          content: 'work',
          initiatedByUserId: 7
        }).run;
        const execution = core.runtime.createExecution(run.id);
        core.runtime.transitionRun(run.id, 'RUNNING');
        return { session, run, execution };
      };
      try {
        const parent = create('parent');
        const child = create('child', parent.session.id);
        const unrelated = create('unrelated');
        const actor = {
          sessionId: parent.session.id,
          runId: parent.run.id,
          executionId: parent.execution.id,
          requestUserId: 7
        };
        const act = (agentId: string) =>
          operation === 'send'
            ? core.agentNetworkService.send(actor, { agentId, goal: { clear: true } })
            : core.agentNetworkService.wait(actor, { agentId, waitMs: 0 });
        expect(core.agentNetworkObservations.get(parent.session.id)).toBeUndefined();
        await act(child.session.id);
        const observations = core.agentNetworkObservations.get(parent.session.id);
        expect(observations).toBeDefined();
        core.agentNetworkObservations.publishChild({
          parentId: parent.session.id,
          childId: child.session.id,
          runId: child.run.id,
          executionId: child.execution.id,
          kind: 'message',
          value: 'child update after repair'
        });
        expect((await observations!.collect(new AbortController().signal))[0]?.content).toContain(
          'child update after repair'
        );
        observations!.close();
        await act(unrelated.session.id);
        expect(core.agentNetworkObservations.get(parent.session.id)).toBeUndefined();
      } finally {
        await connector.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('admits an escaped Node observation through the real Core context provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-context-budget-'));
    const network = new AgentNetworkObservations();
    const observer = network.attach('parent');
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture'),
      modelId: 'fixture',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const requests: ModelRequest[] = [];
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration],
        extensions: [
          {
            id: 'network-observer-test',
            apiVersion: '1.0',
            attachSession(context) {
              context.services.provide(SESSION_CONTEXT_PROVIDER, observer);
            }
          }
        ]
      },
      () => ({
        configuration,
        async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
          requests.push(request);
          yield { type: 'text.completed', itemId: 'answer', text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: directory });
      const identity = {
        parentId: 'parent',
        childId: 'child',
        runId: 'run',
        executionId: 'execution'
      };
      network.publish({ ...identity, kind: 'message', value: 'Blocker: choose A or B' });
      network.publish({ ...identity, kind: 'message', value: 'Waiting for guidance' });
      network.publish({
        ...identity,
        kind: 'message',
        value: '<'.repeat(8192),
        final: true,
        turnId: 'turn'
      });
      network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
      expect((await session.run({ prompt: 'continue' }).result()).status).toBe('completed');
      const update = requests[0]!.messages.find((message) =>
        message.content.includes('<mar_subagent_update>')
      );
      expect(update).toBeDefined();
      expect(Buffer.byteLength(update!.content)).toBeLessThanOrEqual(32768);
      expect(update!.content).toContain('"summaryTruncated":true');
      expect(update!.content).toContain('Blocker: choose A or B');
      expect(update!.content).toContain('Waiting for guidance');
      expect(observer.capture('child')).toBeUndefined();
    } finally {
      observer.close();
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('projects real MAR final text and apply_patch changes through the Node wait owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-result-'));
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture-secret'),
      modelId: 'fixture',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    let requests = 0;
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration]
      },
      () => ({
        configuration,
        async *start(): AsyncIterable<ModelEvent> {
          if (requests++ === 0) {
            yield {
              type: 'client_tool.call',
              callId: 'patch',
              name: 'apply_patch',
              arguments: {
                input: '*** Begin Patch\n*** Add File: changed.txt\n+content\n*** End Patch'
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'Finished child work.' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: directory });
      const execution = session.run({ prompt: 'make a file' });
      const normalizer = new MarAgentConversationNormalizer();
      const network = new AgentNetworkObservations();
      const parent = network.attach('parent');
      const identity = {
        parentId: 'parent',
        childId: session.id,
        runId: 'run',
        executionId: 'execution'
      };
      for await (const event of execution)
        for (const item of normalizer.normalize(event)) {
          const observation = agentObservationFromRunEvent({
            eventType: 'conversation.item',
            payload: item,
            terminalStatus: undefined
          });
          if (observation) network.publish({ ...identity, ...observation });
        }
      expect(await execution.result()).toMatchObject({ status: 'completed' });
      network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
      const result = await waitForAgentTargets({
        targets: [
          {
            agentId: session.id,
            runId: 'run',
            executionId: 'execution',
            read: () => ({ status: 'SUCCEEDED' })
          }
        ],
        observations: parent,
        waitMs: 1,
        single: true
      });
      expect(result).toMatchObject({
        status: 'SUCCEEDED',
        summary: 'Finished child work.',
        changedFiles: [expect.stringContaining('changed.txt')]
      });
      expect(await readFile(join(directory, 'changed.txt'), 'utf8')).toBe('content\n');
      parent.close();
    } finally {
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      action: 'start' as const,
      nested: false,
      operation: 'START',
      input: {
        title: 'Text task',
        content: 'Review the task details',
        goal: { objective: 'Finish the task' }
      }
    },
    {
      action: 'start' as const,
      nested: true,
      input: {
        title: 'Nested text task',
        content: 'Review the nested task details',
        goal: { objective: 'Finish the nested task' }
      }
    },
    {
      action: 'send' as const,
      nested: false,
      operation: 'MESSAGE',
      input: { agentId: 'child', approval: { approvalId: 'approval-1', decision: 'approve' } }
    },
    {
      action: 'stop' as const,
      nested: false,
      operation: 'CANCEL',
      input: { agentId: 'child' }
    },
    {
      action: 'send' as const,
      nested: true,
      input: { agentId: 'child', delivery: 'STEER', content: 'Review now' }
    }
  ])(
    'preserves SDK $action input (nested=$nested) while keeping private results out of public history',
    async ({ action, input, nested }) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-network-public-event-'));
      const configuration: AgentModelConfiguration = {
        id: 'fixture',
        name: 'Fixture',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('fixture-secret'),
        modelId: 'fixture',
        contextWindowTokens: 200000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: nested,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      let requests = 0;
      const invoke = vi.fn(async () => ({ agentId: 'child', privateField: 'secret-result' }));
      const agent = await createAgentWithAdapter(
        {
          mode: 'node',
          host: new LocalAgentHost({
            mode: 'node',
            homeDirectory: directory,
            workspace: directory
          }),
          models: [configuration],
          extensions: [orchestrationExtension(invoke, () => 'execution')]
        },
        () => ({
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            if (requests++ === 0) {
              yield {
                type: 'client_tool.call',
                callId: 'call',
                name: nested ? 'code_exec' : `agent_${action}`,
                arguments: nested ? `await tools.agent_${action}(${JSON.stringify(input)});` : input
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield { type: 'text.completed', itemId: 'answer', text: 'done' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace: directory });
        const run = session.run({ prompt: 'test public projection' });
        const normalizer = new MarAgentConversationNormalizer();
        const events = [];
        const items = [];
        for await (const event of run) {
          events.push(event);
          items.push(...normalizer.normalize(event));
        }
        expect(await run.result()).toMatchObject({ status: 'completed' });
        expect(invoke).toHaveBeenCalledWith(
          'execution',
          action,
          'delivery' in input
            ? { agentId: input.agentId, content: input.content, deliveryIntent: 'REPLACE_CURRENT' }
            : input,
          expect.anything(),
          expect.any(Function)
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.started',
            toolName: `agent_${action}`,
            input
          })
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            toolName: `agent_${action}`,
            data: expect.objectContaining({
              agentOperation: expect.objectContaining({
                action: action.toUpperCase(),
                ...('title' in input && 'content' in input
                  ? { detail: { title: input.title, message: input.content } }
                  : 'content' in input
                    ? { detail: { message: input.content } }
                    : {}),
                targets: [
                  expect.objectContaining({
                    agentId: 'child',
                    sessionId: 'child',
                    ...('title' in input ? { title: input.title } : {})
                  })
                ]
              })
            }),
            summary: '{}'
          })
        );
        expect(items).toContainEqual(
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              inputSummary: JSON.stringify(input),
              agentOperation: expect.objectContaining({
                action: action.toUpperCase(),
                targets: [expect.objectContaining({ agentId: 'child', sessionId: 'child' })]
              })
            })
          })
        );
        expect(
          items.filter((item) => item.status === 'COMPLETED' && item.payload.agentOperation)
        ).toHaveLength(1);
        expect(items).toContainEqual(
          expect.objectContaining({
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: expect.objectContaining({ text: 'done', phase: 'final_answer' })
          })
        );
        const network = new AgentNetworkObservations();
        const parent = network.attach('parent');
        const identity = {
          parentId: 'parent',
          childId: session.id,
          runId: 'run',
          executionId: 'execution'
        };
        for (const item of items) {
          const observation = agentObservationFromRunEvent({
            eventType: 'conversation.item',
            payload: item,
            terminalStatus: undefined
          });
          if (observation) network.publish({ ...identity, ...observation });
        }
        network.publish({ ...identity, kind: 'terminal', value: 'SUCCEEDED' });
        expect(parent.capture(session.id)?.result).toMatchObject({ summary: 'done' });
        parent.close();
        const history = await agent.sessionHistory(session.id);
        const projected = projectMarAgentHistory(
          {
            id: session.id,
            modelId: null,
            effort: null,
            access: null
          } as unknown as NodeAgentSession,
          history.entries
        );
        expect(projected.flatMap((turn) => turn.items)).toContainEqual(
          expect.objectContaining({
            kind: 'tool_call',
            status: 'COMPLETED',
            payload: expect.objectContaining({
              toolName: `agent_${action}`,
              inputSummary: JSON.stringify(input)
            })
          })
        );
        expect(JSON.stringify({ events, items, history, projected })).not.toMatch(
          /secret-result|fixture-secret/
        );
      } finally {
        await agent.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('retains rejected tool input without invoking Node or exposing private configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-invalid-event-'));
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture-secret'),
      modelId: 'fixture',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const input = {
      attachments: [{ name: 42, mime: 'image/png', dataBase64: 'invalid-image-data' }],
      extra: 'unknown-input-field'
    };
    let requests = 0;
    const invoke = vi.fn();
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration],
        extensions: [orchestrationExtension(invoke, () => 'execution')]
      },
      () => ({
        configuration,
        async *start(): AsyncIterable<ModelEvent> {
          if (requests++ === 0) {
            yield {
              type: 'client_tool.call',
              callId: 'call',
              name: 'agent_start',
              arguments: input
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: directory });
      const run = session.run({ prompt: 'test invalid projection' });
      const normalizer = new MarAgentConversationNormalizer();
      const events = [];
      const items = [];
      for await (const event of run) {
        events.push(event);
        items.push(...normalizer.normalize(event));
      }
      expect(await run.result()).toMatchObject({ status: 'completed' });
      expect(invoke).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolName: 'agent_start',
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool.started', toolName: 'agent_start', input })
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: 'tool_call',
          status: 'FAILED',
          payload: expect.objectContaining({ inputSummary: JSON.stringify(input) })
        })
      );
      expect(
        JSON.stringify({ events, items, history: await agent.sessionHistory(session.id) })
      ).not.toContain('fixture-secret');
    } finally {
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows all six native operations in the live cell catalog and executes a programmatic call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-catalog-'));
    const names = [
      'agent_start',
      'agent_send',
      'agent_wait',
      'agent_stop',
      'agent_list',
      'agent_view'
    ];
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture'),
      modelId: 'fixture',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: true,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const requests: ModelRequest[] = [];
    const invoke = vi.fn(
      async (_executionId: string, action: string, input: Record<string, unknown>) =>
        action === 'start' ? { agentId: 'programmatic-child', title: input.title } : {}
    );
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration],
        extensions: [orchestrationExtension(invoke, () => 'execution')]
      },
      () => ({
        configuration,
        async *start(request: ModelRequest): AsyncIterable<ModelEvent> {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              callId: 'catalog',
              name: 'code_exec',
              arguments: {
                code: "const child=await tools.agent_start({title:'Cell child',content:'work'}); await tools.agent_list({}); observe.text(JSON.stringify({child:child.data.agentId,eligible:catalog.tools().filter((tool)=>tool.name.startsWith('agent_')).map((tool)=>tool.name),read:catalog.tools().some((tool)=>tool.name==='read')}));"
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: directory });
      const run = session.run({ prompt: 'inspect tools', permissionMode: 'full-access' });
      const events = (async () => {
        const all = [];
        for await (const event of run) all.push(event);
        return all;
      })();
      expect((await run.result()).status).toBe('completed');
      expect(
        requests[0]!.tools.map((tool) => tool.name).filter((name) => names.includes(name))
      ).toEqual([]);
      const completed = (await events).find(
        (event) => event.type === 'tool.completed' && event.toolName === 'code_exec'
      );
      if (completed?.type !== 'tool.completed') throw new Error('Missing cell result');
      const cell = JSON.parse(completed.summary) as { observations: Array<{ value: string }> };
      const observed = JSON.parse(cell.observations[0]!.value);
      expect(observed.child).toBe('programmatic-child');
      expect(invoke).toHaveBeenCalledWith(
        'execution',
        'start',
        expect.objectContaining({ title: 'Cell child', content: 'work' }),
        expect.anything(),
        expect.any(Function)
      );
      expect(observed.eligible).toEqual(expect.arrayContaining(names));
      expect(observed.read).toBe(true);
    } finally {
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('binds native actors (promoted: %s)', async (promoted) => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-actor-'));
    const database = new NodeDatabase(':memory:', 'network-actor');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }] as const,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const core = connector as unknown as {
      runtime: NodeRuntimeState;
      continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
      externalSessionResumeService: import('../../src/service/external-session-resume-service.js').ExternalSessionResumeService;
      sessionIdentityService: import('../../src/session/session-identity-service.js').SessionIdentityService;
      sessionMessageService: {
        operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      };
    };
    let parent = core.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'actor-parent',
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    let observer = core.agentNetworkObservations.attach(parent.id);
    try {
      await core.sessionMessageService.operations()['session.message']!({
        sessionId: parent.id,
        content: 'parent',
        clientMessageId: 'parent-first',
        personalInstructions: {
          common: 'Shared rule'.repeat(1200),
          codex: 'Runner rule'.repeat(1200)
        },
        __requestUserId: 7
      });
      const run = core.runtime.activeSessionRun(parent.id)!;
      await vi.waitFor(() => expect(core.runtime.currentExecutionId(run.id)).toBeTruthy());
      const executionId = core.runtime.currentExecutionId(run.id)!;
      const callerSessionId = parent.id;
      const invoke = agentNetworkInvoke({
        sessionId: callerSessionId,
        runtime: core.runtime,
        coordinator: core.continuousRunCoordinator,
        service: core.agentNetworkService
      });
      if (promoted) {
        const bootstrapId = parent.id;
        core.sessionIdentityService.promote(bootstrapId, 'promoted-actor-parent');
        core.agentNetworkObservations.promote(bootstrapId, 'promoted-actor-parent');
        parent = core.runtime.getAgentSessionById(bootstrapId)!;
        expect(parent.id).toBe('promoted-actor-parent');
        expect(core.continuousRunCoordinator.pending(executionId)?.sessionId).toBe(parent.id);
      }
      const context = { signal: new AbortController().signal } as ExtensionOperationContext;
      await expect(invoke(executionId, 'list', {}, context)).resolves.toMatchObject({
        currentAgentId: parent.id,
        sessions: [{ id: parent.id, parentSessionId: null, status: 'RUNNING' }],
        truncated: false
      });
      const viewed = await invoke(executionId, 'view', { agentId: parent.id }, context);
      expect(viewed).toMatchObject({
        session: { id: parent.id, status: 'RUNNING', recentTools: expect.any(Array) },
        goal: null
      });
      expect(Object.keys(viewed as object).sort()).toEqual(['goal', 'session']);
      await expect(
        invoke(executionId, 'view', { agentId: parent.id, includeHistory: true }, context)
      ).rejects.toMatchObject({ code: 'AGENT_VIEW_INVALID' });
      const abortedStart = new AbortController();
      const starting = invoke(executionId, 'start', { title: 'Child', content: 'must not start' }, {
        signal: abortedStart.signal
      } as ExtensionOperationContext);
      abortedStart.abort();
      await expect(starting).rejects.toThrow();
      expect(database.listChildSessionRecords(workspace.id, parent.id)).toEqual([]);
      const originalDirectory = executionPaths.resolveWorkspaceExecutionDirectory;
      let releaseDirectory!: () => void;
      let enteredDirectory!: () => void;
      const directoryGate = new Promise<void>((resolve) => {
        releaseDirectory = resolve;
      });
      const directoryEntered = new Promise<void>((resolve) => {
        enteredDirectory = resolve;
      });
      const directorySpy = vi
        .spyOn(executionPaths, 'resolveWorkspaceExecutionDirectory')
        .mockImplementationOnce(async (...args) => {
          const resolved = await originalDirectory(...args);
          enteredDirectory();
          await directoryGate;
          return resolved;
        });
      const ownerStartAbort = new AbortController();
      const ownerStart = invoke(
        executionId,
        'start',
        { title: 'Child', content: 'cancel during directory preparation' },
        { signal: ownerStartAbort.signal } as ExtensionOperationContext
      );
      await directoryEntered;
      ownerStartAbort.abort();
      releaseDirectory();
      await expect(ownerStart).rejects.toThrow();
      expect(database.listChildSessionRecords(workspace.id, parent.id)).toEqual([]);
      directorySpy.mockRestore();
      const created = (await invoke(
        executionId,
        'start',
        { title: 'Child', content: 'child' },
        context
      )) as { agentId: string };
      expect(core.runtime.getAgentSession(created.agentId)?.parentSessionId).toBe(parent.id);
      const instructionRun = core.runtime.activeSessionRun(created.agentId)!;
      await vi.waitFor(() =>
        expect(core.runtime.currentExecutionId(instructionRun.id)).toBeTruthy()
      );
      expect(
        core.continuousRunCoordinator.pending(core.runtime.currentExecutionId(instructionRun.id)!)
          ?.personalInstructions
      ).toBe('Shared rule'.repeat(1200) + '\n\n' + 'Runner rule'.repeat(1200));
      const messageOperations = vi.spyOn(core.sessionMessageService, 'operations');
      const abortedSend = new AbortController();
      const sending = invoke(
        executionId,
        'send',
        { agentId: created.agentId, content: 'must not send' },
        { signal: abortedSend.signal } as ExtensionOperationContext
      );
      abortedSend.abort();
      await expect(sending).rejects.toThrow();
      expect(messageOperations).not.toHaveBeenCalled();
      messageOperations.mockRestore();
      const originalResolve = core.externalSessionResumeService.acceptForMessage.bind(
        core.externalSessionResumeService
      );
      let releaseResolve!: () => void;
      let enteredResolve!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const resolution = vi
        .spyOn(core.externalSessionResumeService, 'acceptForMessage')
        .mockImplementationOnce(async (sessionId) => {
          const resolved = await originalResolve(sessionId);
          enteredResolve();
          await gate;
          return resolved;
        });
      const ownerAbort = new AbortController();
      const ownerPending = invoke(
        executionId,
        'send',
        {
          agentId: created.agentId,
          content: 'cancel before owner acceptance',
          clientMessageId: 'cancel-before-accept'
        },
        { signal: ownerAbort.signal } as ExtensionOperationContext
      );
      await entered;
      ownerAbort.abort();
      releaseResolve();
      await expect(ownerPending).rejects.toThrow();
      expect(
        core.runtime.findMessageSubmission(created.agentId, 'cancel-before-accept')
      ).toBeUndefined();
      resolution.mockRestore();
      let releasePreparation!: () => void;
      let enteredPreparation!: () => void;
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const preparationEntered = new Promise<void>((resolve) => {
        enteredPreparation = resolve;
      });
      const preparationSpy = vi
        .spyOn(executionPaths, 'resolveWorkspaceExecutionDirectory')
        .mockImplementationOnce(async (...args) => {
          const resolved = await originalDirectory(...args);
          enteredPreparation();
          await preparationGate;
          return resolved;
        });
      const afterAcceptAbort = new AbortController();
      const afterAccept = invoke(
        executionId,
        'send',
        {
          agentId: created.agentId,
          content: 'accepted before cancellation',
          clientMessageId: 'accepted-before-cancel',
          deliveryIntent: 'QUEUE'
        },
        { signal: afterAcceptAbort.signal } as ExtensionOperationContext
      );
      await preparationEntered;
      const acceptedSubmission = core.runtime.findMessageSubmission(
        created.agentId,
        'accepted-before-cancel'
      );
      expect(acceptedSubmission).toBeDefined();
      afterAcceptAbort.abort();
      releasePreparation();
      expect(await afterAccept).toMatchObject({ message: { status: 'accepted' } });
      expect(
        core.runtime.findMessageSubmission(created.agentId, 'accepted-before-cancel')
      ).toBeDefined();
      preparationSpy.mockRestore();
      const command = agentNetworkExecutionCommand({
        runtime: core.runtime,
        coordinator: core.continuousRunCoordinator,
        service: core.agentNetworkService,
        observations: core.agentNetworkObservations
      });
      const request = {
        workspaceId: workspace.id,
        action: 'list',
        input: {},
        __requestUserId: 7,
        __marctlCaller: { type: 'execution', sessionId: callerSessionId, executionId }
      };
      expect(await command(request)).toMatchObject({
        sessions: expect.arrayContaining([expect.objectContaining({ id: created.agentId })])
      });
      await expect(command({ ...request, __requestUserId: 8 })).rejects.toThrow(
        'MARCTL_EXECUTION_CREDENTIAL_INVALID'
      );
      await expect(command({ ...request, workspaceId: 'another' })).rejects.toThrow(
        'MARCTL_EXECUTION_CREDENTIAL_INVALID'
      );
      await expect(
        command({ ...request, __marctlCaller: { ...request.__marctlCaller, executionId: 'stale' } })
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      const terminal = {
        workspaceId: workspace.id,
        __requestUserId: 7,
        __marctlCaller: { type: 'terminal' },
        action: 'view',
        input: { agentId: parent.id }
      };
      expect(await command(terminal)).toMatchObject({ session: { id: parent.id } });
      await expect(command({ ...terminal, workspaceId: 'another' })).rejects.toThrow(
        'SESSION_NOT_FOUND'
      );
      await expect(
        command({ ...terminal, action: 'list', input: { scope: 'tree' } })
      ).rejects.toThrow('AGENT_TARGET_REQUIRED');
      expect(
        await command({
          ...terminal,
          action: 'list',
          input: { scope: 'active' }
        })
      ).toMatchObject({
        currentAgentId: null,
        sessions: expect.arrayContaining([expect.objectContaining({ id: parent.id })])
      });
      await expect(
        invoke('unknown-execution', 'send', { agentId: created.agentId, content: 'no' }, context)
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      const currentExecution = vi
        .spyOn(core.runtime, 'currentExecutionId')
        .mockReturnValueOnce('new-execution');
      await expect(
        invoke(executionId, 'send', { agentId: created.agentId, content: 'stale' }, context)
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      currentExecution.mockRestore();
      const snapshot = core.runtime.executionSnapshot(executionId)!;
      const executionSnapshot = vi
        .spyOn(core.runtime, 'executionSnapshot')
        .mockReturnValueOnce({ ...snapshot, status: 'SUCCEEDED' });
      await expect(
        invoke(executionId, 'send', { agentId: created.agentId, content: 'terminal' }, context)
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      executionSnapshot.mockRestore();
      const childRun = core.runtime.activeSessionRun(created.agentId)!;
      await vi.waitFor(() => expect(core.runtime.currentExecutionId(childRun.id)).toBeTruthy());
      const childExecutionId = core.runtime.currentExecutionId(childRun.id)!;
      await expect(invoke(childExecutionId, 'list', {}, context)).rejects.toThrow(
        'AGENT_ACTOR_NOT_ACTIVE'
      );
      const childInvoke = agentNetworkInvoke({
        sessionId: created.agentId,
        runtime: core.runtime,
        coordinator: core.continuousRunCoordinator,
        service: core.agentNetworkService
      });
      expect(observer.capture(created.agentId)).toBeUndefined();
      expect(
        await childInvoke(
          childExecutionId,
          'send',
          { agentId: parent.id, content: 'upward report' },
          context
        )
      ).toMatchObject({ agentId: parent.id, message: { status: 'accepted' } });
      expect(core.runtime.activeSessionRun(parent.id)?.id).toBe(run.id);
      expect(core.runtime.currentExecutionId(run.id)).toBe(executionId);
      expect(observer.wake.pending()).toBe(false);
      expect(
        core.runtime.sessionQueue(parent.id).itemIds.map((id) => core.runtime.getQueueItem(id))
      ).toContainEqual(
        expect.objectContaining({
          content: expect.stringContaining('upward report'),
          initiatedByUserId: 7
        })
      );
      expect(core.agentNetworkObservations.get(created.agentId)).toBeUndefined();
      observer.capture(created.agentId, childExecutionId)?.acknowledge();
      observer.close();
      expect(
        await childInvoke(
          childExecutionId,
          'send',
          { agentId: parent.id, content: 'cold report' },
          context
        )
      ).toMatchObject({ agentId: parent.id, message: { status: 'accepted' } });
      expect(core.agentNetworkObservations.get(parent.id)).toBeUndefined();
      expect(core.runtime.activeSessionRun(parent.id)?.id).toBe(run.id);
      observer = core.agentNetworkObservations.attach(parent.id);
      core.agentNetworkObservations.publishChild({
        parentId: parent.id,
        childId: created.agentId,
        runId: childRun.id,
        executionId: childExecutionId,
        kind: 'message',
        value: 'unread progress'
      });
      const abort = new AbortController();
      const cancelledWait = command({
        ...request,
        action: 'wait',
        input: { agentId: created.agentId, waitFor: 'completion', waitMs: 10_000 },
        __requestAbortSignal: abort.signal
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      abort.abort();
      await expect(cancelledWait).rejects.toThrow();
      expect(observer.capture(created.agentId, childExecutionId)?.updates).toContainEqual(
        expect.objectContaining({ kind: 'message', value: 'unread progress' })
      );
      expect(
        await invoke(executionId, 'stop', { agentId: created.agentId }, context)
      ).toMatchObject({ agentId: created.agentId, cancel: { status: 'accepted' } });
    } finally {
      observer.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('uses Server-prepared MAR resources for a non-MAR Execution through the Node request boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-cross-runner-'));
    const database = new NodeDatabase(':memory:', 'network-cross-runner');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }] as const,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false },
        marAgent: { available: true }
      }
    });
    const core = connector as unknown as {
      runtime: NodeRuntimeState;
      continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
      agentNetworkService: AgentNetworkService;
      runnerService: {
        operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      };
      sessionLifecycleService: {
        operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      };
      sessionMessageService: {
        operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
      };
    };
    const parent = core.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'cross-runner-parent',
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    try {
      await core.sessionMessageService.operations()['session.message']!({
        sessionId: parent.id,
        content: 'parent',
        clientMessageId: 'cross-parent',
        __requestUserId: 7
      });
      core.runtime.updateSessionMetadata({ sessionId: parent.id, customTitle: '  Parent title  ' });
      const messageOperations = core.sessionMessageService.operations();
      const deliver = vi.fn(messageOperations['session.message']);
      vi.spyOn(core.sessionMessageService, 'operations').mockReturnValue({
        ...messageOperations,
        'session.message': deliver
      });
      const lifecycleOperations = core.sessionLifecycleService.operations();
      const start = vi.fn(lifecycleOperations['session.start']);
      vi.spyOn(core.sessionLifecycleService, 'operations').mockReturnValue({
        ...lifecycleOperations,
        'session.start': start
      });
      const run = core.runtime.activeSessionRun(parent.id)!;
      await vi.waitFor(() => expect(core.runtime.currentExecutionId(run.id)).toBeTruthy());
      const executionId = core.runtime.currentExecutionId(run.id)!;
      const caller = { type: 'execution' as const, sessionId: parent.id, executionId };
      const command = agentNetworkExecutionCommand({
        runtime: core.runtime,
        coordinator: core.continuousRunCoordinator,
        service: core.agentNetworkService
      });
      const responses: Array<{ result?: unknown; error?: unknown }> = [];
      const nodeRequest = new NodeRequestService({
        nodeId: () => 'node',
        databaseAvailable: () => true,
        resolveMarctlCaller: () => caller,
        authorizeMarctlOperation: async () => {},
        execute: async (_operation, data) => command(data),
        send: (_type, payload) => {
          responses.push(payload as { result?: unknown; error?: unknown });
        }
      });
      const model = {
        id: 'eligible',
        name: 'Eligible',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        credential: { type: 'INLINE_API_KEY', value: 'fixture-only' },
        modelId: 'fixture',
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: false,
        hostedWebSearch: false,
        enabled: true,
        conversationModel: true,
        subagentModel: true,
        sortOrder: 0
      };
      const { credential: _fixtureCredential, ...modelSummary } = model;
      await core.runnerService.operations()['runner.profiles.list']!({
        marAgentModels: [modelSummary]
      });
      await expect(
        command({
          workspaceId: workspace.id,
          action: 'start',
          input: {
            runner: 'mar-agent',
            modelId: 'eligible',
            title: 'Child',
            content: 'forged parent',
            parentSessionId: 'someone-else'
          },
          __requestUserId: 7,
          __marctlCaller: caller,
          __marctlExecutionResources: { marAgentModel: model, marAgentModels: [model] }
        })
      ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      await expect(
        command({
          workspaceId: workspace.id,
          action: 'send',
          input: { agentId: 'absent', content: 'wrong source' },
          __requestUserId: 7,
          __marctlCaller: { ...caller, sessionId: 'missing' }
        })
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      let sequence = 0;
      const request = async (
        action: string,
        input: Record<string, unknown>,
        resources: Record<string, unknown> = { marAgentModel: model, marAgentModels: [model] }
      ) => {
        const id = `cross-${++sequence}`;
        const issuedAt = Date.now();
        await nodeRequest.handle(
          createEnvelope(
            'node.request',
            {
              operation: 'agent.network',
              data: {
                workspaceId: workspace.id,
                action,
                input,
                __marctlExecutionResources: { marAgentModel: { id: 'forged' } }
              },
              userAuthorization: {
                userId: 7,
                sessionHash: 'a'.repeat(43),
                nodeId: 'node',
                operation: 'agent.network',
                requestId: id,
                issuedAt,
                expiresAt: issuedAt + 15000,
                marctlCaller: caller,
                marctlExecutionResources: resources
              }
            },
            { id }
          )
        );
        const response = responses.pop();
        expect(response?.error).toBeUndefined();
        return response?.result as Record<string, unknown>;
      };
      const listing = await request(
        'list',
        { scope: 'tree' },
        {
          marAgentModels: [
            modelSummary,
            { ...modelSummary, id: 'disabled', enabled: false },
            { ...modelSummary, id: 'no-conversation', conversationModel: false },
            { ...modelSummary, id: 'no-subagent', subagentModel: false }
          ]
        }
      );
      expect(listing.sessions).toEqual([expect.objectContaining({ id: parent.id })]);
      expect(JSON.stringify(listing)).not.toContain('fixture-only');
      expect(JSON.stringify(listing)).not.toContain('unauthorized');
      const sessionsBefore = core.runtime.listAgentSessions();
      await expect(
        core.sessionLifecycleService.operations()['session.create']!({
          workspaceId: workspace.id,
          runner: 'mar-agent',
          cwd: workspace.path,
          parentSessionId: parent.id,
          modelId: 'eligible',
          title: 'Rejected child'
        })
      ).rejects.toThrow('MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE');
      expect(core.runtime.listAgentSessions()).toEqual(sessionsBefore);
      // Another viewer's empty catalog must not revoke this Execution's resources.
      await core.runnerService.operations()['runner.profiles.list']!({});
      const started = await request('start', {
        runner: 'mar-agent',
        modelId: 'eligible',
        title: 'Child',
        content: 'first',
        clientMessageId: 'cross-start'
      });
      expect(typeof started.agentId).toBe('string');
      const childId = started.agentId as string;
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          __suppressNotifications: true,
          __marctlOrigin: { sessionId: parent.id, name: 'Parent title' }
        })
      );
      expect(core.runtime.activeSessionRun(childId)?.suppressNotifications).toBe(true);
      expect(core.runtime.activeSessionRun(parent.id)?.suppressNotifications).not.toBe(true);
      expect(core.runtime.getAgentSession(childId)).toMatchObject({
        parentSessionId: parent.id,
        runner: 'mar-agent',
        modelId: 'eligible'
      });
      const childBefore = { ...core.runtime.getAgentSession(childId)! };
      const queueBefore = structuredClone(core.runtime.sessionQueue(childId));
      await expect(
        core.sessionLifecycleService.operations()['session.config.update']!({
          sessionId: childId,
          modelId: 'not-authorized'
        })
      ).rejects.toThrow('MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE');
      await expect(
        core.sessionMessageService.operations()['session.message']!({
          sessionId: childId,
          content: 'Rejected message',
          clientMessageId: 'rejected-profile-message'
        })
      ).rejects.toThrow('MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE');
      expect(core.runtime.getAgentSession(childId)).toEqual(childBefore);
      expect(core.runtime.sessionQueue(childId)).toEqual(queueBefore);
      await expect(
        core.sessionLifecycleService.operations()['session.config.update']!({
          sessionId: childId,
          modelId: 'eligible',
          marAgentModels: [modelSummary]
        })
      ).resolves.toMatchObject({ session: { modelId: 'eligible' } });
      await core.runnerService.operations()['runner.profiles.list']!({
        marAgentModels: [{ ...modelSummary, id: 'another-viewer-model' }]
      });
      const sent = await request('send', {
        agentId: childId,
        content: 'follow-up',
        deliveryIntent: 'QUEUE',
        clientMessageId: 'cross-send'
      });
      expect(sent).toMatchObject({ agentId: childId, message: { status: 'accepted' } });
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          __suppressNotifications: true,
          __marctlOrigin: { sessionId: parent.id, name: 'Parent title' }
        })
      );
      expect(core.runtime.findMessageSubmission(childId, 'cross-send')).toBeDefined();
      core.runtime.updateSessionMetadata({ sessionId: parent.id, customTitle: null });
      await request('send', {
        agentId: childId,
        content: 'again',
        deliveryIntent: 'QUEUE',
        clientMessageId: 'cross-send-id',
        sourceSessionName: 'Forged'
      });
      expect(deliver).toHaveBeenLastCalledWith(
        expect.objectContaining({
          __marctlOrigin: { sessionId: parent.id, name: 'parent' }
        })
      );
      core.runtime.setRunnerTitleFromNative(parent.id, 'Runner title');
      await request('send', {
        agentId: childId,
        content: 'more',
        deliveryIntent: 'QUEUE',
        clientMessageId: 'cross-send-title'
      });
      expect(deliver).toHaveBeenLastCalledWith(
        expect.objectContaining({
          __marctlOrigin: { sessionId: parent.id, name: 'Runner title' }
        })
      );
      const getSession = core.runtime.getAgentSession.bind(core.runtime);
      vi.spyOn(core.runtime, 'getAgentSession').mockImplementation((id) => {
        const session = getSession(id);
        return session && id === parent.id
          ? { ...session, customTitle: null, runnerTitle: null }
          : session;
      });
      await request('send', {
        agentId: childId,
        content: 'last',
        deliveryIntent: 'QUEUE',
        clientMessageId: 'cross-send-untitled'
      });
      expect(deliver).toHaveBeenLastCalledWith(
        expect.objectContaining({
          __marctlOrigin: { sessionId: parent.id, name: parent.id }
        })
      );
    } finally {
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['parent', 'promoted-parent', 'grandparent', 'sibling', 'independent'] as const)(
    'uses normal native messaging, wait, Goal and stop for %s targets without a relationship grant',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-network-upward-'));
      const database = new NodeDatabase(':memory:', 'network-upward');
      const workspace = database.saveWorkspace({
        path: directory,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        fakeRunner: new FakeRunner(),
        fakeScript: () => [{ type: 'long-running' }] as const,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true, version: 'codex-cli 0.147.0' },
          claudeCode: { available: false }
        }
      });
      const core = connector as unknown as {
        runtime: NodeRuntimeState;
        continuousRunCoordinator: ContinuousRunCoordinator<unknown>;
        agentNetworkService: AgentNetworkService;
        agentNetworkObservations: AgentNetworkObservations;
        sessionMessageService: {
          operations(): Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
        };
      };
      const parent = core.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        ...(kind === 'promoted-parent' ? {} : { externalSessionId: 'idle-parent' }),
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED'
      });
      const childParent =
        kind === 'grandparent'
          ? core.runtime.createAgentSession({
              workspaceId: workspace.id,
              runner: 'codex',
              cwd: workspace.path,
              externalSessionId: 'intermediate-parent',
              parentSessionId: parent.id,
              modelId: 'gpt-5.3-codex',
              effort: 'medium',
              nativeControl: 'MAR_MANAGED'
            })
          : parent;
      const child = core.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'active-child',
        parentSessionId: childParent.id,
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED'
      });
      const ancestorTarget =
        kind === 'parent' || kind === 'promoted-parent' || kind === 'grandparent';
      const target = ancestorTarget
        ? kind === 'promoted-parent'
          ? core.runtime.promoteSessionIdentity(parent.id, 'promoted-parent-native')
          : parent
        : core.runtime.createAgentSession({
            workspaceId: workspace.id,
            runner: 'codex',
            cwd: workspace.path,
            externalSessionId: `target-${kind}`,
            ...(kind === 'sibling' ? { parentSessionId: parent.id } : {}),
            modelId: 'gpt-5.3-codex',
            effort: 'medium',
            nativeControl: 'MAR_MANAGED'
          });
      const observer = core.agentNetworkObservations.attach(child.id);
      let persistedParentLookup: ReturnType<typeof vi.spyOn> | undefined;
      if (kind === 'grandparent') {
        database.saveNativeSessionMetadata({
          runner: childParent.runner,
          externalSessionId: childParent.externalSessionId!,
          workspaceId: workspace.id,
          parentSessionId: parent.id,
          initializeParent: true
        });
        expect(database.getSessionRecord(childParent.id)?.metadata.parentSessionId).toBe(parent.id);
        const getAgentSession = core.runtime.getAgentSession.bind(core.runtime);
        persistedParentLookup = vi
          .spyOn(core.runtime, 'getAgentSession')
          .mockImplementation((id) => (id === childParent.id ? undefined : getAgentSession(id)));
      }
      try {
        await core.sessionMessageService.operations()['session.message']!({
          sessionId: child.id,
          content: 'child',
          clientMessageId: 'child-start',
          __requestUserId: 7
        });
        const run = core.runtime.activeSessionRun(child.id)!;
        await vi.waitFor(() => expect(core.runtime.currentExecutionId(run.id)).toBeTruthy());
        const executionId = core.runtime.currentExecutionId(run.id)!;
        const invoke = agentNetworkInvoke({
          sessionId: child.id,
          runtime: core.runtime,
          coordinator: core.continuousRunCoordinator,
          service: core.agentNetworkService
        });
        const context = { signal: new AbortController().signal } as ExtensionOperationContext;
        const requests: Record<string, unknown>[] = [];
        const operations = core.sessionMessageService.operations.bind(core.sessionMessageService);
        vi.spyOn(core.sessionMessageService, 'operations').mockImplementation(() => {
          const handlers = operations();
          return {
            ...handlers,
            'session.message': async (input) => {
              requests.push(input);
              return handlers['session.message']!(input);
            }
          };
        });
        expect(core.agentNetworkObservations.get(target.id)).toBeUndefined();
        if (ancestorTarget) {
          for (const input of [
            { content: 'report', deliveryIntent: 'SEND' },
            { content: 'report', deliveryIntent: 'QUEUE' },
            { content: 'report', deliveryIntent: 'REPLACE_CURRENT' },
            { content: 'report', goal: { objective: 'must not restart the ancestor' } },
            { goal: { objective: 'must not restart the ancestor' } }
          ]) {
            await expect(
              invoke(executionId, 'send', { agentId: target.id, ...input }, context)
            ).rejects.toMatchObject({ code: 'AGENT_ANCESTOR_NOT_ACTIVE' });
          }
          expect(requests).toEqual([]);
          expect(core.runtime.activeSessionRun(target.id)).toBeUndefined();
          expect(await invoke(executionId, 'view', { agentId: target.id }, context)).toMatchObject({
            goal: null
          });
          // A user may resume the ancestor; subsequent Agent messages are then accepted.
          await core.sessionMessageService.operations()['session.message']!({
            sessionId: target.id,
            content: 'user resume',
            clientMessageId: 'ancestor-user-resume',
            __requestUserId: 7
          });
          const activeSessionRun = core.runtime.activeSessionRun.bind(core.runtime);
          const cancelling = vi.spyOn(core.runtime, 'activeSessionRun').mockImplementation((id) => {
            const run = activeSessionRun(id);
            return id === target.id && run ? { ...run, status: 'CANCELLING' } : run;
          });
          try {
            await expect(
              invoke(
                executionId,
                'send',
                { agentId: target.id, content: 'stopping report' },
                context
              )
            ).rejects.toMatchObject({ code: 'AGENT_ANCESTOR_NOT_ACTIVE' });
          } finally {
            cancelling.mockRestore();
          }
        }
        for (const deliveryIntent of ['SEND', 'QUEUE', 'REPLACE_CURRENT'] as const) {
          expect(
            await invoke(
              executionId,
              'send',
              {
                agentId: target.id,
                content: `message ${deliveryIntent}`,
                clientMessageId: `native-${deliveryIntent}`,
                deliveryIntent
              },
              context
            )
          ).toMatchObject({ message: { status: 'accepted' } });
          expect(requests.at(-1)).toMatchObject({
            sessionId: target.id,
            content: `message ${deliveryIntent}`,
            clientMessageId: `native-${deliveryIntent}`,
            deliveryIntent,
            __marctlOrigin: { sessionId: child.id }
          });
          if (ancestorTarget)
            expect(requests.at(-1)).toMatchObject({
              __marctlOrigin: { relation: kind === 'grandparent' ? 'descendant' : 'child' }
            });
        }
        expect(
          await invoke(
            executionId,
            'send',
            { agentId: target.id, goal: { objective: 'Continue the existing target work' } },
            context
          )
        ).toMatchObject({ goal: { status: 'applied' } });
        const targetRun = core.runtime.activeSessionRun(target.id)!;
        expect(targetRun.initiatedByUserId).toBe(7);
        await vi.waitFor(() => expect(core.runtime.currentExecutionId(targetRun.id)).toBeTruthy());
        expect(
          await invoke(executionId, 'wait', { agentId: target.id, waitMs: 0 }, context)
        ).toMatchObject({ agentId: target.id, waitOutcome: 'snapshot' });
        expect(observer.capture(target.id)).toBeUndefined();
        expect(await invoke(executionId, 'stop', { agentId: target.id }, context)).toMatchObject({
          cancel: { status: 'accepted' },
          goal: { status: 'cleared' }
        });
        if (ancestorTarget) {
          await vi.waitFor(() => expect(core.runtime.activeSessionRun(target.id)).toBeUndefined());
          const delivered = requests.length;
          await expect(
            invoke(executionId, 'send', { agentId: target.id, content: 'late report' }, context)
          ).rejects.toMatchObject({ code: 'AGENT_ANCESTOR_NOT_ACTIVE' });
          expect(requests).toHaveLength(delivered);
          expect(core.runtime.activeSessionRun(target.id)).toBeUndefined();
        }
      } finally {
        persistedParentLookup?.mockRestore();
        observer.close();
        await connector.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['start', 'inline'],
    ['start', 'reference'],
    ['send', 'inline'],
    ['send', 'reference']
  ] as const)(
    'rejects %s with retired %s attachments before invoking the Node owner',
    async (action, kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-network-image-'));
      const database = new NodeDatabase(':memory:', 'network-image');
      const workspace = database.saveWorkspace({
        path: directory,
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const connector = new NodeConnector({
        reconnect: false,
        database,
        fakeRunner: new FakeRunner(),
        config: {
          serverUrl: 'http://127.0.0.1',
          allowedRoots: [directory],
          dataDirectory: directory
        },
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: true, version: 'codex-cli 0.147.0' },
          claudeCode: { available: false }
        }
      });
      const internals = connector as unknown as {
        runtime: NodeRuntimeState;
        agentNetworkService: AgentNetworkService;
        agentNetworkObservations: AgentNetworkObservations;
        sessionMessageService: {
          operations(): Record<string, (input: Record<string, unknown>) => unknown>;
        };
        runAttachmentService: {
          persistFiles(
            workspaceId: string,
            runId: string,
            attachments: readonly unknown[]
          ): Promise<readonly string[]>;
        };
        executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
      };
      const parent = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'image-parent',
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED'
      });
      const child = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'image-child',
        parentSessionId: parent.id,
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED'
      });
      const observer = internals.agentNetworkObservations.attach(parent.id);
      const image = {
        name: 'pixel.png',
        mime: 'image/png',
        dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      };
      const attachmentId = '9e93ee84-61a1-413b-a8c3-df4cd70320b9';
      if (kind === 'reference') {
        const uploaded = (await internals.executeNodeOperation('workspace.files.upload.create', {
          workspaceId: workspace.id,
          name: image.name,
          mime: image.mime,
          size: Buffer.from(image.dataBase64, 'base64').length,
          overwrite: false,
          composerAttachmentId: attachmentId
        })) as { upload: { uploadId: string } };
        await internals.executeNodeOperation('workspace.files.upload.chunk', {
          workspaceId: workspace.id,
          uploadId: uploaded.upload.uploadId,
          offset: 0,
          dataBase64: image.dataBase64
        });
        await internals.executeNodeOperation('workspace.files.upload.complete', {
          workspaceId: workspace.id,
          uploadId: uploaded.upload.uploadId
        });
      }
      const persist = vi.spyOn(internals.runAttachmentService, 'persistFiles');
      const actor = { sessionId: parent.id, requestUserId: 7 };
      const delivered = vi.fn(async (_execution, operation, input) =>
        operation === 'start'
          ? internals.agentNetworkService.start(actor, input)
          : internals.agentNetworkService.send(actor, input)
      );
      const configuration: AgentModelConfiguration = {
        id: 'fixture',
        name: 'Fixture',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('fixture'),
        modelId: 'fixture',
        contextWindowTokens: 200000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        titleGeneration: false,
        codeMode: false,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        enabled: true
      };
      let requests = 0;
      const agent = await createAgentWithAdapter(
        {
          mode: 'node',
          host: new LocalAgentHost({
            mode: 'node',
            homeDirectory: directory,
            workspace: directory
          }),
          models: [configuration],
          extensions: [orchestrationExtension(delivered, () => 'execution')]
        },
        () => ({
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            if (requests++ === 0) {
              yield {
                type: 'client_tool.call',
                callId: 'image-call',
                name: `agent_${action}`,
                arguments: {
                  ...(action === 'send' ? { agentId: child.id } : { title: 'Image task' }),
                  content: 'Valid text does not enable attachment input',
                  ...(kind === 'inline'
                    ? { attachments: [image] }
                    : { attachmentIds: [attachmentId] })
                }
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield { type: 'text.completed', itemId: 'answer', text: 'done' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace: directory });
        const run = session.run({ prompt: 'Send the image.' });
        const failures: string[] = [];
        const events = (async () => {
          for await (const event of run)
            if (event.type === 'tool.failed') failures.push(event.code);
        })();
        const result = await run.result();
        await events;
        expect(result.status).toBe('completed');
        expect(failures).toEqual(['MAR_AGENT_TOOL_INPUT_INVALID']);
        expect(delivered).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
      } finally {
        await agent.dispose();
        observer.close();
        await connector.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it('allows authorized session control regardless of relationships but rejects foreign ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-authorization-'));
    const database = new NodeDatabase(':memory:', 'network-authorization');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
    };
    const create = (id: string, parentSessionId?: string) =>
      internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: id,
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED',
        ...(parentSessionId ? { parentSessionId } : {})
      });
    const root = create('auth-root');
    const source = create('auth-source', root.id);
    const sibling = create('auth-sibling', root.id);
    const independent = create('auth-independent');
    const child = create('auth-child', source.id);
    const observer = internals.agentNetworkObservations.attach(source.id);
    const actor = { sessionId: source.id, requestUserId: 7 };
    try {
      for (const target of [source, root, sibling, independent, child]) {
        expect(
          await internals.agentNetworkService.view(actor, { agentId: target.id })
        ).toMatchObject({
          session: { id: target.id }
        });
        expect(
          await internals.agentNetworkService.send(actor, {
            agentId: target.id,
            goal: { clear: true }
          })
        ).toMatchObject({ goal: { status: 'applied' } });
      }
      internals.runtime.createQueueItem({
        sessionId: child.id,
        clientMessageId: 'foreign',
        content: 'other user',
        initiatedByUserId: 8
      });
      await expect(
        internals.agentNetworkService.send(actor, { agentId: child.id, content: 'message' })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      await expect(
        internals.agentNetworkService.send(actor, { agentId: child.id, goal: { clear: true } })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      await expect(
        internals.agentNetworkService.stop(actor, { agentId: child.id })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      await expect(
        internals.agentNetworkService.wait(actor, { agentId: child.id, waitMs: 0 })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      const foreignWorkspace = database.saveWorkspace({
        path: join(directory, 'foreign'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      const foreign = internals.runtime.createAgentSession({
        workspaceId: foreignWorkspace.id,
        runner: 'codex',
        cwd: foreignWorkspace.path,
        externalSessionId: 'foreign-session',
        modelId: 'gpt-5.3-codex',
        nativeControl: 'MAR_MANAGED'
      });
      await expect(
        internals.agentNetworkService.send(actor, { agentId: foreign.id, content: 'forbidden' })
      ).rejects.toThrow('SESSION_NOT_FOUND');
      await expect(
        internals.agentNetworkService.send(
          { sessionId: source.id },
          { agentId: child.id, content: 'message' }
        )
      ).rejects.toThrow('USER_AUTHORIZATION_REQUIRED');
    } finally {
      observer.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('decides live authorized approvals regardless of relationships through the existing Run owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-approval-'));
    const database = new NodeDatabase(':memory:', 'network-approval');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
    };
    const create = (id: string, parentSessionId?: string) =>
      internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: id,
        modelId: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED',
        ...(parentSessionId ? { parentSessionId } : {})
      });
    const root = create('approval-root');
    const parent = create('approval-parent', root.id);
    const sibling = create('approval-sibling', root.id);
    const foreignOwner = create('approval-foreign-owner');
    const child = create('approval-child', parent.id);
    const observer = internals.agentNetworkObservations.attach(parent.id);
    const terminalObserver = internals.agentNetworkObservations.attach('terminal-observer');
    const actor = { sessionId: parent.id, requestUserId: 7 };
    const active = (sessionId: string, id: string, initiatedByUserId = 7) => {
      const run = internals.runtime.createMessageRun({
        sessionId,
        clientMessageId: id,
        content: 'work',
        initiatedByUserId
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      internals.runtime.transitionRun(run.id, 'RUNNING');
      const approval = internals.runtime.createApproval({
        runId: execution.id,
        approvalId: id,
        expiresAt: Date.now() + 60_000,
        payload: { toolName: 'exec', input: 'PRIVATE_INPUT' }
      });
      return { run, execution, approval };
    };
    try {
      const childExecution = active(child.id, 'child-approval');
      active(sibling.id, 'sibling-approval');
      const foreignApproval = active(foreignOwner.id, 'foreign-approval', 8).approval;
      const rootExecution = active(root.id, 'root-approval').execution;
      await expect(
        internals.agentNetworkService.send(actor, {
          agentId: foreignOwner.id,
          approval: { approvalId: 'foreign-approval', decision: 'approve' }
        })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
      expect(internals.runtime.getApproval(foreignApproval.id)).toMatchObject({
        status: 'PENDING'
      });
      const view = await internals.agentNetworkService.view(actor, { agentId: child.id });
      expect(view).toMatchObject({
        session: {
          pendingApprovals: [
            expect.objectContaining({
              approvalId: 'child-approval'
            })
          ]
        }
      });
      expect(JSON.stringify(view)).not.toContain('PRIVATE_INPUT');
      expect(JSON.stringify(view)).not.toContain(childExecution.run.id);
      expect(JSON.stringify(view)).not.toContain(childExecution.execution.id);
      for (const [agentId, approvalId] of [
        [sibling.id, 'sibling-approval'],
        [root.id, 'root-approval']
      ] as const)
        expect(
          await internals.agentNetworkService.send(actor, {
            agentId,
            approval: { approvalId, decision: 'approve' }
          })
        ).toMatchObject({
          approval: { status: 'applied', result: { approvalId, decision: 'approve' } }
        });
      internals.agentNetworkObservations.publishChild({
        parentId: root.id,
        childId: sibling.id,
        runId: 'other-run',
        executionId: 'other-execution',
        kind: 'message',
        value: 'unrelated'
      });
      expect(observer.capture(sibling.id)).toBeUndefined();
      internals.agentNetworkObservations.publishChild({
        childId: root.id,
        runId: 'root-run',
        executionId: 'root-execution',
        kind: 'message',
        value: 'unrelated root'
      });
      expect(observer.capture(root.id)).toBeUndefined();
      expect(
        await internals.agentNetworkService.send(actor, {
          agentId: child.id,
          approval: { approvalId: 'child-approval', decision: 'approve' }
        })
      ).toMatchObject({
        approval: {
          status: 'applied',
          result: { approvalId: 'child-approval', decision: 'approve' }
        }
      });
      await expect(
        internals.agentNetworkService.send(actor, {
          agentId: child.id,
          approval: { approvalId: 'child-approval', decision: 'approve' }
        })
      ).rejects.toThrow();
      const terminal = actorForAuthenticatedTerminal(
        { sessionId: '', observationId: 'terminal-observer', requestUserId: 7 },
        workspace.id
      );
      internals.runtime.createApproval({
        runId: rootExecution.id,
        approvalId: 'root-terminal-approval',
        expiresAt: Date.now() + 60_000,
        payload: { toolName: 'exec', input: 'PRIVATE_INPUT' }
      });
      expect(
        await internals.agentNetworkService.send(terminal, {
          agentId: root.id,
          approval: { approvalId: 'root-terminal-approval', decision: 'reject' }
        })
      ).toMatchObject({
        approval: { status: 'applied', result: { decision: 'reject' } }
      });
    } finally {
      observer.close();
      terminalObserver.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('submits idle send with Goal and message once through the Goal owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-idle-'));
    const database = new NodeDatabase(':memory:', 'network-idle-goal');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const script = vi.fn((_input: unknown) => [{ type: 'long-running' }] as const);
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: script,
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      goalRuntime: GoalRuntime;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
      sessionMessageService: { submitGoal(input: Record<string, unknown>): Promise<unknown> };
      marctlExecutionCredentials: { request(input: unknown): Promise<string> };
    };
    const parent = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'idle-parent',
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const child = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'idle-child',
      parentSessionId: parent.id,
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const observer = internals.agentNetworkObservations.attach(parent.id);
    const submit = vi.spyOn(internals.sessionMessageService, 'submitGoal');
    const exchange = vi
      .spyOn(internals.marctlExecutionCredentials, 'request')
      .mockResolvedValue('child-token');
    try {
      expect(
        await internals.agentNetworkService.send(
          {
            sessionId: parent.id,
            requestUserId: 7,
            secretEnvironment: {
              MAR_CTL_USER_TOKEN: 'caller-token',
              NETWORK_TEST_SECRET: 'permitted'
            }
          },
          {
            agentId: child.id,
            content: 'The single body',
            clientMessageId: 'idle-send',
            goal: { objective: 'Finish the work' }
          }
        )
      ).toMatchObject({ message: { status: 'accepted' }, goal: { status: 'applied' } });
      await vi.waitFor(() => expect(script).toHaveBeenCalledOnce());
      const starts = submit.mock.calls.filter(([input]) => input.kind === 'start');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.[0]).toMatchObject({
        clientMessageId: 'idle-send',
        messageContent: 'The single body',
        suppressNotifications: true
      });
      expect(starts[0]?.[0].secretEnvironment).toEqual({
        MAR_CTL_USER_TOKEN: 'caller-token',
        NETWORK_TEST_SECRET: 'permitted'
      });
      expect(exchange).toHaveBeenCalledOnce();
      expect(JSON.stringify(script.mock.calls[0]?.[0])).not.toContain('caller-token');
      expect(internals.goalRuntime.get(child.id)?.objective).toBe('Finish the work');
      expect(JSON.stringify(script.mock.calls[0]?.[0]).match(/The single body/g)).toHaveLength(1);
      expect(internals.runtime.conversationTail(child.id)).toHaveLength(1);
    } finally {
      observer.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates a Goal-owned child, observes output, sends, waits and stops through existing owners', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-owner-'));
    const database = new NodeDatabase(':memory:', 'network-owner-integration');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    database.saveRunnerDefaults({
      runner: 'codex',
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      access: 'auto'
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }],
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      goalRuntime: GoalRuntime;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
      emitRunEvent(
        id: string,
        type: string,
        payload: unknown,
        status?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'
      ): void;
    };
    const parent = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'network-parent',
      modelId: 'parent-non-default',
      effort: 'high',
      nativeControl: 'MAR_MANAGED'
    });
    const observations = internals.agentNetworkObservations.attach(parent.id);
    const actor = {
      sessionId: parent.id,
      requestUserId: 7,
      secretEnvironment: { NETWORK_TEST_SECRET: 'test-secret-value' }
    };
    try {
      const started = (await internals.agentNetworkService.start(actor, {
        content: 'Deliver the body once',
        clientMessageId: 'network-first',
        goal: { objective: 'Complete the child task' }
      })) as { agentId: string };
      expect(JSON.stringify(started)).not.toContain('test-secret-value');
      const child = internals.runtime.getAgentSession(started.agentId)!;
      expect(child.parentSessionId).toBe(parent.id);
      expect(child.modelId).toBe('gpt-5.3-codex');
      expect(child.effort).toBe('medium');
      expect(internals.goalRuntime.get(child.id)?.objective).toBe('Complete the child task');
      const run = internals.runtime.activeSessionRun(child.id)!;
      expect(run.suppressNotifications).toBe(true);
      expect(
        await internals.agentNetworkService.wait(actor, {
          agentId: child.id,
          waitMs: 0
        })
      ).toMatchObject({ agentId: child.id, runId: run.id, waitOutcome: 'snapshot' });
      await vi.waitFor(() => expect(internals.runtime.currentExecutionId(run.id)).toBeTruthy());
      const executionId = internals.runtime.currentExecutionId(run.id)!;
      expect(executionId).toBeTruthy();
      internals.emitRunEvent(executionId, 'conversation.item', {
        itemId: 'child-progress',
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: { text: 'child progress' }
      });
      expect((await observations.collect(new AbortController().signal))[0]?.content).toContain(
        'child progress'
      );
      expect(
        await internals.agentNetworkService.wait(actor, {
          agentId: child.id,
          waitFor: 'message',
          waitMs: 0
        })
      ).toMatchObject({ agentId: child.id, executionId, waitOutcome: 'snapshot' });
      expect(
        await internals.agentNetworkService.send(actor, {
          agentId: child.id,
          content: 'Continue later',
          deliveryIntent: 'QUEUE'
        })
      ).toMatchObject({ message: { status: 'accepted' } });
      expect(
        internals.runtime
          .sessionQueue(child.id)
          .itemIds.some((id) =>
            internals.runtime.getQueueItem(id)?.content.includes('Continue later')
          )
      ).toBe(true);
      const queued = internals.runtime
        .sessionQueue(child.id)
        .itemIds.map((id) => internals.runtime.getQueueItem(id))
        .find((item) => item?.content.includes('Continue later'));
      expect(queued?.suppressNotifications).toBe(true);
      expect(await internals.agentNetworkService.stop(actor, { agentId: child.id })).toMatchObject({
        agentId: child.id,
        cancel: { status: 'accepted' }
      });
      expect(internals.goalRuntime.get(child.id)).toBeUndefined();
      await vi.waitFor(() => {
        expect(internals.runtime.executionSnapshot(executionId)?.status).toMatch(
          /INTERRUPTED|CANCELLED/
        );
      });
      expect(
        await internals.agentNetworkService.wait(actor, {
          agentId: child.id,
          waitMs: 1_000
        })
      ).toMatchObject({ agentId: child.id, executionId, waitOutcome: 'completion' });
      await vi.waitFor(() => {
        expect(internals.runtime.activeSessionRun(child.id)).toBeUndefined();
      });
      expect(await internals.agentNetworkService.stop(actor, { agentId: child.id })).toMatchObject({
        agentId: child.id,
        cancel: { status: 'idle', result: { status: 'IDLE' } },
        goal: { status: 'unchanged' }
      });
    } finally {
      observations.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('admits more than sixteen created and active direct children without a Subagent package quota', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-network-fanout-'));
    const database = new NodeDatabase(':memory:', 'network-fanout');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: false,
      database,
      fakeRunner: new FakeRunner(),
      fakeScript: () => [{ type: 'long-running' }],
      capabilities: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: true, version: 'codex-cli 0.147.0' },
        claudeCode: { available: false }
      }
    });
    const internals = connector as unknown as {
      runtime: NodeRuntimeState;
      agentNetworkService: AgentNetworkService;
      agentNetworkObservations: AgentNetworkObservations;
    };
    const parent = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'fanout-parent',
      modelId: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const observations = internals.agentNetworkObservations.attach(parent.id);
    try {
      const actor = { sessionId: parent.id, requestUserId: 7 };
      const children: string[] = [];
      for (let index = 0; index < 17; index++) {
        const result = (await internals.agentNetworkService.start(actor, {
          content: `child ${index}`
        })) as { agentId: string };
        children.push(result.agentId);
      }
      expect(new Set(children).size).toBe(17);
      for (const id of children) {
        expect(internals.runtime.getAgentSession(id)?.parentSessionId).toBe(parent.id);
        expect(internals.runtime.activeSessionRun(id)).toBeDefined();
      }
      await vi.waitFor(() => {
        for (const id of children) {
          const run = internals.runtime.activeSessionRun(id)!;
          const executionId = internals.runtime.currentExecutionId(run.id);
          expect(executionId).toBeTruthy();
          expect(internals.runtime.executionSnapshot(executionId!)?.status).toBe('RUNNING');
        }
      });
    } finally {
      observations.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
