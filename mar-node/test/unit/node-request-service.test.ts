import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import { NodeRequestService } from '../../src/service/node-request-service.js';

const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 15_000;
const CLOCK_SKEW_MS = 60 * 60 * 1_000;
const NODE_ID = 'node-1';
const REQUEST_ID = 'request-1';
const OPERATION = 'workspace.list';
const SESSION_HASH = 'a'.repeat(43);

function fixture(
  authorizationOverrides: Record<string, unknown> = {},
  includeAuthorization = true
) {
  const authorization = {
    userId: 1,
    sessionHash: SESSION_HASH,
    nodeId: NODE_ID,
    operation: OPERATION,
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...authorizationOverrides
  };
  const request = createEnvelope(
    'node.request',
    {
      operation: OPERATION,
      data: {},
      ...(includeAuthorization ? { userAuthorization: authorization } : {})
    },
    { id: REQUEST_ID }
  );
  const execute = vi.fn(async (_operation: string, _data: unknown): Promise<unknown> => ({
    workspaces: []
  }));
  const send = vi.fn();
  const service = new NodeRequestService({
    nodeId: () => NODE_ID,
    databaseAvailable: () => true,
    execute,
    send
  });
  return { request, execute, send, service };
}

afterEach(() => vi.restoreAllMocks());

describe('Node request user authorization', () => {
  it('binds Server-prepared execution model resources and strips a forged body value', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const caller = { type: 'execution', sessionId: 'source', executionId: 'execution' };
    const prepared = { marAgentModel: { id: 'eligible' }, marAgentRuntimeScopeId: 'scope' };
    const execute = vi.fn(async () => ({ accepted: true }));
    const send = vi.fn();
    const service = new NodeRequestService({
      nodeId: () => NODE_ID,
      databaseAvailable: () => true,
      resolveMarctlCaller: () => caller,
      authorizeMarctlOperation: async () => {},
      execute,
      send
    });
    const request = createEnvelope(
      'node.request',
      {
        operation: 'agent.network',
        data: { action: 'start', __marctlExecutionResources: { marAgentModel: { id: 'forged' } } },
        userAuthorization: {
          userId: 1,
          sessionHash: SESSION_HASH,
          nodeId: NODE_ID,
          operation: 'agent.network',
          requestId: REQUEST_ID,
          issuedAt: ISSUED_AT,
          expiresAt: EXPIRES_AT,
          marctlCaller: caller,
          marctlExecutionResources: prepared
        }
      },
      { id: REQUEST_ID }
    );
    await service.handle(request);
    expect(execute).toHaveBeenCalledWith(
      'agent.network',
      expect.objectContaining({
        __marctlCaller: caller,
        __marctlExecutionResources: prepared
      })
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain('marAgentModel');
  });
  it('cancels the matching wait with a trusted signal and ignores a caller-supplied signal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const f = fixture({ operation: 'agent.network' });
    const forged = new AbortController();
    let received: AbortSignal | undefined;
    f.execute.mockImplementation(async (_operation, data) => {
      received = (data as { __requestAbortSignal: AbortSignal }).__requestAbortSignal;
      await new Promise<void>((resolve) =>
        received!.addEventListener('abort', () => resolve(), { once: true })
      );
      return { cancelled: received.aborted };
    });
    const pending = f.service.handle({
      ...f.request,
      payload: {
        ...(f.request.payload as Record<string, unknown>),
        operation: 'agent.network',
        data: { action: 'wait', __requestAbortSignal: forged.signal }
      }
    });
    await vi.waitFor(() => expect(received).toBeDefined());
    expect(received).not.toBe(forged.signal);
    f.service.cancelWait('different-request');
    expect(received!.aborted).toBe(false);
    f.service.cancelWait(REQUEST_ID);
    await pending;
    expect(received!.aborted).toBe(true);
    expect(f.send).toHaveBeenCalledWith(
      'node.response',
      { result: { cancelled: true } },
      REQUEST_ID
    );
  });

  it('forwards the authenticated initiator and private usage grant instead of client-supplied attribution', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const usageGrant = {
      scopeId: '00000000-0000-4000-8000-000000000001',
      token: 'signed-usage-assertion'
    };
    const f = fixture({ usageGrant });
    await f.service.handle({
      ...f.request,
      payload: {
        ...(f.request.payload as Record<string, unknown>),
        data: { __requestUserId: 99, __usageGrant: 'untrusted' }
      }
    });
    expect(f.execute).toHaveBeenCalledWith(
      OPERATION,
      expect.objectContaining({ __requestUserId: 1, __usageGrant: usageGrant })
    );
    expect(JSON.stringify(f.send.mock.calls)).not.toContain(usageGrant.token);
  });
  it.each([
    ['synchronized clocks', ISSUED_AT],
    ['Server clock ahead by thirty minutes', ISSUED_AT - CLOCK_SKEW_MS / 2],
    ['Server clock behind by thirty minutes', ISSUED_AT + CLOCK_SKEW_MS / 2],
    ['Server clock ahead by exactly one hour', ISSUED_AT - CLOCK_SKEW_MS],
    ['Server clock behind by exactly one hour', ISSUED_AT + CLOCK_SKEW_MS],
    ['expiry boundary plus exactly one hour', EXPIRES_AT + CLOCK_SKEW_MS]
  ])('executes authorized requests with %s', async (_name, now) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = fixture();

    await f.service.handle(f.request);

    expect(f.execute).toHaveBeenCalledExactlyOnceWith(OPERATION, {
      __workspaceWatchSessionHash: SESSION_HASH,
      __requestUserId: 1
    });
    expect(Object.hasOwn(f.execute.mock.calls[0]![1] as object, '__usageGrant')).toBe(false);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'node.response',
      { result: { workspaces: [] } },
      REQUEST_ID
    );
  });

  it.each([
    ['issue boundary', ISSUED_AT - CLOCK_SKEW_MS - 1],
    ['expiry boundary', EXPIRES_AT + CLOCK_SKEW_MS + 1]
  ])('rejects requests one millisecond beyond the %s tolerance', async (_name, now) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = fixture();

    await f.service.handle(f.request);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'node.response',
      expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
      REQUEST_ID
    );
  });

  it.each([
    ['invalid user', { userId: 0 }],
    ['invalid session fingerprint', { sessionHash: 'a'.repeat(42) }],
    ['different Node', { nodeId: 'node-2' }],
    ['different operation', { operation: 'node.metrics' }],
    ['different request', { requestId: 'request-2' }],
    ['authorization lifetime above fifteen seconds', { expiresAt: EXPIRES_AT + 1 }],
    [
      'expiry before issue time',
      { issuedAt: ISSUED_AT + CLOCK_SKEW_MS / 2, expiresAt: ISSUED_AT - CLOCK_SKEW_MS / 2 }
    ],
    ['missing issue time', { issuedAt: undefined }],
    ['invalid expiry time', { expiresAt: NaN }]
  ])('preserves rejection of %s despite clock tolerance', async (_name, overrides) => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const f = fixture(overrides);

    await f.service.handle(f.request);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'node.response',
      expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
      REQUEST_ID
    );
  });

  it('rejects missing user authorization without executing the operation', async () => {
    const f = fixture({}, false);

    await f.service.handle(f.request);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(
      'node.response',
      expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
      REQUEST_ID
    );
  });

  it('accepts only the bound model resource capability identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const f = fixture({
      userId: 0,
      sessionHash: 'model-resource',
      operation: 'model.resource.read'
    });
    const request = {
      ...f.request,
      payload: {
        ...(f.request.payload as Record<string, unknown>),
        operation: 'model.resource.read'
      }
    };
    await f.service.handle(request);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith('model.resource.read', {
      __workspaceWatchSessionHash: 'model-resource',
      __requestUserId: 0
    });

    f.execute.mockClear();
    await f.service.handle({
      ...request,
      payload: {
        ...request.payload,
        operation: OPERATION,
        userAuthorization: {
          ...((request.payload as Record<string, unknown>).userAuthorization as Record<
            string,
            unknown
          >),
          operation: OPERATION
        }
      }
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenLastCalledWith(
      'node.response',
      expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
      REQUEST_ID
    );
  });

  it('rejects requests before the Node identity is available', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(ISSUED_AT);
    const f = fixture();
    const service = new NodeRequestService({
      nodeId: () => undefined,
      databaseAvailable: () => true,
      execute: f.execute,
      send: f.send
    });

    await service.handle(f.request);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(
      'node.response',
      expect.objectContaining({ error: 'USER_AUTHORIZATION_REQUIRED' }),
      REQUEST_ID
    );
  });
});
