import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import type { MarAgentModelConfiguration } from '../model/configuration.js';
import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ModelRetryState,
  ModelUsage
} from '../model/contracts.js';
import { isProviderContextOverflow, recoverModelStream } from '../model/recovery.js';
import { modelStreamEventObservedAt } from '../model/sse.js';
import { modelOutputContinuationMessage } from '../prompts/output.js';
import {
  executeRoundTools,
  type ClientToolCall,
  type ExecutedToolCall,
  type RoundToolScope
} from '../tools/execution.js';
import type { ToolRuntimeImage } from '../tools/runtime-context.js';
import type { AuthoritativeModelUsage } from './context/usage.js';
import type { ExecutionMode } from './contracts.js';
import { publicHostedToolEvents, publicModelUsage } from './event-projection.js';
import type { EventPayload } from './events.js';
import { PlanOutputPrefix, splitPlanOutput } from './plan-output.js';
import { ModelGenerationTiming } from './model-generation-timing.js';

export interface PreparedExecutionRound {
  readonly request: ModelRequest;
  readonly toolScope: RoundToolScope;
}

/** Internal execution-local ports. No Session/Agent object, OS handles or terminal publisher. */
export interface ExecutionLoopInput {
  readonly permissionStop?: () => import('../tools/permissions.js').PermissionStop | undefined;
  readonly mode: ExecutionMode;
  readonly sourceType: 'user' | 'subagent';
  readonly signal: AbortSignal;
  readonly model: Pick<MarAgentModelConfiguration, 'id' | 'name'>;
  readonly messages: ModelMessage[];
  readonly toolImages: ToolRuntimeImage[];
  readonly publish: (event: EventPayload) => Promise<void>;
  readonly appendContext: (message: ModelMessage) => Promise<void>;
  readonly prepareRound: (
    continuation: ModelMessage | undefined
  ) => Promise<PreparedExecutionRound>;
  readonly startModel: (request: ModelRequest) => AsyncIterable<ModelEvent>;
  readonly recoverySignal: () => AbortSignal;
  readonly compactContext: () => Promise<boolean>;
  readonly compactionFallback?: (() => boolean) | undefined;
  readonly observeUsage: (
    usage: Omit<AuthoritativeModelUsage, 'historyMessages'> | undefined
  ) => void;
  readonly observeContextTokens: (tokens: number) => void;
  readonly afterModel?: (closedPrefixLength: number) => Promise<void>;
  readonly checkpoint: (
    round: PreparedExecutionRound,
    usage: ModelUsage | undefined
  ) => Promise<void>;
  readonly mailbox: {
    hasPending(): boolean;
    append(): Promise<boolean>;
    close(): void;
  };
}

/** Own the single model/tool loop; the SDK owns its handle, terminal events and cleanup. */
export class ExecutionLoop {
  #finalAnswer = '';
  private readonly planOutputPrefixes = new Map<string, PlanOutputPrefix>();
  get finalAnswer(): string {
    return this.#finalAnswer;
  }
  private set finalAnswer(value: string) {
    this.#finalAnswer = value;
  }
  constructor(private readonly input: ExecutionLoopInput) {}

  async run(): Promise<{ finalAnswer: string; usage?: ModelUsage }> {
    const input = this.input;
    const { mode, messages } = input;
    let recoveringFromContextOverflow = false;
    let maxOutputContinuationUsed = false;
    let pendingOutputContinuation: ModelMessage | undefined;
    const modelRetryState: ModelRetryState = { attempts: 0 };
    while (true) {
      let stop: string | undefined;
      let sawTool = false;
      let latestUsage: ModelUsage | undefined;
      let roundServerUsage: Omit<AuthoritativeModelUsage, 'historyMessages'> | undefined;
      const pendingTools: ClientToolCall[] = [];
      let incompleteToolCall = false;
      const round = await input.prepareRound(pendingOutputContinuation);
      const reasoningScope = randomUUID();
      const publishedReasoning = new Set<string>();
      const startedMessages = new Set<string>();
      const leadingMessageWhitespace = new Map<string, string>();
      let sawModelSemanticEvent = false;
      let requestStartedAt: number;
      let firstModelResponseAt: number | undefined;
      let generation = new ModelGenerationTiming();
      let requestCompletedAt: number | undefined;
      let requestOutputTokens: number | undefined;
      const roundMessageCount = messages.length;
      const emitLatency = async () => {
        if (mode === 'compact' || firstModelResponseAt === undefined) return;
        await input.publish({
          type: 'model.performance',
          latencyMs: Math.max(0, Math.round(firstModelResponseAt - requestStartedAt))
        });
      };
      const emitFinalPerformance = async (completedAt: number) => {
        if (mode === 'compact') return;
        generation.finish(completedAt);
        const outputDuration = generation.durationMs;
        const outputTokens = requestOutputTokens;
        if (outputTokens === undefined || outputDuration === undefined) return;
        await input.publish({
          type: 'model.performance',
          ...(firstModelResponseAt === undefined
            ? {}
            : { latencyMs: Math.max(0, Math.round(firstModelResponseAt - requestStartedAt)) }),
          outputTokens,
          outputDurationMs: Math.round(outputDuration),
          tokensPerSecond: Number(((outputTokens * 1000) / outputDuration).toFixed(2))
        });
      };
      const persistToolCalls = async (calls: readonly ClientToolCall[]) => {
        for (const call of calls) {
          const message: ModelMessage = {
            role: 'tool_call',
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
            ...(call.inputMode ? { inputMode: call.inputMode } : {}),
            content: ''
          };
          messages.push(message);
          await input.appendContext(message);
        }
      };
      try {
        requestStartedAt = performance.now();
        for await (const event of input.startModel({
          ...round.request,
          retryState: modelRetryState
        })) {
          if (event.type === 'output.reset') {
            generation = new ModelGenerationTiming();
            requestCompletedAt = undefined;
            requestOutputTokens = undefined;
            continue;
          }
          const observedAt = Math.max(
            requestStartedAt,
            modelStreamEventObservedAt(event) ?? performance.now()
          );
          if (event.type === 'output.started') {
            generation.start(observedAt);
            continue;
          }
          if (event.type === 'output.completed') {
            generation.finish(observedAt);
            continue;
          }
          if (event.type === 'output.paused') {
            generation.pause(observedAt);
            continue;
          }
          const modelResponseAt =
            mode !== 'compact' && isModelResponseEvent(event) ? observedAt : undefined;
          const isFirstModelResponse =
            modelResponseAt !== undefined && firstModelResponseAt === undefined;
          if (modelResponseAt !== undefined) {
            if (event.type !== 'output.delta') sawModelSemanticEvent = true;
            firstModelResponseAt ??= modelResponseAt;
            if (
              event.type === 'output.delta' ||
              (event.type === 'text.delta' && event.delta.length > 0)
            ) {
              generation.start(modelResponseAt);
            }
          }
          if (event.type === 'response.item') {
            // Compaction keeps only its successful checkpoint, never intermediate native output.
            if (mode === 'compact') continue;
            const message: ModelMessage = {
              role: 'provider',
              content: '',
              provider: event.provider,
              providerModelId: input.model.id,
              ...(event.provider === 'ANTHROPIC_MESSAGES'
                ? { contextKind: 'private' as const }
                : {}),
              item: event.item
            };
            messages.push(message);
            await input.appendContext(message);
          } else if (event.type === 'text.delta') {
            let delta = event.delta;
            if (mode === 'plan' && input.sourceType !== 'subagent') {
              let prefix = this.planOutputPrefixes.get(event.itemId);
              if (!prefix) {
                prefix = new PlanOutputPrefix();
                this.planOutputPrefixes.set(event.itemId, prefix);
              }
              delta = prefix.push(delta);
            }
            if (mode !== 'compact' && delta) {
              if (!startedMessages.has(event.itemId)) {
                delta = (leadingMessageWhitespace.get(event.itemId) ?? '') + delta;
                if (!delta.trim()) {
                  leadingMessageWhitespace.set(event.itemId, delta);
                  continue;
                }
                leadingMessageWhitespace.delete(event.itemId);
                startedMessages.add(event.itemId);
                await input.publish({
                  type: 'message.started',
                  itemId: event.itemId,
                  phase: event.phase
                });
              }
              await input.publish({
                type: 'message.delta',
                itemId: event.itemId,
                phase: event.phase,
                delta
              });
            }
          } else if (event.type === 'text.completed') {
            leadingMessageWhitespace.delete(event.itemId);
            const phase = event.phase ?? 'final_answer';
            if (phase === 'final_answer') this.finalAnswer = event.text;
            this.planOutputPrefixes.delete(event.itemId);
            if (mode !== 'compact') {
              if (mode === 'plan' && input.sourceType !== 'subagent') {
                const parts = splitPlanOutput(event.text);
                for (const [index, part] of parts.entries()) {
                  const itemId = index === 0 ? event.itemId : `${event.itemId}:plan-part:${index}`;
                  if (part.kind === 'plan')
                    await input.publish({ type: 'plan.completed', itemId, text: part.text });
                  else {
                    await input.publish({
                      type: 'message.completed',
                      itemId,
                      phase,
                      text: part.text,
                      modelId: input.model.id,
                      modelName: input.model.name
                    });
                  }
                }
              } else {
                await input.publish({
                  type: 'message.completed',
                  itemId: event.itemId,
                  phase,
                  text: event.text,
                  modelId: input.model.id,
                  modelName: input.model.name
                });
              }
            }
            messages.push({ role: 'assistant', content: event.text });
          } else if (event.type === 'usage') {
            latestUsage = event.usage;
            if (event.final === true) generation.finish(observedAt);
            const outputTokens =
              typeof event.usage.outputTokens === 'number' &&
              Number.isSafeInteger(event.usage.outputTokens) &&
              event.usage.outputTokens >= 0
                ? event.usage.outputTokens
                : undefined;
            if (event.final !== false && (outputTokens !== undefined || event.final === true))
              requestOutputTokens = outputTokens;
            const reportedContext = event.usage.contextInputTokens ?? event.usage.inputTokens;
            if (
              reportedContext !== undefined &&
              Number.isSafeInteger(reportedContext) &&
              reportedContext >= 0
            ) {
              input.observeContextTokens(reportedContext);
              roundServerUsage = {
                contextInputTokens: reportedContext,
                outputTokens:
                  typeof event.usage.outputTokens === 'number' &&
                  Number.isSafeInteger(event.usage.outputTokens) &&
                  event.usage.outputTokens >= 0
                    ? event.usage.outputTokens
                    : undefined
              };
            }
            await input.publish({ type: 'usage.updated', ...publicModelUsage(event.usage) });
          } else if (event.type === 'reasoning.completed') {
            if (mode !== 'compact' && event.text.trim() && !publishedReasoning.has(event.itemId)) {
              await input.publish({
                type: 'reasoning.completed',
                itemId: `${reasoningScope}:${event.itemId}`,
                representation: event.representation,
                text: event.text
              });
              publishedReasoning.add(event.itemId);
            }
          } else if (event.type === 'hosted_tool') {
            if (mode !== 'compact')
              for (const toolEvent of publicHostedToolEvents(event)) await input.publish(toolEvent);
          } else if (event.type === 'citation') {
            if (mode !== 'compact')
              await input.publish({
                type: 'citation.added',
                id: event.citation.id,
                url: event.citation.url,
                ...(event.citation.title ? { title: event.citation.title } : {})
              });
          } else if (event.type === 'client_tool.call') {
            if (mode === 'compact')
              throw new MarAgentError(
                'MAR_AGENT_MODEL_PROTOCOL_ERROR',
                'Compaction returned a tool call while tools were disabled.'
              );
            sawTool = true;
            pendingTools.push(event);
          } else if (event.type === 'completed') {
            stop = event.reason;
            requestCompletedAt = observedAt;
          }
          if (isFirstModelResponse) await emitLatency();
        }
        if (
          mode !== 'compact' &&
          stop !== 'cancelled' &&
          !input.signal.aborted &&
          requestCompletedAt !== undefined
        )
          await emitFinalPerformance(requestCompletedAt);
        pendingOutputContinuation = undefined;
        incompleteToolCall = pendingTools.some((call) => call.argumentError !== undefined);
        if (!(stop === 'max_output' && incompleteToolCall)) {
          await persistToolCalls(pendingTools);
        } else pendingTools.splice(0, pendingTools.length);
      } catch (error) {
        this.planOutputPrefixes.clear();
        if (await recoverModelStream(error, modelRetryState, input.recoverySignal())) {
          this.finalAnswer = '';
          if (mode === 'compact') messages.splice(roundMessageCount);
          if (pendingTools.some((call) => call.argumentError !== undefined))
            pendingTools.splice(0, pendingTools.length);
          else if (pendingTools.length > 0) await persistToolCalls(pendingTools);
          if (pendingTools.length === 0) continue;
        } else if (
          mode === 'compact' &&
          !sawModelSemanticEvent &&
          isProviderContextOverflow(error) &&
          input.compactionFallback?.()
        ) {
          modelRetryState.attempts = 0;
          this.finalAnswer = '';
          continue;
        } else if (
          mode !== 'compact' &&
          !sawModelSemanticEvent &&
          isProviderContextOverflow(error)
        ) {
          if (!recoveringFromContextOverflow && (await input.compactContext())) {
            modelRetryState.attempts = 0;
            recoveringFromContextOverflow = true;
            continue;
          }
          throw new MarAgentError(
            'MAR_AGENT_CONTEXT_LIMIT',
            'The model rejected the compacted context as too large.',
            { cause: error }
          );
        } else throw error;
      }
      recoveringFromContextOverflow = false;
      input.observeUsage(roundServerUsage);
      await input.afterModel?.(pendingTools.length ? roundMessageCount : messages.length);
      const toolResults = await executeRoundTools(pendingTools, round.toolScope);
      for (const result of toolResults) {
        if ('images' in result && result.images?.length)
          input.toolImages.push(
            ...result.images.map((image) => ({
              mimeType: image.mimeType,
              data: Buffer.from(image.dataBase64, 'base64')
            }))
          );
        const toolSearchTools =
          result.call.name === 'tool_search' && !result.failed
            ? result.output.toolSearchTools
            : undefined;
        const message: ModelMessage = {
          role: 'tool',
          callId: result.call.callId,
          name: result.call.name,
          isError: result.failed,
          content: result.content,
          ...(result.calls ? { calls: result.calls } : {}),
          ...(result.observations ? { observations: result.observations } : {}),
          ...(toolSearchTools === undefined ? {} : { toolSearchTools }),
          ...('images' in result && result.images?.length ? { images: result.images } : {})
        };
        messages.push(message);
        await input.appendContext({
          role: message.role,
          callId: result.call.callId,
          name: result.call.name,
          isError: result.failed,
          content: message.content,
          ...(message.calls ? { calls: message.calls } : {}),
          ...(message.observations ? { observations: message.observations } : {}),
          ...(message.toolSearchTools === undefined
            ? {}
            : { toolSearchTools: message.toolSearchTools })
        });
      }
      if (sawTool) {
        modelRetryState.attempts = 0;
        if (input.sourceType === 'subagent') this.finalAnswer = '';
      }
      if (mode !== 'compact' && stop === 'max_output') {
        const needsContinuation = !sawTool || incompleteToolCall;
        if (needsContinuation) {
          if (maxOutputContinuationUsed)
            throw new MarAgentError(
              'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE',
              'Model output reached its limit before completing.'
            );
          maxOutputContinuationUsed = true;
          pendingOutputContinuation = {
            role: 'user',
            content: modelOutputContinuationMessage
          };
          this.finalAnswer = '';
          modelRetryState.attempts = 0;
          continue;
        }
        maxOutputContinuationUsed = false;
      } else maxOutputContinuationUsed = false;
      await input.checkpoint(round, latestUsage);
      if (input.signal.aborted) {
        const aborted = toolResults.find(
          (result): result is Extract<ExecutedToolCall, { failed: true }> => result.failed
        )?.error;
        throw aborted ?? new MarAgentError('MAR_AGENT_EXECUTION_CANCELLED', 'Execution cancelled.');
      }
      if (input.permissionStop?.()) {
        input.mailbox.close();
        this.finalAnswer = '';
        return { finalAnswer: '', ...(latestUsage === undefined ? {} : { usage: latestUsage }) };
      }
      if (input.mailbox.hasPending() && (await input.mailbox.append())) {
        this.finalAnswer = '';
        modelRetryState.attempts = 0;
        continue;
      }
      if (stop === 'completed' && !sawTool) {
        const compactSummary = mode === 'compact' ? this.finalAnswer.trim() : '';
        if (mode === 'compact' && !compactSummary)
          throw new MarAgentError(
            'MAR_AGENT_COMPACT_FAILED',
            'Compaction returned an empty handoff.'
          );
        if (mode !== 'compact' && !this.finalAnswer.trim()) {
          const error = new MarAgentError(
            input.sourceType === 'subagent'
              ? 'MAR_AGENT_SUBAGENT_FAILED'
              : 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE',
            input.sourceType === 'subagent'
              ? 'Subagent completed without a final summary.'
              : 'Model completed without an answer or tool request.',
            { retryable: input.sourceType !== 'subagent' }
          );
          this.planOutputPrefixes.clear();
          if (await recoverModelStream(error, modelRetryState, input.recoverySignal())) {
            this.finalAnswer = '';
            continue;
          }
          throw error;
        }
        input.mailbox.close();
        return {
          finalAnswer: this.finalAnswer,
          ...(latestUsage === undefined ? {} : { usage: latestUsage })
        };
      }
      if (!sawTool && stop !== 'pause')
        throw new MarAgentError(
          'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE',
          'Model did not complete or request a tool.'
        );
      modelRetryState.attempts = 0;
    }
  }
}

function isModelResponseEvent(event: ModelEvent): boolean {
  if (event.type === 'text.delta') return event.delta.length > 0;
  if (event.type === 'text.completed' || event.type === 'reasoning.completed')
    return event.text.length > 0;
  return (
    event.type === 'response.item' ||
    event.type === 'output.delta' ||
    event.type === 'client_tool.call' ||
    event.type === 'hosted_tool' ||
    event.type === 'citation'
  );
}
