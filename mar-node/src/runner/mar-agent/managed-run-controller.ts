import {
  marAgentEnvelopeInput,
  resolveMarAgentExecutionInput,
  type MarAgentExecutionInput
} from './execution-input.js';
export { resolveRunModels } from './execution-input.js';
import type { ResolvedMcpServer } from '../../mcp/model.js';
import type { RunnerExecutionStatus } from '../contracts.js';
import { NODE_MCP, NODE_COMPUTER_WAIT_TOOL_NAME } from '../../mcp/naming.js';
import { computerUseHostSkill } from './computer-use-skill.js';
import { marctlExecutionEnvironment, marctlHostSkill } from './marctl-skill.js';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { nodeLog } from '../../operational.js';
import {
  createAgent,
  generateSessionTitle,
  type ExecutionResult,
  type ToolApprovalRequest,
  type ToolApprovalDecision,
  type AgentEvent,
  type RunInput
} from '@myagentroam/agent';
import type { LocalAgentExecutionMcpBinding } from '@myagentroam/agent/host';
import {
  marAgentReasoningEffortSchema,
  resolveMarAgentDefaultReasoningEffort,
  type MarAgentRuntimeModelConfiguration,
  type NodeEnvelope
} from '@myagentroam/protocol';
import type { RunnerCommandDescriptor, RunnerCommandState } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../../session/contracts.js';
import { boundedConversationItemId } from '../normalization.js';
import { MarAgentRunner } from '../mar-agent-runner.js';
import { parseSecretEnvironment } from '../../mcp/secret-environment.js';
import type { RunnerCommandContext } from '../contracts.js';
import { MarAgentMcpClientCache, type MarAgentMcpClientLease } from './mcp-client-pool.js';
import {
  MarAgentConversationNormalizer,
  normalizeMarAgentUsage,
  type MarAgentGeneratedImageArtifact
} from './conversation-normalizer.js';
import { parseRunnerImageAttachments } from '../../session/attachments.js';
import { runnerErrorProjection } from '../runner-error.js';
import {
  MarAgentRuntimeModelFactory,
  sdkModelConfigurations,
  closeImageCredentialProviders,
  type MarAgentRuntimeModel
} from './runtime-model-factory.js';
import { createImageGenerationExtensions } from './image-generation-extensions.js';
import { createWebToolsExtensions } from './web-tools-extensions.js';
import { combineExecutionExtensions } from './execution-extensions.js';
import { webSessionScope, type WebFetchHandler } from '../../service/web-fetch-contracts.js';
import {
  MarAgentSessionRuntimeRegistry,
  type MarAgentRuntimeUse
} from './session-runtime-registry.js';
import { isExecutionScopedMcp, type MarAgentSessionRuntime } from './session-runtime.js';
import type { ComputerUseExecutionBinding, ComputerUseExecutionProvider } from './computer-use.js';

interface MarAgentRunHost {
  createApproval?(input: {
    runId: string;
    approvalId: string;
    payload: unknown;
    expiresAt: number;
  }): unknown;
  publishApproval?(input: {
    runId: string;
    approvalId: string;
    payload: unknown;
    expiresAt: number;
  }): void;
  isExecutionActive(runId: string): boolean;
  executionAccepted(runId: string): void;
  adopt(input: {
    runId: string;
    sessionId: string;
    runner: 'mar-agent';
    cwd: string;
    externalSessionId?: string;
  }): void;
  promote(sessionId: string, nativeSessionId: string): void;
  customTitle?(sessionId: string): string | null | undefined;
  syncTitle(nativeSessionId: string, cwd: string): Promise<void>;
  emit(
    runId: string,
    eventType: string,
    payload: unknown,
    status?: 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  ): void;
  emitItem(
    runId: string,
    item: {
      itemId: string;
      kind:
        | 'user_message'
        | 'assistant_message'
        | 'command_execution'
        | 'file_change'
        | 'tool_call'
        | 'plan'
        | 'todo_list'
        | 'context_compaction'
        | 'reasoning'
        | 'user_input_request'
        | 'error';
      status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
      payload: Record<string, unknown>;
      permissionStop?: NonNullable<ExecutionResult['permissionStop']>;
      merge?: boolean;
    }
  ): void;
  refreshContext?(runId: string): void;
  run(runId: string): unknown;
  commandState(sessionId: string, commandId: string): RunnerCommandState | undefined;
  setCommandState(sessionId: string, state: RunnerCommandState): void;
  clearCommandState(sessionId: string, commandId: string): void;
  commandStates(sessionId: string): readonly RunnerCommandState[];
  webSearch(
    input: { query: string; maxResults: number },
    signal: AbortSignal
  ): Promise<import('@myagentroam/agent').ToolExecutionResult>;
  webFetch?: WebFetchHandler;
  registerGeneratedImages?(
    runId: string,
    sessionId: string,
    images: readonly MarAgentGeneratedImageArtifact[]
  ): readonly Record<string, unknown>[];
}

interface PendingInteraction<T> {
  readonly runId: string;
  readonly resolve: (value: T) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

interface MarAgentManagedRunControllerOptions {
  readonly resourceIdleTtlMs?: number;
  readonly retainEnvironment?: (environment: Readonly<Record<string, string>>) => () => void;
  readonly createAgent?: typeof createAgent;
  readonly modelFactory?: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly computerUse?: ComputerUseExecutionProvider;
  readonly generateTitle?: typeof generateSessionTitle;
  readonly publishModelResource?: import('./session-runtime.js').NodeModelResourcePublisher;
  readonly attachNetworkContext?: import('./session-runtime.js').MarAgentRuntimeResources['attachNetworkContext'];
}

export class MarAgentManagedRunController {
  readonly #mcpClients = new MarAgentMcpClientCache();
  readonly #executions = new Map<
    string,
    { cancel(): void; cancelTitle(): void; settled: Promise<void> }
  >();
  readonly #steerTargets = new Map<
    string,
    (
      input: import('../contracts.js').RunnerSteerInput
    ) => Promise<import('../contracts.js').RunnerSteerResult>
  >();
  readonly #runtimes: MarAgentSessionRuntimeRegistry;
  readonly #questions = new Map<string, PendingInteraction<Record<string, unknown>>>();
  readonly #approvals = new Map<
    string,
    {
      readonly runId: string;
      readonly resolve: (decision: ToolApprovalDecision) => void;
      readonly cleanup: () => void;
    }
  >();
  readonly #normalizers = new Map<string, MarAgentConversationNormalizer>();
  readonly #computerUse: ComputerUseExecutionProvider | undefined;
  readonly #generateTitle: typeof generateSessionTitle;
  #disposePromise?: Promise<void>;
  #disposed = false;
  constructor(
    private readonly runner: MarAgentRunner,
    private readonly host: MarAgentRunHost,
    options: MarAgentManagedRunControllerOptions = {}
  ) {
    this.#runtimes = new MarAgentSessionRuntimeRegistry(
      {
        mcpClients: this.#mcpClients,
        resourceIdleTtlMs: options.resourceIdleTtlMs ?? 10 * 60_000,
        ...(options.retainEnvironment === undefined
          ? {}
          : { retainEnvironment: options.retainEnvironment }),
        createAgent: options.createAgent ?? createAgent,
        modelFactory:
          options.modelFactory ??
          new MarAgentRuntimeModelFactory({
            resolve: async () => {
              throw new Error('MAR_AGENT_RUNTIME_CREDENTIALS_UNSUPPORTED');
            }
          }),
        customTitle: (sessionId) => this.host.customTitle?.(sessionId) ?? undefined,
        ...(options.attachNetworkContext === undefined
          ? {}
          : {
              attachNetworkContext: options.attachNetworkContext
            }),
        modelUsage: (runId, usage) =>
          this.host.emit(runId, 'run.usage', normalizeMarAgentUsage(usage)),
        publishModelResource: options.publishModelResource!,
        question: (runId, request, signal) => this.requestQuestion(runId, request, signal),
        ...(this.host.createApproval && this.host.publishApproval
          ? {
              approval: (runId: string, request: ToolApprovalRequest, signal: AbortSignal) =>
                this.requestApproval(runId, request, signal)
            }
          : {})
      },
      (sessionId, nativeId) => this.host.promote(sessionId, nativeId),
      async (sessionId) => {
        await this.#computerUse?.releaseSession(sessionId);
      }
    );
    this.#computerUse = options.computerUse;
    this.#generateTitle = options.generateTitle ?? generateSessionTitle;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = Promise.resolve().then(async () => {
      for (const execution of this.#executions.values()) {
        execution.cancelTitle();
        execution.cancel();
      }
      const results = await Promise.allSettled([
        this.#runtimes.dispose(),
        ...[...this.#executions.values()].map((execution) => execution.settled)
      ]);
      results.push(...(await Promise.allSettled([this.#mcpClients.close()])));
      results.push(...(await Promise.allSettled([this.#computerUse?.dispose()])));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.#disposePromise;
  }

  releaseSession(sessionId: string): Promise<void> {
    return this.#runtimes.releaseSession(sessionId);
  }

  async executeCommand(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: RunnerCommandContext
  ): Promise<unknown> {
    if (command.id === 'plan') {
      const current = this.host.commandState(session.id, 'plan');
      if (current?.active) this.host.clearCommandState(session.id, 'plan');
      else
        this.host.setCommandState(session.id, {
          commandId: 'plan',
          active: true,
          label: 'Plan Mode',
          detail: 'Subsequent messages run in read-only Plan Mode.',
          closable: true,
          closeInput: '/plan',
          continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
        });
      return { command: command.id, states: this.host.commandStates(session.id) };
    }
    if (command.id !== 'compact') throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    if (session.externalSessionId === null || session.nativeControl !== 'MAR_MANAGED')
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const execution = context.executionContext;
    const resolved = resolveMarAgentExecutionInput(
      execution?.runner === 'mar-agent'
        ? (execution.runnerInput as MarAgentExecutionInput | undefined)
        : undefined,
      session.modelId ?? ''
    );
    if (resolved === undefined) throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const runId = randomUUID();
    void this.run({
      runId,
      sessionId: session.id,
      input,
      cwd: session.cwd,
      ...resolved,
      effort: session.effort ?? '',
      mode: command.id,
      secretEnvironment: context.secretEnvironment,
      externalSessionId: session.externalSessionId,
      mcpServers: this.#resolveMcpServers(context.mcpInstallations, context.secretEnvironment),
      images: [],
      ...(context.initiatedByUserId === undefined
        ? {}
        : { initiatedByUserId: context.initiatedByUserId })
    });
    return {
      command: command.id,
      run: this.host.run(runId),
      states: this.host.commandStates(session.id)
    };
  }

  steer(
    input: import('../contracts.js').RunnerSteerInput
  ): Promise<import('../contracts.js').RunnerSteerResult> {
    return (
      this.#steerTargets.get(input.expectedExecutionId)?.(input) ??
      Promise.resolve({ status: 'notAccepted' })
    );
  }

  start(envelope: NodeEnvelope): void {
    const payload = envelope.payload as Record<string, unknown>;
    if (
      payload.runner !== 'mar-agent' ||
      typeof payload.runId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.input !== 'string' ||
      typeof payload.cwd !== 'string' ||
      typeof payload.model !== 'string' ||
      this.host.isExecutionActive(payload.runId)
    )
      return;
    const resolved = resolveMarAgentExecutionInput(marAgentEnvelopeInput(payload), payload.model);
    if (resolved === undefined) {
      this.host.emit(
        payload.runId,
        'run.rejected',
        { code: 'MAR_AGENT_MODEL_CONFIG_INVALID' },
        'FAILED'
      );
      return;
    }
    let mcpServers: readonly import('../../mcp/model.js').ResolvedMcpServer[];
    let images: ReturnType<typeof parseRunnerImageAttachments>;
    let secretEnvironment: Readonly<Record<string, string>>;
    try {
      secretEnvironment = parseSecretEnvironment(payload.secretEnvironment);
      mcpServers = this.#resolveMcpServers(
        payload.mcpInstallations,
        {
          ...secretEnvironment,
          MAR_USERNAME: secretEnvironment['MAR_USERNAME'] ?? ''
        },
        payload.executionMcpServers as readonly ResolvedMcpServer[] | undefined
      );
      images = parseRunnerImageAttachments(payload.attachments);
    } catch {
      this.host.emit(
        payload.runId,
        'run.rejected',
        { code: 'MAR_AGENT_MCP_CONFIG_INVALID' },
        'FAILED'
      );
      return;
    }
    void this.run({
      runId: payload.runId,
      sessionId: payload.sessionId,
      input: payload.input,
      secretEnvironment,
      cwd: payload.cwd,
      ...resolved,
      effort: typeof payload.effort === 'string' ? payload.effort : '',
      ...(payload.access === undefined ? {} : { access: payload.access }),
      mode: payload.collaborationMode === 'plan' ? 'plan' : 'run',
      mcpServers,
      images: images.map((image) => ({
        name: image.name,
        mimeType: image.mime,
        dataBase64: image.dataBase64
      })),
      ...(typeof payload.clientMessageId === 'string'
        ? { clientMessageId: payload.clientMessageId }
        : {}),
      ...(typeof payload.externalSessionId === 'string'
        ? { externalSessionId: payload.externalSessionId }
        : {}),
      ...(typeof payload.personalInstructions === 'string'
        ? { personalInstructions: payload.personalInstructions }
        : {}),
      computerUseEnabled: payload.computerUse === true
    });
  }

  cancel(runId: string, intent: 'CANCEL' | 'INTERRUPT'): boolean {
    const execution = this.#executions.get(runId);
    if (!execution) return false;
    execution.cancel();
    this.host.emit(runId, 'run.cancelling', { intent });
    return true;
  }
  respondUserInput(runId: string, requestId: string, answers: Record<string, unknown>): boolean {
    const pending = this.#questions.get(requestId);
    if (!pending || pending.runId !== runId) return false;
    clearTimeout(pending.timer);
    pending.cleanup();
    this.#questions.delete(requestId);
    pending.resolve(
      Object.fromEntries(
        Object.entries(answers).map(([id, answer]) => [
          id,
          Array.isArray(answer) && answer.length === 1 ? answer[0] : answer
        ])
      )
    );
    return true;
  }

  private async run(input: {
    runId: string;
    sessionId: string;
    input: string;
    cwd: string;
    model: MarAgentRuntimeModelConfiguration;
    models: MarAgentRuntimeModelConfiguration[];
    compact?: unknown;
    runtimeScopeId?: string;
    effort: string;
    access?: unknown;
    mode: 'run' | 'plan' | 'compact';
    secretEnvironment?: Readonly<Record<string, string>>;
    externalSessionId?: string;
    personalInstructions?: string;
    mcpServers: readonly import('../../mcp/model.js').ResolvedMcpServer[];
    images: readonly { name: string; mimeType: string; dataBase64: string }[];
    clientMessageId?: string;
    initiatedByUserId?: number;
    computerUseEnabled?: boolean;
  }) {
    const controller = new AbortController();
    const titleController = new AbortController();
    let cancelExecution: (() => void) | undefined;
    // Own cancellation before any asynchronous preparation, not only after SDK admission.
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const execution = {
      cancel: () => {
        if (controller.signal.aborted) return;
        controller.abort();
        cancelExecution?.();
      },
      cancelTitle: () => titleController.abort(),
      settled
    };
    this.#executions.set(input.runId, execution);
    let runtime: MarAgentSessionRuntime | undefined;
    let use: MarAgentRuntimeUse | undefined;
    let terminalEvent:
      | {
          readonly eventType: string;
          readonly payload: unknown;
          readonly status: RunnerExecutionStatus;
        }
      | undefined;
    let executionMcpLease: MarAgentMcpClientLease | undefined;
    let executionMcpBinding: LocalAgentExecutionMcpBinding | undefined;
    let computerUseBinding: ComputerUseExecutionBinding | undefined;
    let executionModels: readonly MarAgentRuntimeModel[] = [];
    let titleTask: Promise<string | undefined> | undefined;
    let cancelledDuringPreparation = false;
    try {
      this.host.executionAccepted(input.runId);
      this.host.adopt({
        runId: input.runId,
        sessionId: input.sessionId,
        runner: 'mar-agent',
        cwd: input.cwd,
        ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
        ...(input.initiatedByUserId === undefined
          ? {}
          : { initiatedByUserId: input.initiatedByUserId })
      });
      this.host.emit(input.runId, 'run.started', {}, 'STARTING');
      if (this.#disposed) throw new Error('MAR_AGENT_RUN_CONTROLLER_DISPOSED');
      controller.signal.throwIfAborted();
      use = await this.#runtimes.acquire(input, {
        runId: input.runId,
        signal: controller.signal,
        cancel: () => {
          titleController.abort();
          execution.cancel();
        },
        settled
      });
      runtime = use.runtime;
      executionModels = runtime.models;
      use.assertUsable();
      await runtime.mcpLease.pool.refreshForExecution();
      use.assertUsable();
      const marctlSkill = marctlHostSkill(input.secretEnvironment);
      const executionMcpServers = input.mcpServers
        .filter(isExecutionScopedMcp)
        .filter((server) => marctlSkill === undefined || server.name !== NODE_MCP.schedule.name)
        .map((server) => ({ ...server, lifecycle: 'EXECUTION' as const }));
      computerUseBinding = await this.#computerUse?.bind({
        runId: input.runId,
        sessionId: runtime.session.id,
        mode: input.mode,
        enabled: input.computerUseEnabled === true,
        signal: controller.signal,
        modelSupportsImages: input.model.inputCapabilities.includes('IMAGE')
      });
      use.assertUsable();
      if (executionMcpServers.length > 0) {
        executionMcpLease = await this.#mcpClients.acquire(executionMcpServers, input.cwd, {
          reusable: false,
          authorizationScope: runtime.session.id
        });
      }
      use.assertUsable();
      const userTools = executionMcpLease?.pool.definitions() ?? [];
      const nodeTools = computerUseBinding?.tools ?? [];
      if (userTools.some((tool) => tool.name.startsWith('mcp__mar_computer__')))
        throw new Error('MAR_AGENT_MCP_RESERVED_NAMESPACE');
      if (
        new Set([...userTools, ...nodeTools].map((tool) => tool.name)).size !==
        userTools.length + nodeTools.length
      )
        throw new Error('MAR_AGENT_MCP_TOOL_NAMES_CONFLICT');
      const imageExtensions = createImageGenerationExtensions({
        configuration: executionModels.find((model) => model.id === input.model.id)
          ?.imageGeneration,
        homeDirectory: homedir(),
        host: () => runtime!.host
      });
      const extensions = combineExecutionExtensions(
        imageExtensions,
        createWebToolsExtensions({
          enabled: true,
          hostedSearchModelIds: executionModels
            .filter((model) => model.hostedWebSearch)
            .map((model) => model.id),
          hostedWebSearch:
            executionModels.find((model) => model.id === input.model.id)?.hostedWebSearch ?? false,
          webSearch: (request, signal) => this.host.webSearch(request, signal),
          ...(this.host.webFetch === undefined
            ? {}
            : {
                webFetch: (request, signal, sessionId) =>
                  this.host.webFetch!(
                    request,
                    signal,
                    webSessionScope('workspace', homedir(), sessionId)
                  )
              })
        })
      );
      executionMcpBinding = runtime.host.bindExecutionExtensions(
        {
          ...extensions,
          environment: marctlExecutionEnvironment(input.secretEnvironment),
          skills: [
            ...(extensions.skills ?? []),
            computerUseHostSkill,
            ...(marctlSkill === undefined ? [] : [marctlSkill])
          ]
        },
        {
          tools: [...nodeTools, ...userTools],
          catalog: () => {
            const external = executionMcpLease?.pool.catalog() ?? {
              revision: '',
              servers: [],
              tools: []
            };
            const computer = nodeTools.map((definition) => ({
              definition,
              serverId: NODE_MCP.computer.name,
              rawName:
                definition.name === NODE_COMPUTER_WAIT_TOOL_NAME
                  ? NODE_MCP.computer.tools.wait
                  : NODE_MCP.computer.tools.exec,
              sourceIdentity: `node:${input.runId}:computer`,
              definitionRevision: createHash('sha256')
                .update(JSON.stringify(definition))
                .digest('hex'),
              lifetime: 'execution' as const,
              exposure: 'direct' as const
            }));
            return {
              revision: `${external.revision}:${input.runId}`,
              servers: [
                ...external.servers,
                ...(computer.length
                  ? [{ id: NODE_MCP.computer.name, name: NODE_MCP.computer.name }]
                  : [])
              ],
              tools: [...external.tools, ...computer]
            };
          },
          call: async (call, signal, context) => {
            if (computerUseBinding?.tools.some((tool) => tool.name === call.name))
              return computerUseBinding.call(call, signal);
            if (executionMcpLease?.pool.definitions().some((tool) => tool.name === call.name))
              return executionMcpLease.pool.call(
                call.name,
                call.arguments,
                signal,
                context?.expectedTool
              );
            throw new Error('MAR_AGENT_MCP_TOOL_NOT_FOUND');
          }
        }
      );
      const session = runtime.session;
      const reasoningEffort = input.effort
        ? marAgentReasoningEffortSchema.parse(input.effort)
        : undefined;
      const runInput = {
        prompt: input.input,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        modelId: input.model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(input.mode === 'compact' || input.access === undefined || input.access === null
          ? {}
          : { permissionMode: input.access as NonNullable<RunInput['permissionMode']> }),
        images: input.images
      };
      const metadata =
        input.mode === 'compact' || !runtime.automaticTitleEnabled
          ? undefined
          : await runtime.agent.getSession(session.id).catch(() => undefined);
      use.assertUsable();
      const handle =
        input.mode === 'plan'
          ? session.plan({
              ...runInput
            })
          : input.mode === 'compact'
            ? session.compact(runInput)
            : session.run(runInput);
      cancelExecution = () => handle.cancel();
      const steerNormalizer = runtime.normalizer;
      if (input.mode !== 'compact')
        this.#steerTargets.set(input.runId, async (request) => {
          if (
            controller.signal.aborted ||
            (request.modelId && request.modelId !== input.model.id) ||
            (request.effort &&
              request.effort !==
                (reasoningEffort ??
                  resolveMarAgentDefaultReasoningEffort(
                    input.model.defaultReasoningEffort,
                    input.model.reasoningEfforts
                  ))) ||
            (request.access !== null && request.access !== (input.access ?? 'auto')) ||
            request.collaborationMode !== (input.mode === 'plan' ? 'plan' : 'default')
          )
            return { status: 'notAccepted' };
          const result = await session.steer({
            expectedExecutionId: handle.executionId,
            prompt: request.prompt,
            modelText: request.modelText,
            clientMessageId: request.clientMessageId,
            images: request.images
          });
          return result.status === 'accepted'
            ? { status: 'accepted', item: steerNormalizer.input(result.entry) }
            : result;
        });
      this.host.emit(input.runId, 'run.running', {}, 'RUNNING');
      const consumeEvents = async () => {
        for await (const event of handle) {
          if (event.type === 'execution.started' && metadata?.automaticTitlePending && !titleTask) {
            titleTask = this.#generateTitle({
              models: sdkModelConfigurations(executionModels),
              currentModelId: input.model.id,
              prompt: input.input,
              onModelUsage: (usage) =>
                this.host.emit(
                  input.runId,
                  'run.usage',
                  normalizeMarAgentUsage({
                    ...usage,
                    sessionId: session.id,
                    executionId: handle.executionId,
                    purpose: 'title',
                    agentRole: 'root'
                  })
                ),
              signal: titleController.signal
            }).catch((error) => {
              if (!titleController.signal.aborted)
                nodeLog('runner.mar-agent.title.failed', {
                  sessionId: session.id,
                  runId: input.runId,
                  stage: 'generate',
                  code: runnerErrorProjection(error, 'MAR_AGENT_TITLE_GENERATION_FAILED').code
                });
              return undefined;
            });
          }
          this.project(input.runId, event);
        }
      };
      const [eventsResult, executionResult] = await Promise.allSettled([
        consumeEvents(),
        (async () => handle.result())()
      ]);
      if (eventsResult.status === 'rejected') throw eventsResult.reason;
      if (executionResult.status === 'rejected') throw executionResult.reason;
      const result = executionResult.value;
      const title = await titleTask;
      if (title && !titleController.signal.aborted)
        await runtime.agent
          .setSessionTitle(session.id, title, {
            automatic: true,
            expectedTitle: metadata!.title,
            executionId: handle.executionId
          })
          .catch((error) => {
            nodeLog('runner.mar-agent.title.failed', {
              sessionId: session.id,
              runId: input.runId,
              stage: 'persist',
              code: runnerErrorProjection(error, 'MAR_AGENT_TITLE_PERSIST_FAILED').code
            });
          });
      await this.host.syncTitle(session.id, input.cwd);
      const permissionStop = result.status === 'completed' ? result.permissionStop : undefined;
      const status =
        permissionStop !== undefined
          ? 'INTERRUPTED'
          : result.status === 'completed'
            ? 'SUCCEEDED'
            : result.status === 'cancelled'
              ? 'CANCELLED'
              : 'FAILED';
      use?.terminal();
      terminalEvent = {
        eventType:
          status === 'SUCCEEDED'
            ? 'run.completed'
            : status === 'CANCELLED'
              ? 'run.cancelled'
              : status === 'FAILED'
                ? 'run.failed'
                : 'run.completed',
        payload: {
          status,
          ...(result.errorCode ? { code: result.errorCode } : {}),
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(permissionStop === undefined
            ? {}
            : {
                permissionStop,
                code:
                  permissionStop.action === 'ask'
                    ? 'MAR_AGENT_PERMISSION_ASK'
                    : 'MAR_AGENT_PERMISSION_DENIED',
                message: permissionStop.reason
              })
        },
        status
      };
    } catch (error) {
      if (terminalEvent !== undefined) {
        nodeLog('runner.mar-agent.run.cleanup_failed', {
          runId: input.runId,
          code: 'MAR_AGENT_RUN_CLEANUP_FAILED'
        });
      } else if (controller.signal.aborted && cancelExecution === undefined) {
        // Keep the Run owned until preparation and its resources actually settle.
        cancelledDuringPreparation = true;
      } else {
        use?.terminal();
        const projected = runnerErrorProjection(error, 'MAR_AGENT_RUN_FAILED');
        this.host.emitItem(input.runId, {
          itemId: boundedConversationItemId('mar-agent-error', input.runId),
          kind: 'error',
          status: 'FAILED',
          payload: {
            ...projected,
            recoverable: true,
            retryAfterMs: null
          }
        });
        terminalEvent = { eventType: 'run.failed', payload: projected, status: 'FAILED' };
      }
    } finally {
      titleController.abort();
      const cleanup = [
        async () => {
          await computerUseBinding?.close();
        },
        async () => {
          await titleTask;
        },
        async () => {
          this.clearInteractions(input.runId);
        },
        async () => {
          await closeImageCredentialProviders(executionModels);
        },
        async () => {
          runtime?.host.unbindExecutionMcp(executionMcpBinding);
        },
        async () => {
          await executionMcpLease?.release();
        }
      ];
      try {
        for (const close of cleanup) {
          try {
            await close();
          } catch {
            nodeLog('runner.mar-agent.run.cleanup_failed', {
              runId: input.runId,
              code: 'MAR_AGENT_RUN_CLEANUP_FAILED'
            });
          }
        }
      } finally {
        use?.terminal();
        this.#normalizers.delete(input.runId);

        this.#executions.delete(input.runId);
        this.#steerTargets.delete(input.runId);
        if (cancelledDuringPreparation)
          terminalEvent = {
            eventType: 'run.cancelled',
            payload: { status: 'CANCELLED' },
            status: 'CANCELLED'
          };
        try {
          if (terminalEvent !== undefined)
            this.host.emit(
              input.runId,
              terminalEvent.eventType,
              terminalEvent.payload,
              terminalEvent.status
            );
        } finally {
          resolveSettled();
        }
      }
    }
  }

  #resolveMcpServers(
    installations: unknown,
    environment: Readonly<Record<string, string>>,
    executionServers: readonly ResolvedMcpServer[] = []
  ): readonly ResolvedMcpServer[] {
    const servers = this.runner.mcpConfiguration(
      installations,
      environment,
      executionServers
    ) as readonly ResolvedMcpServer[];
    return servers;
  }

  private requestQuestion(
    runId: string,
    request: { requestId: string; questions: unknown[] },
    signal: AbortSignal = new AbortController().signal
  ) {
    const questions = normalizeQuestions(request.questions);
    if (questions.length === 0) return Promise.resolve({});
    this.host.emitItem(runId, {
      itemId: boundedConversationItemId('mar-agent-question', request.requestId),
      kind: 'user_input_request',
      status: 'PENDING',
      payload: { requestId: request.requestId, questions }
    });
    return new Promise<Record<string, unknown>>((resolve) => {
      const cancel = () => settle({});
      const settle = (answers: Record<string, unknown>) => {
        const pending = this.#questions.get(request.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.cleanup();
        this.#questions.delete(request.requestId);
        resolve(answers);
      };
      const timer = setTimeout(() => {
        settle({});
      }, 10 * 60_000);
      timer.unref();
      signal.addEventListener('abort', cancel, { once: true });
      this.#questions.set(request.requestId, {
        runId,
        resolve,
        timer,
        cleanup: () => signal.removeEventListener('abort', cancel)
      });
      if (signal.aborted) cancel();
    });
  }

  decideApproval(input: {
    runId: string;
    approvalId: string;
    decision: ToolApprovalDecision;
  }): boolean {
    const pending = this.#approvals.get(input.approvalId);
    if (!pending || pending.runId !== input.runId) return false;
    pending.cleanup();
    pending.resolve(input.decision);
    return true;
  }

  private requestApproval(runId: string, request: ToolApprovalRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<ToolApprovalDecision>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', cancel);
        this.#approvals.delete(request.approvalId);
      };
      const cancel = () => {
        cleanup();
        if (
          signal.reason instanceof Error &&
          'code' in signal.reason &&
          signal.reason.code === 'MAR_AGENT_APPROVAL_EXPIRED'
        )
          this.host.emit(runId, 'approval.expired', { approvalId: request.approvalId });
        reject(signal.reason);
      };
      const input = {
        runId,
        approvalId: request.approvalId,
        expiresAt: request.expiresAt,
        payload: {
          toolName: request.source.toolName,
          input: request.input,
          reason: request.reason,
          source: request.source
        }
      };
      try {
        this.host.createApproval!(input);
        this.#approvals.set(request.approvalId, { runId, resolve, cleanup });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        else this.host.publishApproval!(input);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private clearInteractions(runId: string): void {
    for (const pending of this.#approvals.values()) {
      if (pending.runId !== runId) continue;
      pending.cleanup();
      pending.resolve('REJECTED');
    }
    for (const [requestId, pending] of this.#questions) {
      if (pending.runId !== runId) continue;
      clearTimeout(pending.timer);
      pending.cleanup();
      this.#questions.delete(requestId);
      pending.resolve({});
    }
  }

  private project(runId: string, event: AgentEvent) {
    if (contextUsageChanged(event)) this.host.refreshContext?.(runId);
    if (event.type === 'model.performance')
      this.host.emit(runId, 'run.performance', {
        ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
        ...(event.tokensPerSecond === undefined ? {} : { tokensPerSecond: event.tokensPerSecond })
      });
    else if (event.type === 'message.delta')
      this.host.emit(runId, 'text.delta', {
        text: event.delta,
        phase: event.phase,
        itemId: boundedConversationItemId('mar-agent-message', event.itemId)
      });
    else {
      let normalizer =
        this.#normalizers.get(runId) ?? this.#runtimes.findRuntime(event.sessionId)?.normalizer;
      if (normalizer === undefined) {
        normalizer = new MarAgentConversationNormalizer();
        this.#normalizers.set(runId, normalizer);
      }
      for (const item of normalizer.normalize(event, { publicItemIdPrefix: runId })) {
        const attachments =
          item.generatedImages === undefined
            ? []
            : (this.host.registerGeneratedImages?.(runId, event.sessionId, item.generatedImages) ??
              []);
        this.host.emitItem(runId, {
          itemId: item.itemId,
          kind: item.kind,
          status: item.status,
          payload: attachments.length === 0 ? item.payload : { ...item.payload, attachments },
          ...(item.permissionStop === undefined ? {} : { permissionStop: item.permissionStop }),
          ...(item.merge === undefined ? {} : { merge: item.merge }),
          ...(item.append === undefined ? {} : { append: item.append })
        });
      }
    }
  }
}

function contextUsageChanged(event: AgentEvent): boolean {
  return (
    event.type === 'context.compacted' ||
    (event.type === 'usage.updated' &&
      event.purpose !== 'compact' &&
      (event.contextInputTokens !== undefined || event.inputTokens !== undefined))
  );
}

function normalizeQuestions(raw: unknown[]): Array<{
  id: string;
  prompt: string;
  input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
  options: Array<{ value: string; label: string; description: string | null }>;
  allowOther: boolean;
  multiSelect?: boolean;
}> {
  return raw.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const question = value as Record<string, unknown>;
    if (typeof question.id !== 'string' || typeof question.question !== 'string') return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (option === null || typeof option !== 'object' || Array.isArray(option)) return [];
          const record = option as Record<string, unknown>;
          if (typeof record.label !== 'string') return [];
          return [
            {
              value: record.label,
              label: record.label,
              description: typeof record.description === 'string' ? record.description : null
            }
          ];
        })
      : [];
    const multiSelect = question.multiSelect === true;
    return [
      {
        id: question.id,
        prompt: question.question,
        input: options.length === 0 ? 'SHORT_TEXT' : multiSelect ? 'MULTI_SELECT' : 'SINGLE_SELECT',
        options,
        allowOther: true,
        ...(multiSelect ? { multiSelect: true } : {})
      }
    ];
  });
}
