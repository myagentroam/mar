import { claudeAssistantBlocks, extractClaudeThinkingText } from './conversation-parser.js';
import { ClaudeUsageNormalizer } from './tool-normalizer.js';
import type {
  NodeEnvelope,
  RunnerCommandDescriptor,
  RunnerCommandState
} from '@myagentroam/protocol';
import { createEnvelope } from '@myagentroam/protocol';
import type { ClaudeChannelRunHandle, ClaudeImageAttachment } from './claude-agent-sdk.js';
import { denyPermission } from './claude-agent-sdk.js';
import { ClaudeChannelGate } from './claude-channel.js';
import type { NodeAgentSession } from '../../session/contracts.js';
import { nodeExecutionEnvironment } from '../../node-execution-environment.js';
import type { RunnerExecutionStatus } from '../contracts.js';
import { boundedConversationItemId, compactRunnerText } from '../normalization.js';
import { extractClaudeText, extractClaudeToolUses } from './message-parsers.js';
import { claudePlanText } from './conversation-parser.js';
import type { PublicConversationItem } from '../../native-transcript-model.js';
import { normalizeClaudeTool, extractClaudeToolResults } from './tool-normalizer.js';
import { claudeContentBlocks } from './message-parsers.js';
import { ClaudeCodeRunner } from '../claude-code-runner.js';
import { parseSecretEnvironment } from '../../mcp/secret-environment.js';
import { safeErrorCode } from '../../util/safe-error.js';
import { runnerErrorProjection } from '../runner-error.js';
import { ResponseLatencyTracker } from '../../service/response-latency-tracker.js';
import { GenerationTimingTracker } from '../../service/generation-timing-tracker.js';

export interface ClaudeRunnerImageAttachment {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly dataBase64: string;
}

export interface ClaudeManagedRunHost<TAttachment extends ClaudeRunnerImageAttachment> {
  intercepted(): boolean;
  isExecutionActive(runId: string): boolean;
  executionAccepted(runId: string): void;
  parseAttachments(value: unknown): readonly TAttachment[];
  emit(runId: string, eventType: string, payload: unknown, status?: RunnerExecutionStatus): void;
  adopt(input: {
    runId: string;
    sessionId: string;
    runner: 'claude-code';
    cwd: string;
    externalSessionId?: string;
    initiatedByUserId?: number;
  }): void;
  run(runId: string): { readonly status: string } | undefined;
  hasActiveSessionLease(sessionId: string): boolean;
  session(sessionId: string): NodeAgentSession | undefined;
  completeCancelled(runId: string, cwd: string): boolean;
  requestUserInput(
    runId: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): Promise<ReturnType<typeof denyPermission>>;
  requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ReturnType<typeof denyPermission>>;
  rememberNative(nativeSessionId: string, sessionId: string): void;
  promote(sessionId: string, nativeSessionId: string): void;
  send(type: string, payload: unknown): void;
  emitItem(runId: string, item: PublicConversationItem): void;
  syncTitle(sessionId: string, nativeSessionId: string, cwd: string): Promise<void>;
  setChannelToken(sessionId: string, token: string): void;
  commandState(sessionId: string, commandId: string): RunnerCommandState | undefined;
  setCommandState(sessionId: string, state: RunnerCommandState): void;
  clearCommandState(sessionId: string, commandId: string): void;
  commandStates(sessionId: string): readonly RunnerCommandState[];
}

export class ClaudeManagedRunController<TAttachment extends ClaudeRunnerImageAttachment> {
  constructor(
    private readonly runner: ClaudeCodeRunner,
    private readonly host: ClaudeManagedRunHost<TAttachment>
  ) {}

  async executeCommand(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: {
      readonly secretEnvironment: Readonly<Record<string, string>>;
      readonly initiatedByUserId?: number;
    }
  ): Promise<unknown> {
    if (command.id === 'compact')
      return this.compact(session, input, context.secretEnvironment, context.initiatedByUserId);
    if (command.id !== 'plan' || session.access === 'plan')
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const current = this.host.commandState(session.id, 'plan');
    if (current?.active) this.host.clearCommandState(session.id, 'plan');
    else
      this.host.setCommandState(session.id, {
        commandId: 'plan',
        active: true,
        label: 'Plan Mode',
        detail: 'Subsequent messages run in read-only tagged Plan Mode and produce a plan card.',
        closable: true,
        closeInput: '/plan',
        continuation: { label: 'Implement', prompt: 'Implement the plan above.' }
      });
    return { command: command.id, states: this.host.commandStates(session.id) };
  }

  private compact(
    session: NodeAgentSession,
    input: string,
    secretEnvironment: Readonly<Record<string, string>>,
    initiatedByUserId?: number
  ): unknown {
    if (
      session.externalSessionId === null ||
      session.nativeControl !== 'MAR_MANAGED' ||
      this.host.hasActiveSessionLease(session.id)
    )
      throw new Error('RUNNER_COMMAND_UNAVAILABLE');
    const runId = crypto.randomUUID();
    this.host.adopt({
      runId,
      sessionId: session.id,
      runner: 'claude-code',
      cwd: session.cwd,
      externalSessionId: session.externalSessionId,
      ...(initiatedByUserId === undefined ? {} : { initiatedByUserId })
    });
    this.host.rememberNative(session.externalSessionId, session.id);
    this.start(
      createEnvelope('run.start', {
        runId,
        sessionId: session.id,
        runner: 'claude-code',
        input,
        cwd: session.cwd,
        externalSessionId: session.externalSessionId,
        model: session.model,
        effort: session.effort,
        access: session.access,
        secretEnvironment
      })
    );
    return {
      command: 'compact',
      run: this.host.run(runId),
      states: this.host.commandStates(session.id)
    };
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
      attachments?: unknown;
      secretEnvironment?: unknown;
      executionMcpServers?: readonly import('../../mcp/model.js').ResolvedMcpServer[];
      personalInstructions?: unknown;
      mcpInstallations?: unknown;
    };
    if (
      payload.runner !== 'claude-code' ||
      typeof payload.runId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.input !== 'string' ||
      typeof payload.cwd !== 'string' ||
      this.host.intercepted() ||
      this.host.isExecutionActive(payload.runId)
    )
      return;
    const runId = payload.runId;
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    const contextCompactionItemId =
      payload.input.trim() === '/compact'
        ? boundedConversationItemId('claude-compact', runId)
        : undefined;
    let attachments: readonly TAttachment[];
    let secretEnvironment: Readonly<Record<string, string>>;
    try {
      attachments = this.host.parseAttachments(payload.attachments);
      secretEnvironment = parseSecretEnvironment(payload.secretEnvironment);
    } catch (error) {
      this.host.emit(
        runId,
        'run.rejected',
        { code: safeErrorCode(error, 'MESSAGE_ATTACHMENTS_INVALID') },
        'FAILED'
      );
      return;
    }
    this.host.adopt({
      runId,
      sessionId,
      runner: 'claude-code',
      cwd,
      ...(typeof payload.externalSessionId === 'string'
        ? { externalSessionId: payload.externalSessionId }
        : {})
    });
    // An insert request may interrupt a Claude Run while its SDK Channel is
    // still starting. Do not start that stale Channel after the replacement
    // message has been accepted; emit its terminal projection to release the
    // replacement queued behind it.
    if (this.host.run(runId)?.status === 'INTERRUPTED') {
      this.host.emit(runId, 'run.completed', { status: 'INTERRUPTED' }, 'INTERRUPTED');
      return;
    }
    if (this.host.completeCancelled(runId, cwd)) return;
    if (
      typeof payload.externalSessionId === 'string' &&
      !this.runner.execution.managedNativeIds.has(payload.externalSessionId)
    ) {
      this.host.emit(runId, 'run.rejected', { code: 'SESSION_ACTIVATION_REQUIRED' }, 'FAILED');
      return;
    }
    this.host.executionAccepted(runId);
    this.host.emit(runId, 'run.started', {}, 'STARTING');
    if (contextCompactionItemId !== undefined)
      this.host.emitItem(runId, {
        itemId: contextCompactionItemId,
        kind: 'context_compaction',
        status: 'IN_PROGRESS',
        payload: { phase: 'STARTED', summary: null },
        merge: true
      });
    let terminal = false;
    let handle: ClaudeChannelRunHandle | undefined;
    const toolKinds = new Map<string, PublicConversationItem['kind']>();
    const toolInputs = new Map<string, { name: string; input: unknown; inputTruncated: boolean }>();
    const knownSubagents = new Map<string, string>();
    const usage = new ClaudeUsageNormalizer(runId, (value) =>
      this.host.emit(runId, 'run.usage', value)
    );
    const finish = (
      status: RunnerExecutionStatus,
      eventType: string,
      eventPayload: unknown,
      failure?: unknown,
      fallbackCode = 'CLAUDE_RUN_FAILED'
    ) => {
      if (terminal) return;
      terminal = true;
      const projected =
        status === 'FAILED'
          ? runnerErrorProjection(failure ?? eventPayload, fallbackCode)
          : undefined;
      if (projected !== undefined) {
        this.host.emitItem(runId, {
          itemId: boundedConversationItemId('runner-error', runId),
          kind: 'error',
          status: 'FAILED',
          payload: { ...projected, recoverable: true, retryAfterMs: null }
        });
      }
      if (status === 'SUCCEEDED' && contextCompactionItemId !== undefined)
        this.host.emitItem(runId, {
          itemId: contextCompactionItemId,
          kind: 'context_compaction',
          status: 'COMPLETED',
          payload: { phase: 'COMPLETED', summary: null },
          merge: true
        });
      usage.finish(
        status === 'SUCCEEDED' ? 'succeeded' : status === 'FAILED' ? 'failed' : 'cancelled'
      );
      this.host.emit(runId, eventType, projected ?? eventPayload, status);
      this.runner.execution.runs.delete(runId);
      handle?.cancel();
    };
    try {
      const gate = new ClaudeChannelGate(sessionId);
      const responseLatency = new ResponseLatencyTracker();
      const generationTiming = new GenerationTimingTracker();
      const finalOutputTokens = new Map<string, number>();
      const pendingOutputTokens = new Map<string, number>();
      const completedMessages = new Set<string>();
      let responseMessageId: string | undefined;
      const observeResponse = (id?: string, incremental = false) => {
        const latencyMs = responseLatency.response(id, incremental);
        if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
      };
      const settleGeneration = (id: string | undefined, observedAt?: number) => {
        if (id === undefined) return;
        generationTiming.end(id, observedAt);
        const outputTokens = finalOutputTokens.get(id);
        if (outputTokens === undefined) return;
        const result = generationTiming.settle(id, outputTokens, observedAt);
        if (result !== undefined)
          this.host.emit(runId, 'run.performance', { tokensPerSecond: result.tokensPerSecond });
      };
      handle = this.runner.startChannel({
        prompt: payload.input,
        cwd,
        ...(typeof payload.externalSessionId === 'string'
          ? { resumeSessionId: payload.externalSessionId }
          : {}),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
        ...(typeof payload.effort === 'string' ? { effort: payload.effort } : {}),
        ...(typeof payload.access === 'string' ? { access: payload.access } : {}),
        environment: nodeExecutionEnvironment(
          {
            ...secretEnvironment,
            MAR_CTL_CONTEXT_REQUIRED: '1'
          },
          { PATH: process.env['PATH'], Path: process.env['Path'] }
        ),
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
        ) as NonNullable<import('@anthropic-ai/claude-agent-sdk').Options['mcpServers']>,
        ...(attachments.length === 0
          ? {}
          : {
              attachments: attachments.map<ClaudeImageAttachment>((attachment) => ({
                mime: attachment.mime,
                dataBase64: attachment.dataBase64
              }))
            }),
        onPermission: (toolName, toolInput, options) => {
          if (options.agentID === undefined) {
            const receiptAt = generationTiming.timestamp();
            if (responseMessageId !== undefined)
              generationTiming.pause(responseMessageId, receiptAt);
            const latencyMs = responseLatency.toolStarted(options.toolUseID);
            if (latencyMs !== undefined) this.host.emit(runId, 'run.performance', { latencyMs });
          }
          return toolName === 'AskUserQuestion'
            ? (toolKinds.set(options.toolUseID, 'user_input_request'),
              this.host.requestUserInput(runId, toolInput, options.toolUseID))
            : this.host.requestApproval(runId, toolName, toolInput);
        },
        onChannelReply: (content) => this.host.emit(runId, 'channel.reply', { content }),
        onMessage: (message) => {
          if (terminal) return;
          usage.observe(message);
          const receiptAt = generationTiming.timestamp();
          const record = message as unknown as Record<string, unknown>;
          const nativeSessionId =
            typeof record.session_id === 'string' ? record.session_id : undefined;
          const current = this.runner.execution.runs.get(runId);
          if (nativeSessionId !== undefined && current !== undefined) {
            const firstNativeSessionId = current.nativeSessionId === undefined;
            if (firstNativeSessionId)
              this.runner.execution.runs.set(runId, { ...current, nativeSessionId });
            const managed = this.host.session(sessionId);
            if (managed?.nativeControl === 'MAR_MANAGED')
              this.host.rememberNative(nativeSessionId, managed.id);
            if (firstNativeSessionId && typeof payload.externalSessionId !== 'string') {
              this.host.promote(sessionId, nativeSessionId);
              this.host.send('session.external-id', {
                sessionId,
                externalSessionId: nativeSessionId
              });
              const managed = this.runner.execution.runs.get(runId);
              if (managed !== undefined)
                this.runner.execution.runs.set(runId, {
                  ...managed,
                  marSessionId: nativeSessionId
                });
            }
          }
          const mainTask =
            record.parent_tool_use_id === undefined || record.parent_tool_use_id === null;
          if (record.type === 'stream_event' && mainTask) {
            // Observe semantic timing without forwarding raw thinking or input fragments.
            const event = record.event as Record<string, unknown> | undefined;
            const block = event?.content_block as Record<string, unknown> | undefined;
            const delta = event?.delta as Record<string, unknown> | undefined;
            if (event?.type === 'message_start') {
              const message = event.message as Record<string, unknown> | undefined;
              responseMessageId = typeof message?.id === 'string' ? message.id : undefined;
            }
            if (event?.type === 'message_delta') {
              const usage = event.usage as Record<string, unknown> | undefined;
              if (responseMessageId !== undefined) {
                if (typeof usage?.output_tokens === 'number')
                  pendingOutputTokens.set(responseMessageId, usage.output_tokens);
                if (typeof delta?.stop_reason === 'string' && delta.stop_reason.length > 0) {
                  const tokens = pendingOutputTokens.get(responseMessageId);
                  if (tokens !== undefined) finalOutputTokens.set(responseMessageId, tokens);
                  completedMessages.add(responseMessageId);
                  settleGeneration(responseMessageId, receiptAt);
                }
              }
            }
            if (event?.type === 'message_stop') {
              if (responseMessageId !== undefined) {
                completedMessages.add(responseMessageId);
                if (!finalOutputTokens.has(responseMessageId)) {
                  const tokens = pendingOutputTokens.get(responseMessageId);
                  if (tokens !== undefined) finalOutputTokens.set(responseMessageId, tokens);
                }
              }
              settleGeneration(responseMessageId, receiptAt);
            }
            if (
              event?.type === 'content_block_start' &&
              (block?.type === 'tool_use' ||
                block?.type === 'thinking' ||
                block?.type === 'redacted_thinking' ||
                block?.type === 'encrypted_thinking' ||
                block?.type === 'text')
            ) {
              if (responseMessageId !== undefined)
                generationTiming.start(responseMessageId, receiptAt);
              if (
                block?.type !== 'text' ||
                (typeof block.text === 'string' && block.text.length > 0)
              ) {
                const latencyMs =
                  block?.type === 'tool_use' && typeof block.id === 'string'
                    ? responseLatency.toolStarted(block.id)
                    : responseLatency.response(responseMessageId);
                if (latencyMs !== undefined)
                  this.host.emit(runId, 'run.performance', { latencyMs });
                if (block?.type === 'tool_use') responseLatency.response(responseMessageId);
              }
            }
            if (
              (event?.type === 'content_block_start' && block?.type === 'thinking') ||
              (event?.type === 'content_block_delta' &&
                ((delta?.type === 'text_delta' &&
                  typeof delta.text === 'string' &&
                  delta.text.length > 0) ||
                  (delta?.type === 'thinking_delta' &&
                    typeof delta.thinking === 'string' &&
                    delta.thinking.length > 0) ||
                  (delta?.type === 'input_json_delta' &&
                    typeof delta.partial_json === 'string' &&
                    delta.partial_json.length > 0)))
            ) {
              if (responseMessageId !== undefined)
                generationTiming.start(responseMessageId, receiptAt);
              observeResponse(responseMessageId, event?.type === 'content_block_delta');
            }
          }
          if (record.type === 'assistant') {
            const snapshotMessage = record.message as Record<string, unknown> | undefined;
            const snapshotId =
              typeof snapshotMessage?.id === 'string' ? snapshotMessage.id : undefined;
            const snapshotUsage = snapshotMessage?.usage as Record<string, unknown> | undefined;
            if (
              mainTask &&
              snapshotId !== undefined &&
              typeof snapshotUsage?.output_tokens === 'number' &&
              (completedMessages.has(snapshotId) ||
                (typeof snapshotMessage?.stop_reason === 'string' &&
                  snapshotMessage.stop_reason.length > 0))
            ) {
              finalOutputTokens.set(snapshotId, snapshotUsage.output_tokens);
              settleGeneration(snapshotId, receiptAt);
            }
            const fallbackMessageId = crypto.randomUUID();
            for (const { record: blockRecord, blockIndex, sourceItemId } of claudeAssistantBlocks(
              record
            )) {
              const text = extractClaudeText(blockRecord);
              if (
                mainTask &&
                (text.length > 0 || extractClaudeThinkingText(blockRecord).length > 0)
              )
                observeResponse(
                  typeof (record.message as Record<string, unknown> | undefined)?.id === 'string'
                    ? ((record.message as Record<string, unknown>).id as string)
                    : undefined
                );
              const planText = claudePlanText(text);
              if (planText !== undefined)
                this.host.emitItem(runId, {
                  itemId: boundedConversationItemId(
                    'claude-plan',
                    sourceItemId ?? `${fallbackMessageId}:${blockIndex}`
                  ),
                  ...(sourceItemId === undefined ? {} : { sourceItemId }),
                  kind: 'plan',
                  status: 'COMPLETED',
                  payload: { explanation: compactRunnerText(planText, 20_000), steps: [] }
                });
              else if (text.length > 0)
                this.host.emitItem(runId, {
                  itemId: boundedConversationItemId(
                    'claude-text',
                    sourceItemId ?? `${fallbackMessageId}:${blockIndex}`
                  ),
                  ...(sourceItemId === undefined ? {} : { sourceItemId }),
                  kind: 'assistant_message',
                  status: 'COMPLETED',
                  payload: { text, format: 'markdown', model: null }
                });
              for (const text of extractClaudeThinkingText(blockRecord)) {
                this.host.emitItem(runId, {
                  itemId: boundedConversationItemId(
                    'claude-reasoning',
                    sourceItemId ?? `${fallbackMessageId}:${blockIndex}`
                  ),
                  ...(sourceItemId === undefined ? {} : { sourceItemId }),
                  kind: 'reasoning',
                  status: 'COMPLETED',
                  payload: {
                    representation: 'visible_thinking',
                    sections: [{ index: blockIndex, text }]
                  }
                });
              }
              for (const tool of extractClaudeToolUses(blockRecord)) {
                const latencyMs = mainTask ? responseLatency.toolStarted(tool.id) : undefined;
                if (latencyMs !== undefined)
                  this.host.emit(runId, 'run.performance', { latencyMs });
                if (tool.name === 'AskUserQuestion') {
                  toolKinds.set(tool.id, 'user_input_request');
                  continue;
                }
                const itemId = boundedConversationItemId('claude-tool', tool.id);
                toolInputs.set(tool.id, tool);
                const normalized = normalizeClaudeTool(
                  tool.name,
                  tool.input,
                  null,
                  false,
                  tool.inputTruncated,
                  knownSubagents
                );
                const kind = normalized.kind;
                toolKinds.set(tool.id, kind);
                this.host.emitItem(runId, {
                  itemId,
                  sourceItemId: itemId,
                  kind,
                  status: 'IN_PROGRESS',
                  payload: normalized.payload
                });
              }
              for (const block of claudeContentBlocks(blockRecord)) {
                const type = typeof block.type === 'string' ? block.type : 'unknown';
                if (
                  type === 'text' ||
                  type === 'thinking' ||
                  type === 'redacted_thinking' ||
                  type === 'encrypted_thinking' ||
                  type === 'tool_use' ||
                  type === 'tool_result'
                )
                  continue;
                this.host.emitItem(runId, {
                  itemId: boundedConversationItemId(
                    'claude-item',
                    sourceItemId ?? `${fallbackMessageId}:${blockIndex}`
                  ),
                  ...(sourceItemId === undefined ? {} : { sourceItemId }),
                  kind: 'unknown',
                  status: 'COMPLETED',
                  payload: {
                    sourceEventType: `claude-code:${type}`,
                    label: `Claude Code ${compactRunnerText(type, 128)}`
                  }
                });
              }
            }
          }
          if (record.type === 'tool_progress' && typeof record.tool_use_id === 'string') {
            const kind = toolKinds.get(record.tool_use_id);
            if (kind === 'tool_call') {
              const elapsed =
                typeof record.elapsed_time_seconds === 'number'
                  ? ` (${Math.max(0, Math.round(record.elapsed_time_seconds))} seconds)`
                  : '';
              this.host.emitItem(runId, {
                itemId: boundedConversationItemId('claude-tool', record.tool_use_id),
                kind,
                status: 'IN_PROGRESS',
                payload: {
                  progressLabel: compactRunnerText(
                    `${typeof record.tool_name === 'string' ? record.tool_name : 'Tool'} is running${elapsed}`,
                    500
                  ),
                  progressLabelCode:
                    typeof record.elapsed_time_seconds === 'number'
                      ? 'TOOL_RUNNING_WITH_DURATION'
                      : 'TOOL_RUNNING',
                  progressLabelParameters: {
                    tool: typeof record.tool_name === 'string' ? record.tool_name : 'Tool',
                    seconds:
                      typeof record.elapsed_time_seconds === 'number'
                        ? Math.max(0, Math.round(record.elapsed_time_seconds))
                        : 0
                  }
                },
                merge: true
              });
            }
          }
          if (record.type === 'user') {
            for (const result of extractClaudeToolResults(record)) {
              if (mainTask) responseLatency.toolCompleted(result.toolUseId);
              const kind = toolKinds.get(result.toolUseId) ?? 'tool_call';
              if (kind === 'user_input_request') continue;
              const tool = toolInputs.get(result.toolUseId);
              if (tool === undefined) continue;
              const normalized = normalizeClaudeTool(
                tool.name,
                tool.input,
                result.output,
                result.failed,
                tool.inputTruncated || result.truncated,
                knownSubagents,
                result.claudeResult
              );
              this.host.emitItem(runId, {
                itemId: boundedConversationItemId('claude-tool', result.toolUseId),
                kind,
                status: result.failed ? 'FAILED' : 'COMPLETED',
                payload:
                  kind === 'command_execution'
                    ? {
                        outputPreview: result.output,
                        exitCode: null,
                        durationMs: null,
                        truncated: result.truncated
                      }
                    : kind === 'file_change'
                      ? {}
                      : {
                          ...normalized.payload,
                          outputSummary: result.output,
                          progressLabel: null,
                          errorCode: result.failed ? 'TOOL_EXECUTION_FAILED' : null,
                          truncated: result.truncated
                        },
                merge: true
              });
            }
          }
          if (record.type === 'result') {
            const nativeTtft = [record.ttft_ms, record.ttft_stream_ms].find(
              (value): value is number =>
                typeof value === 'number' &&
                Number.isFinite(value) &&
                value >= 0 &&
                Number.isSafeInteger(Math.round(value))
            );
            if (nativeTtft !== undefined && !responseLatency.hasObservedResponse)
              this.host.emit(runId, 'run.performance', { latencyMs: Math.round(nativeTtft) });
            const subtype = typeof record.subtype === 'string' ? record.subtype : 'unknown';
            const completedNativeSessionId =
              this.runner.execution.runs.get(runId)?.nativeSessionId ?? nativeSessionId;
            this.host.emit(runId, 'turn.completed', {
              subtype
            });
            // A Channel uses a long-lived input iterable. Receiving an SDK
            // result completes this AgentRun even though that iterable can
            // remain open waiting for another user turn; waiting only for
            // stream closure would leave the WorkspaceLease permanently held.
            finish(
              subtype === 'success' && record.is_error !== true ? 'SUCCEEDED' : 'FAILED',
              subtype === 'success' && record.is_error !== true ? 'run.completed' : 'run.failed',
              { subtype },
              record
            );
            if (completedNativeSessionId !== undefined)
              void this.host.syncTitle(sessionId, completedNativeSessionId, cwd);
          }
        }
      });
      this.runner.execution.runs.set(runId, { marSessionId: sessionId, cwd, handle, gate });
      this.host.setChannelToken(sessionId, gate.token);
      this.host.send('session.channel.ready', { sessionId, token: gate.token });
      this.host.emit(runId, 'run.running', {}, 'RUNNING');
      void handle.completed.then(
        () => finish('SUCCEEDED', 'run.completed', { subtype: 'stream_closed' }),
        (error: unknown) =>
          finish('FAILED', 'run.failed', { code: safeErrorCode(error, 'CLAUDE_RUN_FAILED') }, error)
      );
    } catch (error) {
      finish(
        'FAILED',
        'run.failed',
        { code: safeErrorCode(error, 'CLAUDE_RUN_START_FAILED') },
        error,
        'CLAUDE_RUN_START_FAILED'
      );
    }
  }
}
