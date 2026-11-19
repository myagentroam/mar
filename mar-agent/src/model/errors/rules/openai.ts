import type { ContinuationErrorFacts, ModelErrorRule, UpstreamModelError } from '../chain.js';
import { isRetryableModelHttpStatus } from '../common.js';

const TRANSIENT_ACCESS_CHECK_CODE = 'invalid_request_error';
const TRANSIENT_ACCESS_CHECK_MESSAGE = 'Unable to verify Daybreak Blue access. Please try again.';
const PREFIXED_ACCESS_CHECK_MESSAGE = `${TRANSIENT_ACCESS_CHECK_CODE}: ${TRANSIENT_ACCESS_CHECK_MESSAGE}`;

export const openAiStreamErrorRules: readonly ModelErrorRule<UpstreamModelError>[] = [
  {
    id: 'openai.responses-server-error',
    action: 'retry',
    // An upstream response-stream failure, not a local protocol parsing error.
    matches: ({ source, code }) => source !== 'http' && code === 'server_error'
  },
  {
    id: 'openai.responses-transient-access-check',
    action: 'retry',
    matches: ({ source, code, message, status }) =>
      source !== 'http' &&
      code === TRANSIENT_ACCESS_CHECK_CODE &&
      (message === TRANSIENT_ACCESS_CHECK_MESSAGE ||
        // A code-prefixed summary was recoverable only with an explicit transient status.
        (status !== undefined &&
          isRetryableModelHttpStatus(status) &&
          message === PREFIXED_ACCESS_CHECK_MESSAGE))
  },
  {
    id: 'openai.responses-prefixed-access-check',
    action: 'fail',
    reportedRetryable: true,
    matches: ({ source, code, message }) =>
      source !== 'http' &&
      code === TRANSIENT_ACCESS_CHECK_CODE &&
      message === PREFIXED_ACCESS_CHECK_MESSAGE
  }
];

export const openAiContinuationErrorRule: ModelErrorRule<
  ContinuationErrorFacts,
  'resetContinuation'
> = {
  id: 'openai.responses-invalid-reference',
  action: 'resetContinuation',
  matches: ({ resetContinuation, code, message }) =>
    resetContinuation && isInvalidResponsesReference(code.trim(), message)
};

function isInvalidResponsesReference(code: string, message: string): boolean {
  if (code === 'previous_response_not_found' || code === 'invalid_previous_response_id')
    return true;
  if (code === 'unsupported_parameter' || code === 'unsupported_previous_response_id')
    return message.includes('previous_response_id');

  // Explicit auth, permission and overload codes cannot become continuation errors.
  return (
    (code === 'invalid_request_error' ||
      code === 'api_error' ||
      code === 'mar_agent_model_protocol_error') &&
    message.includes('previous_response_id') &&
    (message.includes('invalid') ||
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('expired') ||
      message.includes('not supported') ||
      message.includes('unsupported') ||
      message.includes('unavailable'))
  );
}
