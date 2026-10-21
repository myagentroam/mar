import { OpenCodeUsageNormalizer } from './conversation-parser.js';
import { parseComposerTags } from '@myagentroam/protocol';
import type {
  NodeEnvelope,
  RunnerCommandDescriptor,
  RunnerCommandState
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../../database.js';
import { nodeExecutionEnvironment } from '../../node-execution-environment.js';
import type { FakeRunnerStatus } from '../../fake-runner.js';
import type { RunnerImageAttachment } from '../../service/run-attachment-service.js';
import { parseSecretEnvironment } from '../../util/secret-environment.js';
import { runnerErrorProjection } from '../../util/runner-error.js';
import { boundedConversationItemId, compactRunnerText } from '../codex/conversation-parser.js';
import { openCodePatchToolPayload, openCodeQuestions } from './conversation-parser.js';
import { normalizeOpenCodeTool } from './tool-normalizer.js';
import { OpenCodeRunner } from '../opencode-runner.js';
import { ResponseLatencyTracker } from '../../service/response-latency-tracker.js';
import { GenerationTimingTracker } from '../../service/generation-timing-tracker.js';

interface OpenCodeManagedRunHost {
  intercepted(): boolean;
  readonly active: Set<string>;
  parseAttachments(value: unknown): readonly RunnerImageAttachment[];
  persistAttachments(
    cwd: string,
    runId: string,
    attachments: readonly RunnerImageAttachment[]
  ): Promise<readonly string[]>;
  emit(runId: string, eventType: string, payload: unknown, status?: FakeRunnerStatus): void;
  emitItem(runId: string, item: OpenCodePublicItem): void;
  adopt(input: {
    runId: string;
    sessionId: string;
    runner: 'opencode';
    cwd: string;
    externalSessionId?: string;
    initiatedByUserId?: number;
  }): void;
  run(runId: string): { readonly id: string };
  hasActiveSessionLease(sessionId: string): boolean;
  promote(sessionId: string, nativeSessionId: string): void;
  rememberNative(nativeSessionId: string, sessionId: string): void;
  send(type: string, payload: unknown): void;
  createApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }): void;
  publishApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }): void;
  expireApproval(approvalId: string): void;
  commandState(sessionId: string, commandId: string): RunnerCommandState | undefined;
  setCommandState(sessionId: string, state: RunnerCommandState): void;
  clearCommandState(sessionId: string, commandId: string): void;
  commandStates(sessionId: string): readonly RunnerCommandState[];
}

type OpenCodePublicItem = {
  readonly itemId: string;
  readonly kind:
    | 'assistant_message'
    | 'plan'
    | 'reasoning_summary'
    | 'command_execution'
    | 'tool_call'
    | 'user_input_request'
    | 'context_compaction'
    | 'error'
    | 'unknown';
  readonly status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly payload: Record<string, unknown>;
  readonly merge?: boolean;
};

interface PendingPermission {
  readonly runId: string;
  readonly requestId: string;
  readonly client: import('../../opencode-server.js').OpenCodeServerClient;
  readonly cwd: string;
  readonly timer: NodeJS.Timeout;
}

interface PendingQuestion {
  readonly runId: string;
  readonly requestId: string;
  readonly client: import('../../opencode-server.js').OpenCodeServerClient;
  readonly cwd: string;
  readonly questionIds: readonly string[];
  readonly timer: NodeJS.Timeout;
}

export class OpenCodeManagedRunController {
  private readonly usage = new Map<string, OpenCodeUsageNormalizer>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly startingCwds = new Map<string, string>();
  private readonly promptAdmitted = new Set<string>();
  private readonly pendingIdle = new Set<string>();
  private readonly messageRoles = new Map<string, Map<string, 'user' | 'assistant'>>();
  private readonly messageParents = new Map<string, Map<string, string>>();
  private readonly compactionPartIds = new Map<string, Map<string, string>>();
  private readonly completedCompactionParents = new Map<string, Set<string>>();
  private readonly startingClients = new Map<
    string,
    import('../../opencode-server.js').OpenCodeServerClient
  >();

  constructor(
    private readonly runner: OpenCodeRunner,
    private readonly host: OpenCodeManagedRunHost,
    private readonly interactionTimeoutMs = 10 * 60_000
  ) {}

  async executeCommand(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    context: {
      readonly secretEnvironment: Readonly<Record<string, string>>;
      readonly initiatedByUserId?: number;
    }
  ): Promise<unknown> {
    if (command.id === 'compact')
      return this.compact(session, context.secretEnvironment, context.initiatedByUserId);
    if (command.id !== 'plan') throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const current = this.host.commandState(session.id, 'plan');
    if (current?.active) this.host.clearCommandState(session.id, 'plan');
    else
      this.host.setCommandState(session.id, {
        commandId: 'plan',
        active: true,
        label: 'Plan Mode',
        detail: 'Subsequent messages use the OpenCode Plan Agent for read-only analysis.',
        closable: true,
        closeInput: '/plan',
        continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
      });
    return { command: command.id, states: this.host.commandStates(session.id) };
  }

  private compact(
    session: NodeAgentSession,
    environment: Readonly<Record<string, string>>,
    initiatedByUserId?: number
  ): unknown {
    if (
      session.externalSessionId === null ||
      session.model === null ||
      session.nativeControl !== 'MAR_MANAGED' ||
      this.host.hasActiveSessionLease(session.id)
    )
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const runId = crypto.randomUUID();
    const client = this.runner.managedClient(
      nodeExecutionEnvironment(
        { ...environment, MAR_CTL_CONTEXT_REQUIRED: '1' },
        { PATH: process.env['PATH'], Path: process.env['Path'] }
      )
    );
    this.host.adopt({
      runId,
      sessionId: session.id,
      runner: 'opencode',
      cwd: session.cwd,
      externalSessionId: session.externalSessionId,
      ...(initiatedByUserId === undefined ? {} : { initiatedByUserId })
    });
    this.host.active.add(runId);
    this.runner.execution.set(runId, {
      runId,
      sessionId: session.id,
      nativeSessionId: session.externalSessionId,
      cwd: session.cwd,
      client,
      abort: new AbortController(),
      access: session.access ?? 'default',
      agent: 'build'
    });
    this.host.emit(runId, 'run.started', { command: 'compact' }, 'STARTING');
    this.host.emitItem(runId, openCodeCompactionItem('opencode-compact', runId, false));
    void this.runCompact(runId, session.model);
    return {
      command: 'compact',
      run: this.host.run(runId),
      states: this.host.commandStates(session.id)
    };
  }

  private async runCompact(runId: string, model: string): Promise<void> {
    const execution = this.runner.execution.get(runId);
    if (execution === undefined) return;
    this.host.emit(runId, 'run.running', { command: 'compact' }, 'RUNNING');
    try {
      await execution.client.summarize(execution.cwd, execution.nativeSessionId, model);
      this.host.emitItem(runId, openCodeCompactionItem('opencode-compact', runId, true));
      this.finish(runId, 'SUCCEEDED', 'run.completed', { status: 'SUCCEEDED' });
    } catch (error) {
      this.finish(runId, 'FAILED', 'run.failed', error, 'OPENCODE_COMPACT_FAILED');
    }
  }

  start(envelope: NodeEnvelope): void {
    const payload = envelope.payload as Record<string, unknown>;
    if (
      payload.runner !== 'opencode' ||
      typeof payload.runId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.input !== 'string' ||
      typeof payload.cwd !== 'string' ||
      typeof payload.model !== 'string' ||
      this.host.intercepted() ||
      this.host.active.has(payload.runId)
    )
      return;
    let environment: Readonly<Record<string, string>>;
    let mcp: unknown;
    let attachments: readonly RunnerImageAttachment[];
    try {
      environment = nodeExecutionEnvironment(
        {
          ...parseSecretEnvironment(payload.secretEnvironment),
          MAR_CTL_CONTEXT_REQUIRED: '1'
        },
        { PATH: process.env['PATH'], Path: process.env['Path'] }
      );
      mcp = this.runner.mcpConfiguration(
        payload.mcpInstallations,
        {
          ...environment,
          MAR_USERNAME: environment['MAR_USERNAME'] ?? ''
        },
        payload.executionMcpServers as
          readonly import('../../mcp/model.js').ResolvedMcpServer[] | undefined
      );
      attachments = this.host.parseAttachments(payload.attachments);
    } catch (error) {
      const projected = runnerErrorProjection(error, 'RUNNER_INPUT_INVALID');
      this.host.emitItem(payload.runId, {
        itemId: boundedConversationItemId('runner-error', payload.runId),
        kind: 'error',
        status: 'FAILED',
        payload: { ...projected, recoverable: true, retryAfterMs: null }
      });
      this.host.emit(payload.runId, 'run.rejected', projected, 'FAILED');
      return;
    }
    void this.run({
      runId: payload.runId,
      sessionId: payload.sessionId,
      input: payload.input,
      cwd: payload.cwd,
      model: payload.model,
      effort: typeof payload.effort === 'string' ? payload.effort : '',
      ...(typeof payload.externalSessionId === 'string'
        ? { externalSessionId: payload.externalSessionId }
        : {}),
      environment,
      attachments,
      access: typeof payload.access === 'string' ? payload.access : 'default',
      agent: payload.collaborationMode === 'plan' ? 'plan' : 'build',
      ...(typeof payload.personalInstructions === 'string'
        ? { personalInstructions: payload.personalInstructions }
        : {}),
      mcp
    });
  }

  cancel(runId: string, intent: 'CANCEL' | 'INTERRUPT'): boolean {
    const execution = this.runner.execution.get(runId);
    if (execution === undefined) return false;
    void execution.client.abort(execution.cwd, execution.nativeSessionId).finally(() => {
      this.finish(runId, intent === 'INTERRUPT' ? 'INTERRUPTED' : 'CANCELLED', 'run.completed', {
        status: intent === 'INTERRUPT' ? 'INTERRUPTED' : 'CANCELLED'
      });
    });
    return true;
  }

  decideApproval(input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  }): boolean {
    const pending = this.permissions.get(input.approvalId);
    if (pending === undefined || pending.runId !== input.runId) return false;
    clearTimeout(pending.timer);
    this.permissions.delete(input.approvalId);
    void pending.client.replyPermission(pending.cwd, pending.requestId, input.decision);
    return true;
  }

  respondUserInput(runId: string, requestId: string, answers: Record<string, unknown>): boolean {
    const pending = this.questions.get(requestId);
    if (pending === undefined || pending.runId !== runId) return false;
    const normalized = pending.questionIds.map((id) => {
      const value = answers[id];
      const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      if (
        values.length === 0 ||
        values.length > 8 ||
        values.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 500)
      )
        throw new Error('USER_INPUT_INVALID');
      return values as string[];
    });
    clearTimeout(pending.timer);
    this.questions.delete(requestId);
    void pending.client.replyQuestion(pending.cwd, pending.requestId, normalized);
    this.host.emitItem(runId, {
      itemId: boundedConversationItemId('opencode-input', requestId),
      kind: 'user_input_request',
      status: 'COMPLETED',
      payload: {},
      merge: true
    });
    return true;
  }

  private async run(input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly input: string;
    readonly cwd: string;
    readonly model: string;
    readonly effort: string;
    readonly externalSessionId?: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly attachments: readonly RunnerImageAttachment[];
    readonly access: string;
    readonly agent: 'plan' | 'build';
    readonly personalInstructions?: string;
    readonly mcp: unknown;
  }): Promise<void> {
    // OpenCode dynamic MCP registration belongs to Server process state. Runs that load MCP use an
    // isolated Server so parallel sessions in one workspace do not share MCP processes or context.
    const client = this.runner.managedClient(
      input.environment,
      hasMcpConfiguration(input.mcp) ? input.runId : undefined
    );
    this.startingClients.set(input.runId, client);
    this.startingCwds.set(input.runId, input.cwd);
    this.host.active.add(input.runId);
    this.host.emit(input.runId, 'run.started', {}, 'STARTING');
    try {
      if (hasMcpConfiguration(input.mcp)) await client.configureMcp(input.cwd, input.mcp);
      const nativeSessionId =
        input.externalSessionId ?? openCodeSessionId(await client.createSession(input.cwd));
      if (nativeSessionId === undefined) throw new Error('OPENCODE_SESSION_INVALID');
      this.host.adopt({
        runId: input.runId,
        sessionId: input.sessionId,
        runner: 'opencode',
        cwd: input.cwd,
        externalSessionId: nativeSessionId
      });
      this.host.rememberNative(nativeSessionId, input.sessionId);
      if (input.externalSessionId === undefined) {
        this.host.promote(input.sessionId, nativeSessionId);
        this.host.send('session.external-id', {
          sessionId: input.sessionId,
          externalSessionId: nativeSessionId
        });
      }
      const abort = new AbortController();
      this.runner.execution.set(input.runId, {
        runId: input.runId,
        sessionId: input.sessionId,
        nativeSessionId,
        cwd: input.cwd,
        client,
        abort,
        access: input.access,
        agent: input.agent
      });
      let subscriptionStarted = false;
      let ready!: () => void;
      let rejectReady!: (error: unknown) => void;
      const subscriptionReady = new Promise<void>((resolve, reject) => {
        ready = () => {
          subscriptionStarted = true;
          resolve();
        };
        rejectReady = reject;
      });
      void client
        .subscribe(
          input.cwd,
          abort.signal,
          (event) => this.event(input.runId, nativeSessionId, event),
          ready
        )
        .catch((error) => {
          if (abort.signal.aborted) return;
          if (!subscriptionStarted) {
            rejectReady(error);
            return;
          }
          this.finish(input.runId, 'FAILED', 'run.failed', error, 'OPENCODE_EVENT_FAILED');
        });
      await subscriptionReady;
      this.host.emit(input.runId, 'run.running', {}, 'RUNNING');
      // The initial SSE snapshot can contain an idle event from before this prompt.
      this.pendingIdle.delete(input.runId);
      // Replacement inputs can retain earlier tags; the latest tag describes the current images.
      const currentAttachments = parseComposerTags(input.input)
        .filter((part) => part.kind === 'mar_attachments')
        .at(-1);
      const existingImagePaths =
        currentAttachments?.payload.files
          .filter((file) =>
            input.attachments.some((image) => image.name === file.name && image.mime === file.mime)
          )
          .map((file) => file.path) ?? [];
      const attachmentPaths =
        input.attachments.length === 0
          ? []
          : existingImagePaths.length === input.attachments.length
            ? existingImagePaths
            : await this.host.persistAttachments(input.cwd, input.runId, input.attachments);
      const execution = this.runner.execution.get(input.runId);
      if (execution !== undefined) {
        execution.responseLatency = new ResponseLatencyTracker();
        execution.responsePartKinds = new Map();
        execution.responseStartedAt = Date.now();
        execution.responseMessages = new Set();
        execution.generationTiming = new GenerationTimingTracker();
      }
      await client.prompt({
        directory: input.cwd,
        sessionID: nativeSessionId,
        text: openCodeImageInput(input.input, attachmentPaths),
        model: input.model,
        variant: input.effort,
        agent: input.agent,
        ...(input.personalInstructions === undefined ? {} : { system: input.personalInstructions }),
        attachments: input.attachments
      });
      this.promptAdmitted.add(input.runId);
      if (this.pendingIdle.delete(input.runId))
        this.finish(input.runId, 'SUCCEEDED', 'run.completed', { status: 'SUCCEEDED' });
    } catch (error) {
      this.finish(input.runId, 'FAILED', 'run.failed', error, 'OPENCODE_RUN_START_FAILED');
    }
  }

  private event(runId: string, nativeSessionId: string, value: unknown): void {
    const event = record(value);
    const properties = record(event?.properties);
    const nested = record(properties?.part) ?? record(properties?.info);
    const execution = this.runner.execution.get(runId);
    const receiptAt = execution?.generationTiming?.timestamp();
    const sessionID =
      typeof properties?.sessionID === 'string'
        ? properties.sessionID
        : typeof nested?.sessionID === 'string'
          ? nested.sessionID
          : undefined;
    if (sessionID !== nativeSessionId) return;
    let usage = this.usage.get(runId);
    if (!usage) {
      usage = new OpenCodeUsageNormalizer(runId, (value) =>
        this.host.emit(runId, 'run.usage', value)
      );
      this.usage.set(runId, usage);
    }
    usage.observe(value, execution?.responseStartedAt);
    if (event?.type === 'session.idle') {
      if (!this.promptAdmitted.has(runId)) {
        this.pendingIdle.add(runId);
        return;
      }
      this.finish(runId, 'SUCCEEDED', 'run.completed', { status: 'SUCCEEDED' });
      return;
    }
    if (event?.type === 'session.error') {
      this.finish(runId, 'FAILED', 'run.failed', properties?.error ?? properties);
      return;
    }
    if (event?.type === 'message.updated') {
      const info = record(properties?.info);
      if (typeof info?.id === 'string' && (info.role === 'user' || info.role === 'assistant')) {
        const roles = this.messageRoles.get(runId) ?? new Map<string, 'user' | 'assistant'>();
        roles.set(info.id, info.role);
        this.messageRoles.set(runId, roles);
        const execution = this.runner.execution.get(runId);
        const created = record(info.time)?.created;
        if (
          info.role === 'assistant' &&
          execution?.responseStartedAt !== undefined &&
          typeof created === 'number' &&
          created >= execution.responseStartedAt
        ) {
          execution.responseMessages?.add(info.id);
          execution.currentResponseMessageId = info.id;
        }
      }
      if (
        info?.role === 'assistant' &&
        typeof info.id === 'string' &&
        typeof info.parentID === 'string'
      ) {
        const parents = this.messageParents.get(runId) ?? new Map<string, string>();
        parents.set(info.id, info.parentID);
        this.messageParents.set(runId, parents);
        this.runner.managedTurns.set(info.parentID, runId);
      }
      if (
        info?.role === 'assistant' &&
        typeof info.parentID === 'string' &&
        typeof record(info.time)?.completed === 'number'
      ) {
        const completedParents = this.completedCompactionParents.get(runId) ?? new Set<string>();
        const alreadyCompleted = completedParents.has(info.parentID);
        completedParents.add(info.parentID);
        this.completedCompactionParents.set(runId, completedParents);
        const partId = this.compactionPartIds.get(runId)?.get(info.parentID);
        if (!alreadyCompleted && partId !== undefined)
          this.host.emitItem(runId, openCodeCompactionItem('opencode', partId, true));
      }
      return;
    }
    if (event?.type === 'message.part.delta') {
      const kind =
        typeof properties?.partID === 'string'
          ? this.runner.execution.get(runId)?.responsePartKinds?.get(properties.partID)
          : undefined;
      if (
        (kind === 'text' || kind === 'reasoning') &&
        properties?.field === 'text' &&
        typeof properties.delta === 'string' &&
        properties.delta.length > 0 &&
        typeof properties.messageID === 'string' &&
        this.currentResponseMessage(runId, properties.messageID)
      ) {
        const key = this.generationKey(runId, properties.messageID, properties.partID as string);
        if (key !== undefined) execution?.generationTiming?.start(key, receiptAt);
        this.observeResponse(
          runId,
          boundedConversationItemId('opencode', properties.partID as string),
          true
        );
      }
      return;
    }
    if (event?.type === 'message.part.updated') {
      const part = record(properties?.part);
      if (
        part?.type === 'compaction' &&
        typeof part.id === 'string' &&
        typeof part.messageID === 'string' &&
        this.messageRoles.get(runId)?.get(part.messageID) === 'user'
      ) {
        const partIds = this.compactionPartIds.get(runId) ?? new Map<string, string>();
        if (partIds.get(part.messageID) === part.id) return;
        partIds.set(part.messageID, part.id);
        this.compactionPartIds.set(runId, partIds);
        this.host.emitItem(runId, openCodeCompactionItem('opencode', part.id, false));
        if (this.completedCompactionParents.get(runId)?.has(part.messageID))
          this.host.emitItem(runId, openCodeCompactionItem('opencode', part.id, true));
        return;
      }
      if (
        typeof part?.messageID !== 'string' ||
        this.messageRoles.get(runId)?.get(part.messageID) !== 'assistant'
      )
        return;
      const parentId = this.messageParents.get(runId)?.get(part.messageID);
      if (parentId !== undefined && this.compactionPartIds.get(runId)?.has(parentId)) return;
      if (typeof part.id === 'string' && typeof part.type === 'string')
        this.runner.execution.get(runId)?.responsePartKinds?.set(part.id, part.type);
      const tracker = this.currentResponseMessage(runId, part.messageID)
        ? execution?.generationTiming
        : undefined;
      if (part.type === 'step-start') {
        if (tracker !== undefined && typeof part.id === 'string')
          this.generationKey(runId, part.messageID, part.id, receiptAt, true);
        return;
      }
      if (part.type === 'step-finish') {
        const key =
          typeof part.id === 'string'
            ? (execution?.generationPartKeys?.get(part.id) ??
              execution?.generationRequestKeys?.get(part.messageID))
            : undefined;
        if (tracker !== undefined && key !== undefined && typeof part.id === 'string') {
          execution?.generationPartKeys?.set(part.id, key);
          tracker.end(key, receiptAt);
          if (execution?.generationRequestKeys?.get(part.messageID) === key)
            execution.generationRequestKeys.delete(part.messageID);
          const outputTokens = openCodeOutputTokens(part.tokens);
          if (outputTokens !== undefined) {
            const result = tracker.settle(key, outputTokens, receiptAt);
            if (result !== undefined)
              this.host.emit(runId, 'run.performance', { tokensPerSecond: result.tokensPerSecond });
          }
        }
        return;
      }
      const item = openCodePart(part, this.runner.execution.get(runId)?.agent === 'plan');
      if (item !== undefined) this.host.emitItem(runId, item);
      if (typeof part.id === 'string') {
        const itemId = boundedConversationItemId('opencode', part.id);
        const responseLatency = this.currentResponseMessage(runId, part.messageID)
          ? execution?.responseLatency
          : undefined;
        const generationTiming = this.currentResponseMessage(runId, part.messageID)
          ? execution?.generationTiming
          : undefined;
        const generationKey =
          generationTiming === undefined
            ? undefined
            : this.generationKey(runId, part.messageID, part.id);
        if (part.type === 'tool') {
          const state = record(part.state);
          if (state?.status === 'pending') {
            if (generationKey !== undefined) generationTiming?.start(generationKey, receiptAt);
            const latencyMs = responseLatency?.toolStarted(itemId);
            if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
          } else if (state?.status === 'running') {
            if (generationKey !== undefined) generationTiming?.pause(generationKey, receiptAt);
            const latencyMs = responseLatency?.toolStarted(itemId);
            if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
          } else if (state?.status === 'completed' || state?.status === 'error') {
            if (generationKey !== undefined) generationTiming?.pause(generationKey, receiptAt);
            responseLatency?.toolCompleted(itemId);
          }
        } else if (
          generationTiming !== undefined &&
          generationKey !== undefined &&
          (part.type === 'text' || part.type === 'reasoning') &&
          typeof part.text === 'string'
        ) {
          if (isOpenCodeGenerationStart(part.time))
            generationTiming.start(generationKey, receiptAt);
          if (isOpenCodeGenerationEnd(part.time)) generationTiming.pause(generationKey, receiptAt);
          if (part.text.length > 0) this.observeResponse(runId, itemId);
        }
      }
      return;
    }
    if (event?.type === 'permission.asked') {
      this.pauseCurrentGeneration(runId, receiptAt);
      this.requestPermission(runId, properties);
    }
    if (event?.type === 'question.asked') {
      this.pauseCurrentGeneration(runId, receiptAt);
      this.requestQuestion(runId, properties);
    }
  }

  private currentResponseMessage(runId: string, messageId: string): boolean {
    const parent = this.messageParents.get(runId)?.get(messageId);
    return (
      this.runner.execution.get(runId)?.responseMessages?.has(messageId) === true &&
      this.messageRoles.get(runId)?.get(messageId) === 'assistant' &&
      (parent === undefined || !this.compactionPartIds.get(runId)?.has(parent))
    );
  }

  private observeResponse(runId: string, itemId?: string, incremental = false): void {
    const latencyMs = this.runner.execution
      .get(runId)
      ?.responseLatency?.response(itemId, incremental);
    if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
  }

  private pauseCurrentGeneration(runId: string, observedAt?: number): void {
    const execution = this.runner.execution.get(runId);
    const key =
      execution?.currentResponseMessageId === undefined
        ? undefined
        : execution.generationRequestKeys?.get(execution.currentResponseMessageId);
    if (key !== undefined) execution?.generationTiming?.pause(key, observedAt);
  }

  private generationKey(
    runId: string,
    messageId: string,
    partId: string,
    observedAt?: number,
    newRequest = false
  ): string | undefined {
    const execution = this.runner.execution.get(runId);
    if (execution?.generationTiming === undefined) return undefined;
    execution.generationPartKeys ??= new Map();
    const existing = execution.generationPartKeys.get(partId);
    if (existing !== undefined) return existing;
    execution.generationRequestKeys ??= new Map();
    let key = execution.generationRequestKeys.get(messageId);
    if (newRequest && key !== undefined) {
      execution.generationTiming.end(key, observedAt);
      key = undefined;
    }
    if (key === undefined) {
      const sequence = (execution.generationRequestSequence ?? 0) + 1;
      execution.generationRequestSequence = sequence;
      key = `${messageId}:generation:${sequence}`;
      execution.generationRequestKeys.set(messageId, key);
    }
    execution.generationPartKeys.set(partId, key);
    return key;
  }

  private requestPermission(runId: string, properties: Record<string, unknown> | undefined): void {
    const execution = this.runner.execution.get(runId);
    const requestId = typeof properties?.id === 'string' ? properties.id : undefined;
    if (execution === undefined || requestId === undefined) return;
    if (execution.access === 'auto') {
      void execution.client.replyPermission(execution.cwd, requestId, 'APPROVED');
      return;
    }
    const approvalId = `opencode:${requestId}`;
    const expiresAt = Date.now() + this.interactionTimeoutMs;
    const payload = {
      toolName:
        typeof properties?.permission === 'string' ? properties.permission : 'OpenCode permission',
      input: { patterns: Array.isArray(properties?.patterns) ? properties.patterns : [] }
    };
    try {
      this.host.createApproval({ runId, approvalId, payload, expiresAt });
    } catch {
      void execution.client.replyPermission(execution.cwd, requestId, 'REJECTED');
      return;
    }
    const expire = () => {
      const pending = this.permissions.get(approvalId);
      if (pending === undefined) return;
      try {
        this.host.expireApproval(approvalId);
      } catch (error) {
        if (error instanceof Error && error.message === 'APPROVAL_NOT_EXPIRED') {
          const timer = setTimeout(expire, Math.max(1, expiresAt - Date.now()));
          this.permissions.set(approvalId, { ...pending, timer });
          return;
        }
      }
      this.permissions.delete(approvalId);
      this.host.emit(runId, 'approval.expired', { approvalId });
      void execution.client.replyPermission(execution.cwd, requestId, 'REJECTED');
    };
    const timer = setTimeout(expire, this.interactionTimeoutMs);
    this.permissions.set(approvalId, {
      runId,
      requestId,
      client: execution.client,
      cwd: execution.cwd,
      timer
    });
    this.host.publishApproval({ runId, approvalId, payload, expiresAt });
  }

  private requestQuestion(runId: string, properties: Record<string, unknown> | undefined): void {
    const execution = this.runner.execution.get(runId);
    const requestId = typeof properties?.id === 'string' ? properties.id : undefined;
    const rawQuestions = properties?.questions;
    if (execution === undefined || requestId === undefined) return;
    const questions = openCodeQuestions(rawQuestions);
    if (questions.length === 0 || this.questions.has(requestId)) return;
    const timer = setTimeout(() => {
      const pending = this.questions.get(requestId);
      if (pending === undefined) return;
      this.questions.delete(requestId);
      void pending.client.rejectQuestion(pending.cwd, pending.requestId);
      this.host.emitItem(runId, {
        itemId: boundedConversationItemId('opencode-input', requestId),
        kind: 'user_input_request',
        status: 'FAILED',
        payload: { requestId, questions, errorCode: 'USER_INPUT_EXPIRED' },
        merge: true
      });
    }, this.interactionTimeoutMs);
    this.questions.set(requestId, {
      runId,
      requestId,
      client: execution.client,
      cwd: execution.cwd,
      questionIds: questions.map((question) => question.id),
      timer
    });
    this.host.emitItem(runId, {
      itemId: boundedConversationItemId('opencode-input', requestId),
      kind: 'user_input_request',
      status: 'PENDING',
      payload: { requestId, questions }
    });
  }

  private finish(
    runId: string,
    status: FakeRunnerStatus,
    eventType: string,
    payload: unknown,
    fallbackCode = 'OPENCODE_RUN_FAILED'
  ): void {
    const execution = this.runner.execution.get(runId);
    const cwd = execution?.cwd ?? this.startingCwds.get(runId);
    const client = execution?.client ?? this.startingClients.get(runId);
    if (execution === undefined && cwd === undefined && client === undefined) return;
    this.usage
      .get(runId)
      ?.finish(status === 'SUCCEEDED' ? 'succeeded' : status === 'FAILED' ? 'failed' : 'cancelled');
    this.usage.delete(runId);
    execution?.abort.abort();
    this.runner.execution.delete(runId);
    this.startingCwds.delete(runId);
    this.startingClients.delete(runId);
    this.promptAdmitted.delete(runId);
    this.pendingIdle.delete(runId);
    this.messageRoles.delete(runId);
    this.messageParents.delete(runId);
    this.compactionPartIds.delete(runId);
    this.completedCompactionParents.delete(runId);
    this.host.active.delete(runId);
    for (const [id, pending] of this.permissions)
      if (pending.runId === runId) {
        clearTimeout(pending.timer);
        this.permissions.delete(id);
      }
    for (const [id, pending] of this.questions)
      if (pending.runId === runId) {
        clearTimeout(pending.timer);
        this.questions.delete(id);
      }
    if (status === 'FAILED') {
      const projected = runnerErrorProjection(payload, fallbackCode);
      this.host.emitItem(runId, {
        itemId: boundedConversationItemId('runner-error', runId),
        kind: 'error',
        status: 'FAILED',
        payload: { ...projected, recoverable: true, retryAfterMs: null }
      });
      payload = projected;
    }
    this.host.emit(runId, eventType, payload, status);
    if (client !== undefined) this.runner.releaseManagedClient(client);
  }
}

function openCodeImageInput(input: string, attachmentPaths: readonly string[]): string {
  if (attachmentPaths.length === 0) return input;
  const paths = attachmentPaths.map((path) => `- ${JSON.stringify(path)}`).join('\n');
  return `${input}\n\nIf an inline image in this message is unavailable, use the read tool on the corresponding file below. Do not read it again when the inline image is already visible:\n${paths}`;
}

function hasMcpConfiguration(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

function openCodePart(
  part: Record<string, unknown> | undefined,
  planMode = false
): OpenCodePublicItem | undefined {
  const id = typeof part?.id === 'string' ? part.id : undefined;
  if (id === undefined || typeof part?.type !== 'string') return undefined;
  const itemId = boundedConversationItemId('opencode', id);
  if (part.type === 'text' && typeof part.text === 'string')
    return {
      itemId,
      kind: planMode ? 'plan' : 'assistant_message',
      status: record(part.time)?.end === undefined ? 'IN_PROGRESS' : 'COMPLETED',
      payload: planMode
        ? { explanation: compactRunnerText(part.text, 20_000), steps: [] }
        : { text: part.text, format: 'markdown', model: null },
      merge: true
    };
  if (part.type === 'reasoning' && typeof part.text === 'string')
    return {
      itemId,
      kind: 'reasoning_summary',
      status: record(part.time)?.end === undefined ? 'IN_PROGRESS' : 'COMPLETED',
      payload: { sections: [{ index: 0, text: part.text }] },
      merge: true
    };
  if (part.type === 'tool' && typeof part.tool === 'string') {
    // `question.asked` carries the canonical request ID required for reply;
    // the mirrored tool Part is presentation/history metadata only.
    if (part.tool === 'question') return undefined;
    const state = record(part.state);
    const status =
      state?.status === 'completed'
        ? 'COMPLETED'
        : state?.status === 'error'
          ? 'FAILED'
          : 'IN_PROGRESS';
    const normalized = normalizeOpenCodeTool(part.tool, state);
    return {
      itemId,
      kind: normalized.kind,
      status,
      payload: normalized.payload,
      merge: true
    };
  }
  if (part.type === 'compaction') return openCodeCompactionItem('opencode', id, false);
  if (part.type === 'patch')
    return {
      itemId,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: openCodePatchToolPayload(),
      merge: true
    };
  if (part.type === 'step-start' || part.type === 'step-finish') return undefined;
  if (part.type === 'text' || part.type === 'reasoning') return undefined;
  return {
    itemId,
    kind: 'unknown',
    status: record(part.time)?.end === undefined ? 'IN_PROGRESS' : 'COMPLETED',
    payload: {
      sourceEventType: `opencode:${part.type}`,
      label: `OpenCode ${compactRunnerText(part.type, 128)}`
    },
    merge: true
  };
}

function openCodeCompactionItem(
  namespace: 'opencode' | 'opencode-compact',
  id: string,
  completed: boolean
): OpenCodePublicItem {
  return {
    itemId: boundedConversationItemId(namespace, id),
    kind: 'context_compaction',
    status: completed ? 'COMPLETED' : 'IN_PROGRESS',
    payload: { phase: completed ? 'COMPLETED' : 'STARTED', summary: null },
    merge: true
  };
}

function openCodeSessionId(value: unknown): string | undefined {
  const session = record(value);
  return typeof session?.id === 'string' ? session.id : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOpenCodeGenerationStart(value: unknown): boolean {
  return typeof record(value)?.start === 'number';
}

function isOpenCodeGenerationEnd(value: unknown): boolean {
  return typeof record(value)?.end === 'number';
}

function openCodeOutputTokens(value: unknown): number | undefined {
  const tokens = record(value);
  const output = tokens?.output;
  const reasoning = tokens?.reasoning;
  if (
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(reasoning) ||
    (output as number) < 0 ||
    (reasoning as number) < 0 ||
    (output as number) + (reasoning as number) > Number.MAX_SAFE_INTEGER
  )
    return undefined;
  return (output as number) + (reasoning as number);
}
