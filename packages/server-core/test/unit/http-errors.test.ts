import { domainErrorStatus } from '../../src/domain-errors.js';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorResponseOptions, safePublicError, sendError } from '../../src/http-errors.js';

function reply(requestId: string) {
  const result = {
    status: 0,
    body: undefined as unknown,
    request: { id: requestId },
    code(status: number) {
      this.status = status;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    }
  };
  return { result, response: result as unknown as FastifyReply };
}

describe('public HTTP error boundary', () => {
  it('preserves upstream capacity errors and correlation through the HTTP boundary', () => {
    const failure = safePublicError({
      code: 'service_unavailable_error',
      publicMessage: 'The model service is too busy.',
      publicDetails: 'Provider request ID: provider-request-1',
      upstreamRequestId: 'node-request-1'
    });
    const output = reply('server-request-1');
    sendError(output.response, 502, failure.code, errorResponseOptions(failure));
    expect(output.result.status).toBe(502);
    expect(output.result.body).toEqual({
      error: {
        code: 'service_unavailable_error',
        message: 'The model service is too busy.',
        details: 'Provider request ID: provider-request-1',
        requestId: 'server-request-1',
        upstreamRequestId: 'node-request-1'
      }
    });
  });

  it('preserves declared public messages, details, parameters and upstream correlation', () => {
    const failure = safePublicError({
      code: 'NODE_OFFLINE',
      publicMessage: 'The selected node is disconnected.',
      publicDetails: 'The control connection closed.',
      publicParameters: { nodeId: 'node-test' },
      upstreamRequestId: ' node-request-test '
    });
    const output = reply('req-test');
    sendError(output.response, 409, failure.code, errorResponseOptions(failure));
    expect(output.result.status).toBe(409);
    expect(output.result.body).toEqual({
      error: {
        code: 'NODE_OFFLINE',
        message: 'The selected node is disconnected.',
        details: 'The control connection closed.',
        parameters: { nodeId: 'node-test' },
        requestId: 'req-test',
        upstreamRequestId: 'node-request-test'
      }
    });
  });

  it('rejects invalid codes and malformed upstream request identifiers', () => {
    const output = reply('req-test');
    sendError(output.response, 400, 'not a code', {
      message: 'Not permitted as an invalid-code public message.',
      upstreamRequestId: 'bad\0id'
    });
    expect(output.result.status).toBe(500);
    expect(output.result.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(output.result.body)).not.toContain('invalid-code public message');
    expect(JSON.stringify(output.result.body)).not.toContain('upstreamRequestId');
  });

  it('does not expose arbitrary payload fields and retains readable default error semantics', () => {
    const failure = safePublicError({
      code: 'UNAUTHENTICATED',
      payload: { privateValue: 'test-only-private-value' }
    });
    expect(failure.message.length).toBeGreaterThan(10);
    expect(JSON.stringify(failure)).not.toContain('test-only-private-value');
    expect(
      safePublicError({ upstreamRequestId: 'x'.repeat(129) }).upstreamRequestId
    ).toBeUndefined();
  });
});

it('reports explicit user and Node in-use protection as stable conflicts', () => {
  expect(domainErrorStatus('USER_IN_USE')).toBe(409);
  expect(domainErrorStatus('NODE_IN_USE')).toBe(409);
});
