import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import * as executionPaths from '../../src/workspace/path-access.js';
import { FakeRunner } from '../../src/fake-runner.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { AgentNetworkService } from '../../src/service/agent-network-service.js';
import type { GoalRuntime } from '../../src/service/goal-runtime.js';
import {
  actorForApprovedAgentCall,
  actorForAuthenticatedTerminal
} from '../../src/service/agent-network-bindings.js';
import {
  agentNetworkExecutionCommand,
  agentNetworkInvoke
} from '../../src/service/agent-network-invoke.js';
import type { ContinuousRunCoordinator } from '../../src/service/continuous-run-coordinator.js';
import {
  SESSION_CONTEXT_PROVIDER,
  type ExtensionOperationContext
} from '@myagentroam/agent/extensions';
import { agentNetworkExtension } from '../../src/runner/mar-agent/agent-network-extension.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent
} from '../../src/service/agent-network-observations.js';
import { waitForAgentTargets } from '../../src/service/agent-network-wait.js';
import { NodeRequestService } from '../../src/service/node-request-service.js';
import { createEnvelope } from '@myagentroam/protocol';
import { LocalAgentHost } from '../../../mar-agent/dist/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../../mar-agent/dist/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/dist/sdk/agent.js';
import type { ModelEvent, ModelRequest } from '../../../mar-agent/dist/model/contracts.js';

describe('Node Agent Network owner integration', () => {
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
                patch: '*** Begin Patch\n*** Add File: changed.txt\n+content\n*** End Patch'
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
      parent.close();
    } finally {
      await agent.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      action: 'start' as const,
      operation: 'START',
      input: {
        title: 'Image task',
        attachments: [{ name: 'picture.png', mime: 'image/png', dataBase64: 'secret-image' }]
      }
    },
    {
      action: 'send' as const,
      operation: 'MESSAGE',
      input: { agentId: 'child', approval: { approvalId: 'approval-1', decision: 'approve' } }
    },
    {
      action: 'stop' as const,
      operation: 'CANCEL',
      input: { agentId: 'child', executionId: 'execution-1' }
    }
  ])(
    'projects real SDK $action events without leaking the result or image',
    async ({ action, operation, input }) => {
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
        codeMode: false,
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
          extensions: [agentNetworkExtension(invoke, () => 'execution')]
        },
        () => ({
          configuration,
          async *start(): AsyncIterable<ModelEvent> {
            if (requests++ === 0) {
              yield {
                type: 'client_tool.call',
                callId: 'call',
                name: `agent_${action}`,
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
        const run = session.run({ prompt: 'test public projection' });
        const normalizer = new MarAgentConversationNormalizer();
        const events = [];
        const items = [];
        for await (const event of run) {
          events.push(event);
          items.push(...normalizer.normalize(event));
        }
        expect(await run.result()).toMatchObject({ status: 'completed' });
        expect(invoke).toHaveBeenCalledWith('execution', action, input, expect.anything());
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            toolName: `agent_${action}`,
            data: { agentId: 'child', productSessionId: 'child' },
            summary: '{"agentId":"child","productSessionId":"child"}'
          })
        );
        expect(items).toContainEqual(
          expect.objectContaining({
            status: 'COMPLETED',
            payload: expect.objectContaining({
              subagentOperation: operation,
              subagentId: 'child',
              subagentSessionId: 'child'
            })
          })
        );
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
        expect(JSON.stringify({ events, items, history })).not.toMatch(
          /secret-image|secret-result/
        );
      } finally {
        await agent.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('keeps invalid image input and unknown fields out of failed events and public history', async () => {
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
    let requests = 0;
    const invoke = vi.fn();
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: directory, workspace: directory }),
        models: [configuration],
        extensions: [agentNetworkExtension(invoke, () => 'execution')]
      },
      () => ({
        configuration,
        async *start(): AsyncIterable<ModelEvent> {
          if (requests++ === 0) {
            yield {
              type: 'client_tool.call',
              callId: 'call',
              name: 'agent_start',
              arguments: {
                attachments: [{ name: 42, mime: 'image/png', dataBase64: 'secret-image' }],
                secret: 'secret-extra'
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
        expect.objectContaining({ type: 'tool.failed', toolName: 'agent_start' })
      );
      expect(
        JSON.stringify({ events, items, history: await agent.sessionHistory(session.id) })
      ).not.toMatch(/secret-image|secret-extra/);
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
        extensions: [agentNetworkExtension(invoke, () => 'execution')]
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
        expect.anything()
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
      model: 'gpt-5.3-codex',
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
      await expect(
        invoke(executionId, 'list', { scope: 'children' }, context)
      ).resolves.toMatchObject({
        sessions: []
      });
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
        input: { scope: 'children' },
        __requestUserId: 7,
        __marctlCaller: { type: 'execution', sessionId: callerSessionId, executionId }
      };
      expect(await command(request)).toMatchObject({
        sessions: [expect.objectContaining({ id: created.agentId })]
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
        command({ ...terminal, action: 'list', input: { scope: 'profile' } })
      ).rejects.toThrow('RUNNER_REQUIRED');
      expect(
        await command({
          ...terminal,
          action: 'list',
          input: { scope: 'children', agentId: parent.id }
        })
      ).toMatchObject({ sessions: [expect.objectContaining({ id: created.agentId })] });
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
      await expect(
        invoke(childExecutionId, 'list', { scope: 'children' }, context)
      ).rejects.toThrow('AGENT_ACTOR_NOT_ACTIVE');
      const childInvoke = agentNetworkInvoke({
        sessionId: created.agentId,
        runtime: core.runtime,
        coordinator: core.continuousRunCoordinator,
        service: core.agentNetworkService
      });
      await expect(
        childInvoke(
          childExecutionId,
          'send',
          { agentId: parent.id, content: 'unsafe replacement', deliveryIntent: 'REPLACE_CURRENT' },
          context
        )
      ).rejects.toThrow();
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
      expect(observer.capture(created.agentId, childExecutionId)?.updates).toContainEqual(
        expect.objectContaining({
          kind: 'message',
          value: expect.stringContaining('upward report')
        })
      );
      expect(core.agentNetworkObservations.get(created.agentId)).toBeUndefined();
      observer.capture(created.agentId, childExecutionId)?.acknowledge();
      observer.close();
      await expect(
        childInvoke(
          childExecutionId,
          'send',
          { agentId: parent.id, content: 'cold report' },
          context
        )
      ).rejects.toThrow('AGENT_PARENT_NOT_WARM');
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
        await invoke(
          executionId,
          'stop',
          { agentId: created.agentId, executionId: childExecutionId },
          context
        )
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
      model: 'gpt-5.3-codex',
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
            model: 'eligible',
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
      const profile = await request(
        'list',
        { scope: 'profile', runner: 'mar-agent' },
        {
          marAgentModels: [
            modelSummary,
            { ...modelSummary, id: 'disabled', enabled: false },
            { ...modelSummary, id: 'no-conversation', conversationModel: false },
            { ...modelSummary, id: 'no-subagent', subagentModel: false }
          ]
        }
      );
      expect(profile.models).toEqual([expect.objectContaining({ id: 'eligible' })]);
      expect(JSON.stringify(profile)).not.toContain('fixture-only');
      expect(JSON.stringify(profile)).not.toContain('unauthorized');
      const started = await request('start', {
        runner: 'mar-agent',
        model: 'eligible',
        title: 'Child',
        content: 'first',
        clientMessageId: 'cross-start'
      });
      expect(typeof started.agentId).toBe('string');
      const childId = started.agentId as string;
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          __marctlOrigin: { sessionId: parent.id, name: 'Parent title' }
        })
      );
      expect(core.runtime.getAgentSession(childId)).toMatchObject({
        parentSessionId: parent.id,
        runner: 'mar-agent',
        model: 'eligible'
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

  it('reports to a warm idle parent without starting it and rejects a cold parent', async () => {
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
      externalSessionId: 'idle-parent',
      model: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const child = core.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'active-child',
      parentSessionId: parent.id,
      model: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const observer = core.agentNetworkObservations.attach(parent.id);
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
      expect(
        await invoke(executionId, 'send', { agentId: parent.id, content: 'idle report' }, context)
      ).toMatchObject({ message: { status: 'accepted', result: { delivery: 'reported' } } });
      expect(core.runtime.activeSessionRun(parent.id)).toBeUndefined();
      expect(observer.wake.pending()).toBe(false);
      expect(observer.capture(child.id, executionId)?.updates).toContainEqual(
        expect.objectContaining({ value: expect.stringContaining('idle report') })
      );
      observer.close();
      await expect(
        invoke(executionId, 'send', { agentId: parent.id, content: 'cold report' }, context)
      ).rejects.toThrow('AGENT_PARENT_NOT_WARM');
      expect(core.runtime.activeSessionRun(parent.id)).toBeUndefined();
      expect(core.agentNetworkObservations.get(parent.id)).toBeUndefined();
    } finally {
      observer.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['start', 'inline'],
    ['start', 'reference'],
    ['send', 'inline'],
    ['send', 'reference']
  ] as const)(
    'passes an image-only %s with %s from a native model tool to the Node owner',
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
        model: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED'
      });
      const child = internals.runtime.createAgentSession({
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: workspace.path,
        externalSessionId: 'image-child',
        parentSessionId: parent.id,
        model: 'gpt-5.3-codex',
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
          extensions: [agentNetworkExtension(delivered, () => 'execution')]
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
        const result = await session.run({ prompt: 'Send the image.' }).result();
        expect(result.status).toBe('completed');
        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered.mock.calls[0]?.[2]).toMatchObject(
          kind === 'inline' ? { attachments: [image] } : { attachmentIds: [attachmentId] }
        );
        const receipt = await delivered.mock.results[0]!.value;
        expect(receipt).toMatchObject(
          action === 'start'
            ? { agentId: expect.any(String) }
            : { agentId: child.id, message: { status: 'accepted' } }
        );
        if (kind === 'inline')
          expect(persist).toHaveBeenCalledWith(workspace.id, expect.any(String), [image]);
      } finally {
        await agent.dispose();
        observer.close();
        await connector.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it('rejects sibling and independent control, and rejects a child owned by another user', async () => {
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
        model: 'gpt-5.3-codex',
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
      for (const target of [sibling, independent]) {
        await expect(
          internals.agentNetworkService.send(actor, { agentId: target.id, content: 'message' })
        ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
        await expect(
          internals.agentNetworkService.send(actor, {
            agentId: target.id,
            goal: { objective: 'goal' }
          })
        ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
        await expect(
          internals.agentNetworkService.stop(actor, {
            agentId: target.id,
            executionId: 'execution'
          })
        ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      }
      const approvedContext = { permission: { decision: 'approved' } } as ExtensionOperationContext;
      const approved = actorForApprovedAgentCall(actor, approvedContext, [sibling.id], ['goal']);
      expect(
        await internals.agentNetworkService.send(approved, {
          agentId: sibling.id,
          goal: { clear: true }
        })
      ).toMatchObject({ goal: { status: 'applied' } });
      await expect(
        internals.agentNetworkService.send(approved, {
          agentId: sibling.id,
          content: 'not approved'
        })
      ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      await expect(
        internals.agentNetworkService.send(approved, {
          agentId: independent.id,
          goal: { clear: true }
        })
      ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      const noApproval = actorForApprovedAgentCall(
        actor,
        {} as ExtensionOperationContext,
        [sibling.id],
        ['goal']
      );
      await expect(
        internals.agentNetworkService.send(noApproval, {
          agentId: sibling.id,
          goal: { clear: true }
        })
      ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      expect(
        await internals.agentNetworkService.send(actor, {
          agentId: child.id,
          goal: { clear: true }
        })
      ).toMatchObject({ goal: { status: 'applied' } });
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
        internals.agentNetworkService.stop(actor, { agentId: child.id, executionId: 'execution' })
      ).rejects.toThrow('RUN_OWNED_BY_ANOTHER_USER');
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

  it('decides only live direct-child approvals through the existing Run owner', async () => {
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
        model: 'gpt-5.3-codex',
        effort: 'medium',
        nativeControl: 'MAR_MANAGED',
        ...(parentSessionId ? { parentSessionId } : {})
      });
    const root = create('approval-root');
    const parent = create('approval-parent', root.id);
    const sibling = create('approval-sibling', root.id);
    const child = create('approval-child', parent.id);
    const observer = internals.agentNetworkObservations.attach(parent.id);
    const terminalObserver = internals.agentNetworkObservations.attach('terminal-observer');
    const actor = { sessionId: parent.id, requestUserId: 7 };
    const active = (sessionId: string, id: string) => {
      const run = internals.runtime.createMessageRun({
        sessionId,
        clientMessageId: id,
        content: 'work',
        initiatedByUserId: 7
      }).run;
      const execution = internals.runtime.createExecution(run.id);
      internals.runtime.transitionRun(run.id, 'RUNNING');
      internals.runtime.createApproval({
        runId: execution.id,
        approvalId: id,
        expiresAt: Date.now() + 60_000,
        payload: { toolName: 'exec', input: 'PRIVATE_INPUT' }
      });
      return { run, execution };
    };
    try {
      active(child.id, 'child-approval');
      active(sibling.id, 'sibling-approval');
      active(root.id, 'root-approval');
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
      for (const [agentId, approvalId] of [
        [sibling.id, 'sibling-approval'],
        [root.id, 'root-approval']
      ] as const)
        await expect(
          internals.agentNetworkService.send(actor, {
            agentId,
            approval: { approvalId, decision: 'approve' }
          })
        ).rejects.toThrow('AGENT_TARGET_NOT_AUTHORIZED');
      expect(observer.observes(sibling.id)).toBe(false);
      expect(observer.observes(root.id)).toBe(false);
      internals.agentNetworkObservations.publishChild({
        parentId: root.id,
        childId: sibling.id,
        runId: 'other-run',
        executionId: 'other-execution',
        kind: 'message',
        value: 'unrelated'
      });
      expect(observer.capture(sibling.id)).toBeUndefined();
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
      expect(
        await internals.agentNetworkService.send(terminal, {
          agentId: root.id,
          approval: { approvalId: 'root-approval', decision: 'reject' }
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
      model: 'gpt-5.3-codex',
      effort: 'medium',
      nativeControl: 'MAR_MANAGED'
    });
    const child = internals.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: workspace.path,
      externalSessionId: 'idle-child',
      parentSessionId: parent.id,
      model: 'gpt-5.3-codex',
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
        messageContent: 'The single body'
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
      model: 'gpt-5.3-codex',
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
      model: 'parent-non-default',
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
      expect(child.model).toBe('gpt-5.3-codex');
      expect(child.effort).toBe('medium');
      expect(internals.goalRuntime.get(child.id)?.objective).toBe('Complete the child task');
      const run = internals.runtime.activeSessionRun(child.id)!;
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
      expect(
        await internals.agentNetworkService.stop(actor, { agentId: child.id, executionId })
      ).toMatchObject({ agentId: child.id, cancel: { status: 'accepted' } });
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
      model: 'gpt-5.3-codex',
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
