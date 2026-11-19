import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/error.js';
import { classifyMessagesError } from '../../src/model/errors/anthropic-messages.js';
import { classifyModelError, type ModelErrorRule } from '../../src/model/errors/chain.js';
import { isRecoverableModelError } from '../../src/model/errors/common.js';
import {
  classifyResponsesError,
  classifyResponsesFallback
} from '../../src/model/errors/openai-responses.js';

describe('model error rule chain', () => {
  it('skips a miss and distinguishes an explicit failure from no match', () => {
    const rules: readonly ModelErrorRule<number>[] = [
      { id: 'miss', action: 'retry', matches: () => false },
      { id: 'stop', action: 'fail', matches: (status) => status === 403 },
      { id: 'fallback', action: 'retry', matches: (status) => status === 403 || status === 429 }
    ];

    expect(classifyModelError(rules, 403)).toMatchObject({ id: 'stop', action: 'fail' });
    expect(classifyModelError(rules, 429)).toMatchObject({ id: 'fallback', action: 'retry' });
    expect(classifyModelError(rules, 400)).toBeUndefined();
  });

  it('does not apply Responses stream rules in Messages or infer HTTP retries from stream status', () => {
    const facts = { source: 'sse', code: 'server_error', status: 503 } as const;
    expect(classifyResponsesError(facts)?.action).toBe('retry');
    expect(classifyMessagesError(facts)).toBeUndefined();
    expect(classifyResponsesError({ ...facts, code: 'permission_error' })).toBeUndefined();
    expect(classifyResponsesError({ ...facts, source: 'http' })?.id).toBe('common.http-status');
  });

  it('registers the exact Kimi 403/SSE exception only for Messages', () => {
    const facts = {
      source: 'http',
      status: 403,
      code: 'permission_error',
      message:
        "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again."
    } as const;
    expect(classifyMessagesError(facts)?.id).toBe('kimi-code.concurrent-request-limit');
    expect(classifyMessagesError({ ...facts, source: 'sse' })?.action).toBe('retry');
    expect(classifyMessagesError({ ...facts, message: 'Access denied.' })).toBeUndefined();
    expect(classifyResponsesError(facts)).toBeUndefined();
  });

  it('limits the Responses connection-limit rule to WebSocket events', () => {
    const facts = { code: 'websocket_connection_limit_reached' };
    expect(classifyResponsesError({ ...facts, source: 'websocket' })?.action).toBe('retry');
    expect(classifyResponsesError({ ...facts, source: 'sse' })).toBeUndefined();
  });

  it('honors continuation and credential eligibility without treating auth failures as stream retries', () => {
    const unauthorized = new AgentError('unauthorized', 'Expired.', { details: { status: 401 } });
    const missing = new AgentError('api_error', 'grpc error: response with id=abc not found');
    const eligibility = { resetContinuation: true, refreshCredential: true };
    expect(classifyResponsesFallback(unauthorized, eligibility)?.action).toBe('refreshCredential');
    expect(classifyResponsesFallback(missing, eligibility)?.action).toBe('resetContinuation');
    expect(
      classifyResponsesFallback(missing, { ...eligibility, resetContinuation: false })
    ).toBeUndefined();
    expect(
      classifyResponsesFallback(unauthorized, { ...eligibility, refreshCredential: false })
    ).toBeUndefined();
  });

  it('does not interpret a plain retryable flag or a bare provider code as a recovery decision', () => {
    expect(
      isRecoverableModelError(new AgentError('server_error', 'Unclassified.', { retryable: true }))
    ).toBe(false);
  });
});
