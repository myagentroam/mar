import type { ModelMessage, ModelUsage } from '../model/contracts.js';
import { countModelTokens } from '../runtime/token-budget.js';

export interface CoreCompactDiagnostic {
  readonly modelId: string;
  readonly providerModelId?: string;
  readonly reasoningEffort: string;
  readonly state: 'STARTED' | 'SUCCEEDED' | 'DECLINED' | 'FAILED';
  readonly inputTokensEstimateBefore: number;
  readonly inputTokensEstimateAfter: number;
  readonly modelRequests: number;
  readonly elapsedMs: number;
  readonly reason?: 'INPUT_BUDGET_EXHAUSTED' | 'MODEL_INCOMPLETE' | 'MODEL_FAILED';
  readonly errorCode?: string;
}

export interface CoreCompactMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'tool_call';
  readonly content: string;
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}
export interface CoreCompactContext {
  readonly reportModelUsage?:
    | ((usage: import('../model/usage-observer.js').ModelRequestUsage) => Promise<void> | void)
    | undefined;
  readonly operationId: string;
  readonly reason: 'manual' | 'automatic';
  readonly messages: readonly CoreCompactMessage[];
  readonly focus?: string;
  readonly summaryTokenBudget: number;
  /** Return the Core's default structured handoff contract, independent of model configuration. */
  readonly getPrompt: () => string;
  /** Private, bounded telemetry only; reporting never changes the generation result. */
  readonly reportDiagnostic?: (diagnostic: CoreCompactDiagnostic) => Promise<void>;
}
export interface CoreCompactResult {
  readonly summary: string;
  readonly usage?: Readonly<ModelUsage>;
}

/** Copy only neutral evidence; a hook never receives provider payloads or history ownership. */
export function compactExtensionMessages(
  messages: readonly ModelMessage[]
): readonly CoreCompactMessage[] {
  return freeze(
    messages
      .filter(
        (message) =>
          message.role !== 'provider' &&
          !['environment', 'private', 'compact_control'].includes(message.contextKind ?? '')
      )
      .map((message) => ({
        role: message.role as CoreCompactMessage['role'],
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
export function compactExtensionDiagnostic(value: unknown): CoreCompactDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const label = (value: unknown, limit: number): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\r\n]/u.test(value);
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
    state: input.state as CoreCompactDiagnostic['state'],
    inputTokensEstimateBefore: input.inputTokensEstimateBefore as number,
    inputTokensEstimateAfter: input.inputTokensEstimateAfter as number,
    modelRequests: input.modelRequests as number,
    elapsedMs: input.elapsedMs as number,
    ...(label(input.providerModelId, 256) ? { providerModelId: input.providerModelId } : {}),
    ...(typeof input.reason === 'string' &&
    ['INPUT_BUDGET_EXHAUSTED', 'MODEL_INCOMPLETE', 'MODEL_FAILED'].includes(input.reason)
      ? { reason: input.reason as NonNullable<CoreCompactDiagnostic['reason']> }
      : {}),
    ...(typeof input.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(input.errorCode)
      ? { errorCode: input.errorCode }
      : {})
  };
}

/** Invalid plugin results decline generation rather than altering the checkpoint contract. */
export function compactExtensionResult(
  value: unknown,
  budget: number
): CoreCompactResult | undefined {
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
