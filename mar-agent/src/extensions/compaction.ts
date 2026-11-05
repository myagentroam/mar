import type {
  ExtensionCompactDiagnostic,
  ExtensionCompactResult
} from '../runtime/compaction/contracts.js';
export type {
  ExtensionCompactDiagnostic,
  ExtensionCompactResult
} from '../runtime/compaction/contracts.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { ModelUsage } from '../model/contracts.js';
import { countModelTokens } from '../runtime/token-budget.js';

export interface ExtensionCompactMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'tool_call';
  readonly content: string;
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}
export interface ExtensionCompactContext {
  readonly reportModelUsage?:
    | ((usage: import('../model/usage-observer.js').ModelRequestUsage) => Promise<void> | void)
    | undefined;
  readonly operationId: string;
  readonly reason: 'manual' | 'automatic';
  readonly messages: readonly ExtensionCompactMessage[];
  readonly focus?: string;
  readonly summaryTokenBudget: number;
  /** Return the Core's default structured handoff contract, independent of model configuration. */
  readonly getPrompt: () => string;
  /** Private, bounded telemetry only; reporting never changes the generation result. */
  readonly reportDiagnostic?: (diagnostic: ExtensionCompactDiagnostic) => Promise<void>;
}
/** Copy only neutral evidence; a hook never receives provider payloads or history ownership. */
export function compactExtensionMessages(
  messages: readonly ModelMessage[]
): readonly ExtensionCompactMessage[] {
  return freeze(
    messages
      .filter(
        (message) =>
          message.role !== 'provider' &&
          !['environment', 'private', 'compact_control'].includes(message.contextKind ?? '')
      )
      .map((message) => ({
        role: message.role as ExtensionCompactMessage['role'],
        content: message.content,
        ...(message.callId === undefined ? {} : { callId: message.callId }),
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.arguments === undefined
          ? {}
          : { arguments: structuredClone(message.arguments) })
      }))
  );
}

const usageKeys = new Set([
  'totalInputTokens',
  'reasoningTokens',
  'inputTokens',
  'contextInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'rolloutBudgetUnits',
  'hostedSearches',
  'hostedFetches'
]);

/** Whitelist scalar facts; never copy arbitrary plugin payloads into the session log. */
export function compactExtensionDiagnostic(value: unknown): ExtensionCompactDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const label = (value: unknown, limit: number): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\r\n]/u.test(value);
  const code = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value);
  if (
    !label(input.modelId, 128) ||
    !label(input.reasoningEffort, 32) ||
    typeof input.state !== 'string' ||
    !['STARTED', 'SUCCEEDED', 'DECLINED', 'FAILED'].includes(input.state)
  )
    return undefined;
  for (const key of [
    'inputTokensEstimateBefore',
    'inputTokensEstimateAfter',
    'modelRequests',
    'elapsedMs'
  ])
    if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 0)
      return undefined;
  return {
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    state: input.state as ExtensionCompactDiagnostic['state'],
    inputTokensEstimateBefore: input.inputTokensEstimateBefore as number,
    inputTokensEstimateAfter: input.inputTokensEstimateAfter as number,
    modelRequests: input.modelRequests as number,
    elapsedMs: input.elapsedMs as number,
    ...(label(input.providerModelId, 256) ? { providerModelId: input.providerModelId } : {}),
    ...(typeof input.reason === 'string' &&
    ['INPUT_BUDGET_EXHAUSTED', 'MODEL_INCOMPLETE', 'MODEL_FAILED'].includes(input.reason)
      ? { reason: input.reason as NonNullable<ExtensionCompactDiagnostic['reason']> }
      : {}),
    ...(code(input.errorCode) ? { errorCode: input.errorCode } : {}),
    ...(input.trigger === 'manual' || input.trigger === 'automatic'
      ? { trigger: input.trigger }
      : {}),
    ...(code(input.causeCode) ? { causeCode: input.causeCode } : {}),
    ...(code(input.errorReason) ? { errorReason: input.errorReason } : {}),
    ...(typeof input.httpStatus === 'number' &&
    Number.isInteger(input.httpStatus) &&
    input.httpStatus >= 100 &&
    input.httpStatus <= 599
      ? { httpStatus: input.httpStatus }
      : {}),
    ...(typeof input.retryable === 'boolean' ? { retryable: input.retryable } : {}),
    ...(input.transport === 'HTTP' || input.transport === 'WEBSOCKET'
      ? { transport: input.transport }
      : {})
  };
}

/** Invalid plugin results decline generation rather than altering the checkpoint contract. */
export function compactExtensionResult(
  value: unknown,
  budget: number
): ExtensionCompactResult | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('summary' in value) ||
    typeof value.summary !== 'string'
  )
    return undefined;
  const summary = value.summary.trim();
  if (!summary || countModelTokens(summary) > budget) return undefined;
  if (!('usage' in value) || value.usage === undefined) return { summary };
  if (value.usage === null || typeof value.usage !== 'object' || Array.isArray(value.usage))
    return undefined;
  const usage: ModelUsage = {};
  for (const [key, amount] of Object.entries(value.usage)) {
    if (!usageKeys.has(key)) return undefined;
    // Adapters may explicitly leave optional ModelUsage fields undefined.
    if (amount === undefined) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
    Object.assign(usage, { [key]: amount });
  }
  return { summary, usage };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface DomainCompactOperations {
  'compact.generate': {
    input: ExtensionCompactContext;
    output: ExtensionCompactResult | undefined;
  };
}
export type DomainCompactFacts = Record<never, never>;
