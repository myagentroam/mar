import { NODE_MCP } from '../../mcp/naming.js';
import type {
  NodeEnvelope,
  RunnerCommandDescriptor,
  RunnerCommandState
} from '@myagentroam/protocol';
import type { NodeAgentSession } from '../../database.js';
import { nodeExecutionEnvironment } from '../../node-execution-environment.js';
import type { NodeMessageAttachmentInput } from '../../runtime-model.js';
import type { CodexComposerInput, CodexRunConfiguration } from '../../codex-app-server.js';
import type { FakeRunnerStatus } from '../../fake-runner.js';
import { extractId } from '../../util/runner-native-session-parsers.js';
import { parseSecretEnvironment } from '../../util/secret-environment.js';
import { safeErrorCode } from '../../util/safe-error.js';
import { runnerErrorProjection } from '../../util/runner-error.js';
import { CodexRunner } from '../codex-runner.js';
import { ResponseLatencyTracker } from '../../service/response-latency-tracker.js';
import { GenerationTimingTracker } from '../../service/generation-timing-tracker.js';
import {
  boundedConversationItemId,
  compactRunnerText,
  isPlainRecord
} from '../../util/node-operation-parsers.js';
import {
  codexImageAttachments,
  codexLiveConversationItem,
  codexSourceItemId,
  CodexUsageNormalizer,
  codexUserInputQuestions
} from './conversation-parser.js';

type CodexImageInput = Extract<CodexComposerInput, { readonly type: 'localImage' }>;

interface CodexNotificationRun {
  readonly threadId: string;
  readonly turnId?: string;
}

export function resolveCodexNotificationRun<T extends CodexNotificationRun>(
  runs: ReadonlyMap<string, T>,
  input: {
    readonly threadId?: string;
    readonly turnId?: string;
    readonly allowUnboundFallback?: boolean;
  }
): readonly [string, T] | undefined {
  const entries = [...runs.entries()];
  if (input.turnId !== undefined) {
    const exact = entries.find(
      ([, value]) =>
        value.turnId === input.turnId &&
        (input.threadId === undefined || value.threadId === input.threadId)
    );
    if (exact !== undefined) return exact;
    if (input.allowUnboundFallback !== true) return undefined;
    // `turn/started` can arrive before the `turn/start` response binds its native Turn ID. Only
    // an unbound Run on the same thread is a valid fallback; an older bound Run is never valid.
    return entries
      .reverse()
      .find(([, value]) => value.threadId === input.threadId && value.turnId === undefined);
  }
  if (input.threadId === undefined) return undefined;
  return entries.reverse().find(([, value]) => value.threadId === input.threadId);
}

export interface CodexManagedRunHost<TAttachment> {
  readonly available: () => boolean;
  readonly intercepted: () => boolean;
  readonly active: ReadonlySet<string>;
  addActive(runId: string): void;
  removeActive(runId: string): void;
  adopt(input: {
    runId: string;
    sessionId: string;
    runner: 'codex';
    cwd: string;
    externalSessionId?: string;
    initiatedByUserId?: number;
  }): void;
  session(sessionId: string): NodeAgentSession | undefined;
  runStatus(runId: string): string | undefined;
  run(runId: string): unknown;
  interrupted(runId: string): boolean;
  parseAttachments(value: unknown): readonly TAttachment[];
  materialize(
    runId: string,
    attachments: readonly TAttachment[]
  ): Promise<readonly CodexImageInput[]>;
  completeCancelled(runId: string, cwd: string): boolean;
  promoteSession(sessionId: string, nativeSessionId: string): void;
  send(type: string, payload: unknown): void;
  emit(runId: string, eventType: string, payload: unknown, status?: FakeRunnerStatus): void;
  nativeGoalUpdated(
    runId: string,
    goal: {
      readonly threadId: string;
      readonly createdAt: number;
      readonly objective: string;
      readonly status: 'active' | 'completed';
    }
  ): void;
  cancel(
    runId: string,
    threadId: string,
    turnId: string,
    cwd: string,
    status: 'INTERRUPTED' | 'CANCELLED'
  ): Promise<void>;
  createApproval(input: {
    runId: string;
    approvalId: string;
    payload: unknown;
    expiresAt: number;
  }): void;
  publishApproval(input: {
    runId: string;
    approvalId: string;
    payload: unknown;
    expiresAt: number;
  }): void;
  emitItem(
    runId: string,
    item: {
      readonly itemId: string;
      readonly sourceItemId?: string;
      readonly kind:
        | 'reasoning'
        | 'tool_call'
        | 'command_execution'
        | 'user_input_request'
        | 'assistant_message'
        | 'plan'
        | 'context_compaction'
        | 'file_change'
        | 'warning'
        | 'error'
        | 'unknown';
      readonly status:
        'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'DECLINED' | 'INTERRUPTED';
      readonly payload: Record<string, unknown>;
      readonly merge?: boolean;
      readonly append?: 'sections' | 'outputPreview' | 'outputSummary';
    }
  ): void;
  appendImages(
    runId: string,
    images: readonly NodeMessageAttachmentInput[]
  ): readonly Record<string, unknown>[];
  syncTitle(sessionId: string, nativeSessionId: string, cwd: string): Promise<void>;
  commandState(sessionId: string, commandId: string): RunnerCommandState | undefined;
  setCommandState(sessionId: string, state: RunnerCommandState): void;
  clearCommandState(sessionId: string, commandId: string): void;
  commandStates(sessionId: string): readonly RunnerCommandState[];
  hasActiveSessionLease(sessionId: string): boolean;
  fast(input: string): Promise<unknown>;
}

export class CodexManagedRunController<TAttachment> {
  private readonly usage = new Map<string, CodexUsageNormalizer>();
  private readonly finishing = new Set<string>();
  constructor(
    private readonly runner: CodexRunner,
    private readonly host: CodexManagedRunHost<TAttachment>
  ) {}

  private emitItem(
    runId: string,
    item: Parameters<CodexManagedRunHost<TAttachment>['emitItem']>[1]
  ): void {
    const nativeTurnId = this.runner.execution.runs.get(runId)?.turnId;
    this.host.emitItem(
      runId,
      nativeTurnId === undefined
        ? item
        : {
            ...item,
            sourceItemId: codexSourceItemId(nativeTurnId, item.itemId)
          }
    );
  }

  async executeCommand(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: {
      readonly secretEnvironment: Readonly<Record<string, string>>;
      readonly initiatedByUserId?: number;
    }
  ): Promise<unknown> {
    if (command.id === 'plan') {
      const environmentLeaseId = crypto.randomUUID();
      this.runner.prepareEnvironment(context.secretEnvironment, environmentLeaseId);
      let modes: unknown;
      try {
        await this.runner.start(environmentLeaseId);
        modes = await this.runner.listCollaborationModes(environmentLeaseId);
      } finally {
        this.runner.releaseEnvironment(environmentLeaseId);
      }
      if (
        !isPlainRecord(modes) ||
        !Array.isArray(modes.data) ||
        !modes.data.some((mode) => isPlainRecord(mode) && mode.mode === 'plan')
      )
        throw new Error('RUNNER_COMMAND_UNAVAILABLE');
      const current = this.host.commandState(session.id, 'plan');
      if (current?.active) this.host.clearCommandState(session.id, 'plan');
      else
        this.host.setCommandState(session.id, {
          commandId: 'plan',
          active: true,
          label: 'Plan Mode',
          detail: 'Subsequent messages run in collaborative Plan Mode.',
          closable: true,
          closeInput: '/plan',
          continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
        });
      return { command: command.id, states: this.host.commandStates(session.id) };
    }
    const threadId = session.externalSessionId;
    if (threadId === null || session.nativeControl !== 'MAR_MANAGED')
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    if (command.id === 'compact') {
      const runId = crypto.randomUUID();
      this.runner.prepareEnvironment(
        nodeExecutionEnvironment(
          { ...context.secretEnvironment, MAR_CTL_CONTEXT_REQUIRED: '1' },
          { PATH: process.env['PATH'], Path: process.env['Path'] }
        ),
        runId
      );
      try {
        await this.runner.start(runId);
        return await this.compact(session, threadId, runId, context.initiatedByUserId);
      } catch (error) {
        this.runner.releaseEnvironment(runId);
        throw error;
      }
    }
    if (command.id === 'fast') return this.host.fast(input);
    throw new Error('RUNNER_COMMAND_UNAVAILABLE');
  }

  private async compact(
    session: NodeAgentSession,
    threadId: string,
    runId: string,
    initiatedByUserId?: number
  ): Promise<unknown> {
    if (this.host.hasActiveSessionLease(session.id)) throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    this.host.adopt({
      runId,
      sessionId: session.id,
      runner: 'codex',
      cwd: session.cwd,
      externalSessionId: threadId,
      ...(initiatedByUserId === undefined ? {} : { initiatedByUserId })
    });
    this.host.addActive(runId);
    this.runner.execution.runs.set(runId, {
      sessionId: session.id,
      threadId,
      cwd: session.cwd,
      refreshTitle: false
    });
    this.host.emit(runId, 'run.started', { command: 'compact' }, 'STARTING');
    try {
      const resumed = await this.runner.resumeThread(threadId, session.cwd, undefined, runId);
      await this.attachUsageRollout(runId, resumed);
      await this.runner.request('thread/compact/start', { threadId }, runId);
      return {
        command: 'compact',
        run: this.host.run(runId),
        states: this.host.commandStates(session.id)
      };
    } catch (error) {
      this.emitError(runId, error, 'CODEX_COMPACT_FAILED');
      this.host.emit(
        runId,
        'run.failed',
        runnerErrorProjection(error, 'CODEX_COMPACT_FAILED'),
        'FAILED'
      );
      this.usage.delete(runId);
      this.runner.execution.runs.delete(runId);
      this.runner.releaseEnvironment(runId);
      this.host.removeActive(runId);
      throw error;
    }
  }

  handleNotification(notification: {
    readonly method: string;
    readonly params: unknown;
    readonly requestId?: string | number;
  }): void {
    const params = isPlainRecord(notification.params) ? notification.params : {};
    const turn = isPlainRecord(params.turn) ? params.turn : undefined;
    const turnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof turn?.id === 'string'
          ? turn.id
          : undefined;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (turnId === undefined && threadId === undefined) return;
    const run = resolveCodexNotificationRun(this.runner.execution.runs, {
      ...(turnId === undefined ? {} : { turnId }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(notification.method === 'turn/started' ? { allowUnboundFallback: true } : {})
    });
    if (run === undefined) return;
    const [runId, activeRun] = run;
    const usage = this.usageFor(runId);
    const compactUsage =
      activeRun.refreshTitle === false || activeRun.generationCompacting === true;
    usage.observe(notification.method, params, compactUsage);
    const receiptAt = activeRun.generationTiming?.timestamp();
    if (notification.method === 'turn/started' && turnId !== undefined) {
      const active = this.runner.execution.runs.get(runId);
      if (active !== undefined) this.runner.execution.runs.set(runId, { ...active, turnId });
      this.host.emit(runId, 'run.running', { threadId, turnId }, 'RUNNING');
      return;
    }
    if (notification.method === 'rawResponseItem/completed') return;
    if (notification.method === 'rawResponse/completed') {
      this.completeRawResponse(runId, params, activeRun, receiptAt);
      return;
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      if (turnId !== undefined) void usage.flushRollout(turnId, compactUsage);
      this.completeStandardUsage(runId, params, activeRun, receiptAt);
      return;
    }
    if (
      notification.method === 'thread/goal/updated' &&
      activeRun.goalMcp === true &&
      turnId !== undefined &&
      threadId !== undefined &&
      isPlainRecord(params.goal) &&
      params.goal.threadId === threadId &&
      Number.isSafeInteger(params.goal.createdAt) &&
      (params.goal.createdAt as number) > 0 &&
      typeof params.goal.objective === 'string' &&
      params.goal.objective.length <= 20_000 &&
      (params.goal.status !== 'active' ||
        (params.goal.tokensUsed === 0 && params.goal.timeUsedSeconds === 0)) &&
      (params.goal.status === 'active' || params.goal.status === 'complete')
    ) {
      this.host.nativeGoalUpdated(runId, {
        threadId,
        createdAt: params.goal.createdAt as number,
        objective: params.goal.objective,
        status: params.goal.status === 'complete' ? 'completed' : 'active'
      });
      return;
    }
    if (
      notification.requestId !== undefined &&
      (notification.method === 'item/commandExecution/requestApproval' ||
        notification.method === 'item/fileChange/requestApproval')
    ) {
      this.pauseGeneration(runId, receiptAt);
      this.requestApproval(runId, {
        ...notification,
        requestId: notification.requestId
      });
      return;
    }
    if (
      notification.requestId !== undefined &&
      notification.method === 'item/tool/requestUserInput'
    ) {
      this.pauseGeneration(runId, receiptAt);
      this.requestUserInput(runId, notification.requestId, params);
      return;
    }
    if (
      notification.requestId !== undefined &&
      notification.method === 'mcpServer/elicitation/request' &&
      ((activeRun.goalMcp === true && params.serverName === NODE_MCP.goal.name) ||
        (activeRun.scheduleMcp === true && params.serverName === NODE_MCP.schedule.name)) &&
      isPlainRecord(params._meta) &&
      params._meta.codex_approval_kind === 'mcp_tool_call'
    ) {
      this.runner.respond(
        notification.requestId,
        {
          action: 'accept',
          content: {},
          _meta: null
        },
        runId
      );
      return;
    }
    if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const itemId =
        typeof params.itemId === 'string'
          ? boundedConversationItemId('codex', params.itemId)
          : undefined;
      this.host.emit(runId, 'text.delta', {
        text: params.delta,
        ...(itemId === undefined || turnId === undefined
          ? {}
          : { sourceItemId: codexSourceItemId(turnId, itemId) }),
        ...(itemId === undefined ? {} : { itemId })
      });
      if (params.delta.length > 0) this.beginGeneration(runId, receiptAt);
      if (params.delta.length > 0) this.observeResponse(runId, itemId, true);
      return;
    }
    if (notification.method === 'item/reasoning/textDelta' && typeof params.delta === 'string') {
      if (params.delta.length > 0) {
        this.beginGeneration(runId, receiptAt);
        this.observeResponse(
          runId,
          typeof params.itemId === 'string'
            ? boundedConversationItemId('codex', params.itemId)
            : undefined,
          true
        );
      }
      return;
    }
    if (
      notification.method === 'item/reasoning/summaryTextDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      const index =
        typeof params.summaryIndex === 'number' && Number.isInteger(params.summaryIndex)
          ? params.summaryIndex
          : 0;
      this.emitItem(runId, {
        itemId: boundedConversationItemId('codex', params.itemId),
        kind: 'reasoning',
        status: 'IN_PROGRESS',
        payload: {
          representation: 'summary',
          sections: [{ index, text: compactRunnerText(params.delta, 10_000) }]
        },
        merge: true,
        append: 'sections'
      });
      if (params.delta.length > 0) {
        this.beginGeneration(runId, receiptAt);
        this.observeResponse(runId, boundedConversationItemId('codex', params.itemId), true);
      }
      return;
    }
    if (
      notification.method === 'item/commandExecution/outputDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      this.emitItem(runId, {
        itemId: boundedConversationItemId('codex', params.itemId),
        kind: 'command_execution',
        status: 'IN_PROGRESS',
        payload: { outputPreview: compactRunnerText(params.delta, 10_000) },
        merge: true,
        append: 'outputPreview'
      });
      return;
    }
    if (
      notification.method === 'item/mcpToolCall/progress' &&
      typeof params.itemId === 'string' &&
      typeof params.message === 'string'
    ) {
      this.emitItem(runId, {
        itemId: boundedConversationItemId('codex', params.itemId),
        kind: 'tool_call',
        status: 'IN_PROGRESS',
        payload: { progressLabel: compactRunnerText(params.message, 500) },
        merge: true
      });
      return;
    }
    if (
      (notification.method === 'item/started' || notification.method === 'item/completed') &&
      isPlainRecord(params.item)
    ) {
      const attachments = this.host.appendImages(runId, codexImageAttachments(params.item));
      const item = codexLiveConversationItem(
        params.item,
        notification.method === 'item/completed',
        attachments
      );
      if (item !== undefined) {
        this.emitItem(runId, item);
        if (item.kind === 'context_compaction') {
          activeRun.generationCompacting = notification.method === 'item/started';
          if (activeRun.generationCompacting) {
            for (const key of activeRun.generationKeys ?? [])
              activeRun.generationTiming?.discard(key);
            activeRun.generationKeys = [];
            activeRun.currentGenerationKey = undefined;
          }
          return;
        }
        const tracker = activeRun.responseLatency;
        const tool = ['tool_call', 'command_execution', 'file_change'].includes(item.kind);
        if (tool) {
          if (notification.method === 'item/started') {
            if (codexToolGeneratesArguments(params.item)) this.beginGeneration(runId, receiptAt);
            else this.pauseGeneration(runId, receiptAt);
          }
          if (notification.method === 'item/completed') tracker?.toolCompleted(item.itemId);
          else {
            const latencyMs = tracker?.toolStarted(item.itemId);
            if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
          }
        } else if (['assistant_message', 'reasoning', 'plan'].includes(item.kind)) {
          // A started reasoning item is itself a semantic response, even before its summary.
          if (notification.method === 'item/started') this.beginGeneration(runId, receiptAt);
          this.observeResponse(runId, item.itemId);
        }
      }
      return;
    }
    if (notification.method === 'turn/completed') {
      if (this.finishing.has(runId)) return;
      this.endPendingGenerations(activeRun, receiptAt);
      const status = turn?.status;
      const terminal: FakeRunnerStatus =
        status === 'completed' ? 'SUCCEEDED' : status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
      if (terminal === 'FAILED') this.emitError(runId, turn?.error ?? turn, 'CODEX_RUN_FAILED');
      const failure =
        terminal === 'FAILED'
          ? runnerErrorProjection(turn?.error ?? turn, 'CODEX_RUN_FAILED')
          : { status: status ?? 'unknown' };
      const finish = () => {
        if (!this.runner.execution.runs.has(runId)) {
          this.finishing.delete(runId);
          return;
        }
        this.host.emit(
          runId,
          terminal === 'FAILED' ? 'run.failed' : 'run.completed',
          failure,
          terminal
        );
        const active = this.runner.execution.runs.get(runId);
        const titleRefresh =
          active === undefined ||
          active.refreshTitle === false ||
          this.host.session(active.sessionId)?.titleSource !== 'AUTO'
            ? undefined
            : this.host.syncTitle(active.sessionId, active.threadId, active.cwd);
        this.usage.delete(runId);
        this.runner.execution.runs.delete(runId);
        if (titleRefresh === undefined) this.runner.releaseEnvironment(runId);
        else void titleRefresh.finally(() => this.runner.releaseEnvironment(runId));
        this.host.removeActive(runId);
        this.finishing.delete(runId);
      };
      if (usage.hasRollout && turnId !== undefined) {
        this.finishing.add(runId);
        void this.settleUsage(runId, turnId).then(finish);
      } else finish();
    }
  }

  async settleUsage(runId: string, turnId: string): Promise<void> {
    const usage = this.usage.get(runId);
    const active = this.runner.execution.runs.get(runId);
    if (usage) {
      await usage.flushRollout(
        turnId,
        active?.refreshTitle === false || active?.generationCompacting === true
      );
      if (this.usage.get(runId) === usage) this.usage.delete(runId);
    }
  }

  private usageFor(runId: string): CodexUsageNormalizer {
    let usage = this.usage.get(runId);
    if (!usage) {
      const active = this.runner.execution.runs.get(runId);
      usage = new CodexUsageNormalizer(
        runId,
        (value) =>
          this.host.emit(runId, 'run.usage', {
            ...value,
            sessionId: this.runner.execution.runs.get(runId)?.threadId
          }),
        active ? (this.host.session(active.sessionId)?.model ?? undefined) : undefined
      );
      this.usage.set(runId, usage);
    }
    return usage;
  }

  private async attachUsageRollout(runId: string, result: unknown): Promise<void> {
    const thread =
      isPlainRecord(result) && isPlainRecord(result.thread) ? result.thread : undefined;
    if (typeof thread?.path === 'string' && typeof thread.id === 'string')
      await this.usageFor(runId).attachRollout(thread.path, thread.id);
  }

  private observeResponse(runId: string, itemId?: string, incremental = false): void {
    const latencyMs = this.runner.execution.runs
      .get(runId)
      ?.responseLatency?.response(itemId, incremental);
    if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
  }

  private beginGeneration(runId: string, observedAt?: number): void {
    const active = this.runner.execution.runs.get(runId);
    if (active?.generationTiming === undefined || active.generationCompacting === true) return;
    let key = active.currentGenerationKey;
    if (key === undefined) {
      const sequence = (active.generationRequestSequence ?? 0) + 1;
      key = `${active.turnId ?? active.threadId}:generation:${sequence}`;
      active.generationKeys ??= [];
      active.generationKeys.push(key);
      active.generationRequestSequence = sequence;
      active.currentGenerationKey = key;
    }
    active.generationTiming.start(key, observedAt);
  }

  private pauseGeneration(runId: string, observedAt?: number): void {
    const active = this.runner.execution.runs.get(runId);
    const key = active?.currentGenerationKey;
    if (active?.generationTiming === undefined || key === undefined) return;
    active.generationTiming.pause(key, observedAt);
  }

  private endPendingGenerations(
    active: NonNullable<ReturnType<CodexRunner['execution']['runs']['get']>>,
    observedAt?: number
  ): void {
    if (active.generationTiming === undefined) return;
    for (const key of active.generationKeys ?? []) active.generationTiming.end(key, observedAt);
  }

  private completeRawResponse(
    runId: string,
    params: Record<string, unknown>,
    active: NonNullable<ReturnType<CodexRunner['execution']['runs']['get']>>,
    observedAt?: number
  ): void {
    const responseId = typeof params.responseId === 'string' ? params.responseId : undefined;
    if (responseId === undefined || active.completedGenerationResponseIds?.has(responseId)) return;
    active.completedGenerationResponseIds ??= new Set();
    active.completedGenerationResponseIds.add(responseId);
    if (active.generationCompacting === true) return;
    const key =
      active.generationResponseIds?.get(responseId) ??
      active.currentGenerationKey ??
      active.generationKeys?.find((candidate) => active.generationTiming?.has(candidate));
    if (key === undefined || active.generationTiming === undefined) return;
    active.generationResponseIds ??= new Map();
    active.generationResponseIds.set(responseId, key);
    active.generationTiming.end(key, observedAt);
    if (active.currentGenerationKey === key) active.currentGenerationKey = undefined;
    const outputTokens = codexOutputTokens(params.usage);
    if (outputTokens === undefined) return;
    this.emitGenerationTps(runId, active, key, outputTokens, observedAt);
  }

  private completeStandardUsage(
    runId: string,
    params: Record<string, unknown>,
    active: NonNullable<ReturnType<CodexRunner['execution']['runs']['get']>>,
    observedAt?: number
  ): void {
    if (active.generationTiming === undefined) return;
    const usage = isPlainRecord(params.tokenUsage) ? params.tokenUsage : undefined;
    const outputTokens = codexOutputTokens(usage?.last);
    if (outputTokens === undefined) return;
    // TokenCount also repeats the previous request's snapshot (for example after compaction).
    // Include total counters to distinguish equal last counts from distinct model requests.
    const snapshot = JSON.stringify([
      codexUsageCounters(usage?.last),
      codexUsageCounters(usage?.total)
    ]);
    if (active.generationUsageSnapshot === snapshot) return;
    active.generationUsageSnapshot = snapshot;
    if (active.generationCompacting === true) return;
    const key = active.generationKeys?.find((candidate) => active.generationTiming?.has(candidate));
    if (key !== undefined) this.emitGenerationTps(runId, active, key, outputTokens, observedAt);
  }

  private emitGenerationTps(
    runId: string,
    active: NonNullable<ReturnType<CodexRunner['execution']['runs']['get']>>,
    key: string,
    outputTokens: number,
    observedAt?: number
  ): void {
    const result = active.generationTiming?.settle(key, outputTokens, observedAt);
    if (result !== undefined)
      this.host.emit(runId, 'run.performance', { tokensPerSecond: result.tokensPerSecond });
    active.generationKeys = active.generationKeys?.filter((candidate) => candidate !== key);
    if (active.currentGenerationKey === key) active.currentGenerationKey = undefined;
  }

  private requestApproval(
    runId: string,
    notification: {
      readonly method: string;
      readonly params: unknown;
      readonly requestId: string | number;
    }
  ): void {
    const approvalId = `codex:${runId}:${notification.requestId}`;
    const expiresAt = Date.now() + 10 * 60_000;
    this.runner.execution.approvals.set(approvalId, {
      runId,
      requestId: notification.requestId
    });
    try {
      this.host.createApproval({
        runId,
        approvalId,
        payload: { method: notification.method, params: notification.params },
        expiresAt
      });
    } catch {
      this.runner.execution.approvals.delete(approvalId);
      return;
    }
    this.host.publishApproval({
      runId,
      approvalId,
      payload: { method: notification.method, params: notification.params },
      expiresAt
    });
  }

  private requestUserInput(
    runId: string,
    nativeRequestId: string | number,
    params: Record<string, unknown>
  ): void {
    const questions = codexUserInputQuestions(params.questions);
    if (questions.length === 0) {
      try {
        this.runner.respond(nativeRequestId, { answers: {} }, runId);
      } catch {
        // A disconnected App Server cannot receive a malformed-request response.
      }
      return;
    }
    const requestId = String(nativeRequestId);
    this.runner.execution.userInputs.set(`${runId}\0${requestId}`, {
      runId,
      requestId: nativeRequestId,
      questions: questions.map((question) => ({
        id: question.id,
        options: question.options.map((option) => option.value),
        allowOther: question.allowOther
      }))
    });
    this.emitItem(runId, {
      itemId: boundedConversationItemId('codex-input', requestId),
      kind: 'user_input_request',
      status: 'PENDING',
      payload: {
        requestId,
        questions: questions.map((question) => ({
          id: question.id,
          prompt: question.prompt,
          input: question.options.length === 0 ? 'SHORT_TEXT' : 'SINGLE_SELECT',
          options: question.options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description
          })),
          allowOther: question.allowOther
        }))
      }
    });
  }

  start(envelope: NodeEnvelope): void {
    const payload = envelope.payload as {
      runId?: unknown;
      sessionId?: unknown;
      runner?: unknown;
      input?: unknown;
      cwd?: unknown;
      externalSessionId?: unknown;
      model?: unknown;
      effort?: unknown;
      access?: unknown;
      collaborationMode?: unknown;
      serviceTier?: unknown;
      attachments?: unknown;
      secretEnvironment?: unknown;
      executionMcpServers?: readonly import('../../mcp/model.js').ResolvedMcpServer[];
      personalInstructions?: unknown;
      mcpInstallations?: unknown;
    };
    if (
      payload.runner !== 'codex' ||
      typeof payload.runId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.input !== 'string' ||
      typeof payload.cwd !== 'string' ||
      this.host.intercepted() ||
      this.host.active.has(payload.runId)
    )
      return;
    const { runId, sessionId, input, cwd } = payload;
    let attachments: readonly TAttachment[];
    let secretEnvironment: Readonly<Record<string, string>>;
    try {
      attachments = this.host.parseAttachments(payload.attachments);
      secretEnvironment = parseSecretEnvironment(payload.secretEnvironment);
    } catch (error) {
      this.emitError(runId, error, 'CODEX_RUN_FAILED');
      this.host.emit(
        runId,
        'run.rejected',
        runnerErrorProjection(error, 'MESSAGE_ATTACHMENTS_INVALID'),
        'FAILED'
      );
      return;
    }
    this.host.adopt({
      runId,
      sessionId,
      runner: 'codex',
      cwd,
      ...(typeof payload.externalSessionId === 'string'
        ? { externalSessionId: payload.externalSessionId }
        : {})
    });
    if (this.host.completeCancelled(runId, cwd)) return;
    const session = this.host.session(sessionId);
    if (!this.host.available()) {
      this.host.emit(runId, 'run.rejected', { code: 'CODEX_UNAVAILABLE' }, 'FAILED');
      return;
    }
    if (
      typeof payload.externalSessionId === 'string' &&
      (session === undefined || session.nativeControl !== 'MAR_MANAGED')
    ) {
      this.host.emit(runId, 'run.rejected', { code: 'SESSION_ACTIVATION_REQUIRED' }, 'FAILED');
      return;
    }
    try {
      this.runner.prepareEnvironment(
        nodeExecutionEnvironment(
          { ...secretEnvironment, MAR_CTL_CONTEXT_REQUIRED: '1' },
          { PATH: process.env['PATH'], Path: process.env['Path'] }
        ),
        runId
      );
    } catch (error) {
      this.host.emit(
        runId,
        'run.rejected',
        { code: safeErrorCode(error, 'SECRET_ENVIRONMENT_INVALID') },
        'FAILED'
      );
      return;
    }
    this.host.addActive(runId);
    void this.run(
      {
        runId,
        sessionId,
        input,
        cwd,
        externalSessionId: payload.externalSessionId,
        model: payload.model,
        effort: payload.effort,
        access: payload.access,
        collaborationMode: payload.collaborationMode,
        serviceTier: payload.serviceTier,
        ...(typeof payload.personalInstructions === 'string'
          ? { personalInstructions: payload.personalInstructions }
          : {}),
        mcpServers: this.runner.mcpConfiguration(
          payload.mcpInstallations,
          {
            ...secretEnvironment,
            MAR_USERNAME: secretEnvironment['MAR_USERNAME'] ?? ''
          },
          payload.executionMcpServers
        )
      },
      attachments
    );
  }

  private async run(
    payload: {
      runId: string;
      sessionId: string;
      input: string;
      cwd: string;
      externalSessionId?: unknown;
      model?: unknown;
      effort?: unknown;
      access?: unknown;
      collaborationMode?: unknown;
      serviceTier?: unknown;
      personalInstructions?: string;
      mcpServers?: unknown;
    },
    attachments: readonly TAttachment[]
  ): Promise<void> {
    const { runId, sessionId, input, cwd } = payload;
    try {
      await this.runner.start(runId);
      if (this.host.completeCancelled(runId, cwd)) {
        this.runner.releaseEnvironment(runId);
        return;
      }
      this.host.emit(runId, 'run.started', {}, 'STARTING');
      const configuration = {
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
        ...(typeof payload.effort === 'string' ? { effort: payload.effort } : {}),
        ...(typeof payload.access === 'string' ? { access: payload.access } : {}),
        ...(payload.personalInstructions === undefined
          ? {}
          : { developerInstructions: payload.personalInstructions }),
        ...(payload.mcpServers === undefined ? {} : { mcpServers: payload.mcpServers })
      };
      const collaborationMode =
        payload.collaborationMode === 'plan' || payload.collaborationMode === 'default'
          ? payload.collaborationMode
          : undefined;
      const turnConfiguration: CodexRunConfiguration = {
        ...configuration,
        ...(collaborationMode === undefined ? {} : { collaborationMode }),
        ...(payload.serviceTier === 'fast' ? { serviceTier: 'fast' as const } : {})
      };
      const materializedAttachments = await this.host.materialize(runId, attachments);
      let threadId: string | undefined;
      let turnResult: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const threadResult =
            typeof payload.externalSessionId === 'string'
              ? await this.runner.resumeThread(payload.externalSessionId, cwd, configuration, runId)
              : await this.runner.startThread(cwd, configuration, runId);
          if (this.host.completeCancelled(runId, cwd)) {
            this.runner.releaseEnvironment(runId);
            return;
          }
          threadId = extractId(threadResult, 'thread');
          this.runner.execution.runs.set(runId, {
            sessionId,
            threadId,
            cwd,
            goalMcp: hasGoalMcp(payload.mcpServers),
            scheduleMcp: hasScheduleMcp(payload.mcpServers),
            responseLatency: new ResponseLatencyTracker(),
            generationTiming: new GenerationTimingTracker(),
            generationKeys: [],
            generationResponseIds: new Map(),
            completedGenerationResponseIds: new Set()
          });
          await this.attachUsageRollout(runId, threadResult);
          turnResult = await this.runner.startTurn(
            threadId,
            input,
            cwd,
            turnConfiguration,
            materializedAttachments,
            runId
          );
          break;
        } catch (error) {
          this.usage.delete(runId);
          this.runner.execution.runs.delete(runId);
          if (attempt === 0 && (await this.runner.recoverMissingRollout(runId, error))) continue;
          throw error;
        }
      }
      if (threadId === undefined || turnResult === undefined) throw new Error('CODEX_RUN_FAILED');
      let publicSessionId = sessionId;
      if (typeof payload.externalSessionId !== 'string') {
        this.host.promoteSession(sessionId, threadId);
        publicSessionId = threadId;
        this.host.send('session.external-id', { sessionId, externalSessionId: threadId });
      }
      const turnId = extractId(turnResult, 'turn');
      this.runner.execution.runs.set(runId, {
        ...this.runner.execution.runs.get(runId),
        sessionId: publicSessionId,
        threadId,
        turnId,
        cwd,
        goalMcp: hasGoalMcp(payload.mcpServers),
        scheduleMcp: hasScheduleMcp(payload.mcpServers)
      });
      this.runner.execution.managedTurns.set(turnId, { sessionId: publicSessionId, runId });
      if (this.host.runStatus(runId) === 'CANCELLING') {
        await this.host.cancel(
          runId,
          threadId,
          turnId,
          cwd,
          this.host.interrupted(runId) ? 'INTERRUPTED' : 'CANCELLED'
        );
        this.runner.releaseEnvironment(runId);
        return;
      }
      this.host.emit(runId, 'run.running', { threadId, turnId }, 'RUNNING');
    } catch (error) {
      if (this.host.completeCancelled(runId, cwd)) {
        this.runner.releaseEnvironment(runId);
        return;
      }
      this.emitError(runId, error, 'CODEX_RUN_FAILED');
      this.host.emit(
        runId,
        'run.failed',
        runnerErrorProjection(error, 'CODEX_RUN_FAILED'),
        'FAILED'
      );
      this.usage.delete(runId);
      this.runner.execution.runs.delete(runId);
      this.runner.releaseEnvironment(runId);
      this.host.removeActive(runId);
    }
  }

  private emitError(runId: string, error: unknown, fallbackCode: string): void {
    const projected = runnerErrorProjection(error, fallbackCode);
    this.emitItem(runId, {
      itemId: boundedConversationItemId('runner-error', runId),
      kind: 'error',
      status: 'FAILED',
      payload: { ...projected, recoverable: true, retryAfterMs: null }
    });
  }
}

function hasGoalMcp(value: unknown): boolean {
  return isPlainRecord(value) && isPlainRecord(value[NODE_MCP.goal.name]);
}

function hasScheduleMcp(value: unknown): boolean {
  return isPlainRecord(value) && isPlainRecord(value[NODE_MCP.schedule.name]);
}

function codexOutputTokens(value: unknown): number | undefined {
  if (
    !isPlainRecord(value) ||
    typeof value.outputTokens !== 'number' ||
    !Number.isSafeInteger(value.outputTokens) ||
    value.outputTokens < 0
  )
    return undefined;
  return value.outputTokens;
}

function codexToolGeneratesArguments(value: Record<string, unknown>): boolean {
  return ['functionCall', 'function_call', 'customToolCall', 'custom_tool_call'].includes(
    typeof value.type === 'string' ? value.type : ''
  );
}

function codexUsageCounters(value: unknown): readonly unknown[] | undefined {
  if (!isPlainRecord(value)) return undefined;
  return [
    value.inputTokens,
    value.cachedInputTokens,
    value.outputTokens,
    value.reasoningOutputTokens,
    value.totalTokens
  ];
}
