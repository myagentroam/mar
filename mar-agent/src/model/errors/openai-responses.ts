import type { AgentError } from '../../error.js';
import {
  classifyModelError,
  type ContinuationErrorFacts,
  type ModelErrorRule,
  type UpstreamModelError
} from './chain.js';
import { httpStatusRetryRule, streamCapacityRule } from './common.js';
import { openAiContinuationErrorRule, openAiStreamErrorRules } from './rules/openai.js';
import { xAiContinuationErrorRule } from './rules/xai.js';

const responsesErrorRules: readonly ModelErrorRule<UpstreamModelError>[] = [
  {
    id: 'responses.websocket-connection-limit',
    action: 'retry',
    reason: 'OPENAI_RESPONSES_WEBSOCKET_CONNECTION_LIMIT',
    matches: ({ source, code }) =>
      source === 'websocket' && code?.trim().toLowerCase() === 'websocket_connection_limit_reached'
  },
  ...openAiStreamErrorRules,
  streamCapacityRule,
  httpStatusRetryRule
];

export function classifyResponsesError(facts: UpstreamModelError) {
  return classifyModelError(responsesErrorRules, facts);
}

interface FallbackEligibility {
  readonly resetContinuation: boolean;
  readonly refreshCredential: boolean;
}

interface FallbackFacts extends FallbackEligibility, ContinuationErrorFacts {
  readonly status: number | undefined;
}

const fallbackRules: readonly ModelErrorRule<
  FallbackFacts,
  'resetContinuation' | 'refreshCredential'
>[] = [
  openAiContinuationErrorRule,
  xAiContinuationErrorRule,
  {
    id: 'responses.unauthorized',
    action: 'refreshCredential',
    matches: ({ refreshCredential, status, code }) =>
      refreshCredential && (status === undefined ? code === 'unauthorized' : status === 401)
  }
];

export function classifyResponsesFallback(error: AgentError, eligibility: FallbackEligibility) {
  const status = typeof error.details?.status === 'number' ? error.details.status : undefined;
  return classifyModelError(fallbackRules, {
    ...eligibility,
    resetContinuation:
      eligibility.resetContinuation && (status === undefined || [400, 404, 410].includes(status)),
    status,
    code: error.code.toLowerCase(),
    message: error.message.toLowerCase().replaceAll('`', '')
  });
}
