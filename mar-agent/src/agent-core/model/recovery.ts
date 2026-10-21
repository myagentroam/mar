import { MarAgentError } from '../error.js';
import { isAnthropicRecoverableStreamError } from './anthropic-messages.js';
import type { ModelRetryState } from './contracts.js';
import { isRetryableModelRequestError, modelRetryMaxAttempts, waitForModelRetry } from './http.js';
import { isOpenAiResponsesRecoverableStreamError } from './openai-responses.js';
/** Retry only classified recoverable failures within the attempt budget; never retry cancellation. */
export async function recoverModelStream(
  error: unknown,
  retryState: ModelRetryState,
  signal: AbortSignal
): Promise<boolean> {
  if (
    signal.aborted ||
    !(
      (error instanceof MarAgentError &&
        error.code === 'MAR_AGENT_MODEL_OUTPUT_INCOMPLETE' &&
        error.retryable) ||
      isRetryableModelRequestError(error) ||
      isOpenAiResponsesRecoverableStreamError(error) ||
      isAnthropicRecoverableStreamError(error)
    ) ||
    retryState.attempts >= modelRetryMaxAttempts(retryState)
  )
    return false;
  const delayMs = retryState.retryDelayMs;
  delete retryState.retryDelayMs;
  try {
    await waitForModelRetry(
      typeof error.details?.retryAfter === 'string' ? error.details.retryAfter : null,
      retryState.attempts - 1,
      signal,
      delayMs
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  return true;
}

const PROVIDER_CONTEXT_OVERFLOW_CODES = new Set([
  'mar_agent_context_limit',
  'context_length_exceeded',
  'context_overflow',
  'context_window_exceeded',
  'prompt_too_long',
  'request_too_large',
  'string_above_max_length'
]);

const PROVIDER_CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/iu,
  /request_too_large/iu,
  /input is too long for requested model/iu,
  /exceeds (?:the )?(?:model'?s )?(?:maximum )?context (?:length|window)/iu,
  /input token count.*exceeds the maximum/iu,
  /tokens in request more than max tokens allowed/iu,
  /maximum prompt length is \d+/iu,
  /reduce the length of the messages/iu,
  /maximum context length is \d+ tokens/iu,
  /exceeds (?:the )?maximum allowed input length/iu,
  /greater than the context length/iu,
  /context window exceeds limit/iu,
  /exceeded model token limit/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /request entity too large/iu,
  /input length.*exceeds.*context length/iu,
  /prompt too long; exceeded (?:max )?context length/iu,
  /model_context_window_exceeded/iu,
  /too many tokens/iu,
  /token limit exceeded/iu
];

const PROVIDER_CONTEXT_OVERFLOW_EXCLUSIONS = [
  /^(?:[^:]+: )?(?:throttling error|service unavailable):/iu,
  /rate limit/iu,
  /too many requests/iu
];

export function isProviderContextOverflow(error: unknown): boolean {
  if (!(error instanceof MarAgentError)) return false;
  const code = error.code.trim().toLowerCase();
  if (PROVIDER_CONTEXT_OVERFLOW_CODES.has(code)) return true;
  if (error.details?.status === 413) return true;
  const message = error.message;
  // K3-compatible gateways report context overflow as HTTP 401 instead of a
  // standard provider error code. Keep this exception scoped to that exact shape.
  if (error.details?.status === 401 && /supports only [\d,.]+[km]? context/iu.test(message))
    return true;
  if (code !== 'invalid_request_error' && code !== 'mar_agent_model_protocol_error') return false;
  return (
    !PROVIDER_CONTEXT_OVERFLOW_EXCLUSIONS.some((pattern) => pattern.test(message)) &&
    PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
  );
}
