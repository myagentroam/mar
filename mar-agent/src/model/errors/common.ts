import { AgentError } from '../../error.js';
import { classifyModelError, type ModelErrorRule, type UpstreamModelError } from './chain.js';

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const TRANSIENT_CAPACITY_CODES = new Set([
  'rate_limit_error',
  'overloaded_error',
  'api_overloaded',
  'server_is_overloaded',
  'system_cpu_overloaded',
  'resource_exhausted',
  'temporarily_unavailable',
  'service_unavailable'
]);

export function isRetryableModelHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function isTransientCapacityCode(code: string): boolean {
  return TRANSIENT_CAPACITY_CODES.has(code.toLowerCase());
}

export const streamCapacityRule: ModelErrorRule<UpstreamModelError> = {
  id: 'common.stream-capacity',
  action: 'retry',
  matches: ({ source, code }) =>
    source !== 'http' && code !== undefined && isTransientCapacityCode(code)
};

export const httpStatusRetryRule: ModelErrorRule<UpstreamModelError> = {
  id: 'common.http-status',
  action: 'retry',
  matches: ({ source, status }) =>
    source === 'http' && status !== undefined && isRetryableModelHttpStatus(status)
};

const httpErrorRules = [httpStatusRetryRule];

export function classifyHttpError(facts: UpstreamModelError) {
  return classifyModelError(httpErrorRules, facts);
}

/** Private classification carried from the protocol boundary without exposing rule metadata. */
export class RecoverableModelError extends AgentError {
  constructor(
    code: string,
    message: string,
    options?: ConstructorParameters<typeof AgentError>[2]
  ) {
    super(code, message, { ...options, retryable: true });
  }
}

export function isRecoverableModelError(error: unknown): error is AgentError {
  if (error instanceof RecoverableModelError) return true;
  if (!(error instanceof AgentError) || !error.retryable) return false;
  const { reason, status } = error.details ?? {};
  // Transport and Runtime errors, and the existing closed capacity contract for model adapters.
  return (
    reason === 'MODEL_PROGRESS_TIMEOUT' ||
    reason === 'MODEL_CONNECTION_TIMEOUT' ||
    reason === 'MODEL_TRANSPORT_FAILURE' ||
    (typeof status === 'number' && isRetryableModelHttpStatus(status)) ||
    isTransientCapacityCode(error.code)
  );
}

export function modelRetryAfter(error: AgentError): string | null {
  const value = error.details?.retryAfter;
  return typeof value === 'string' ? value : null;
}
