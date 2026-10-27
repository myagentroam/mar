import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionToolPermissions,
  type ToolApprovalDecision,
  type ToolApprovalHandler,
  type ToolApprovalRequest
} from '../../src/tools/permissions.js';
import type { ClientToolDefinition, ToolCall } from '../../src/tools/contracts.js';

const tool: ClientToolDefinition = {
  name: 'exec',
  description: 'Execute a command.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
    additionalProperties: false
  }
};
const context = { sessionId: 'session', executionId: 'execution', actor: 'model' as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function askCall(callId: string, arguments_: unknown): ToolCall {
  return {
    name: 'exec',
    callId,
    arguments: {
      ...(arguments_ as Record<string, unknown>),
      permission: { action: 'ask', reason: 'Confirm ' + callId + '.' }
    }
  };
}

function prepared(policy: ExecutionToolPermissions, callId: string, arguments_: unknown) {
  return policy.prepare(askCall(callId, arguments_), context, tool);
}

function approvalPolicy(request: ToolApprovalHandler, signal = new AbortController().signal) {
  return new ExecutionToolPermissions(
    'auto',
    { sessionId: 'session', executionId: 'execution' },
    {
      request,
      signal
    }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('online tool approval', () => {
  it('keeps an ask prepared but undispatched while waiting, then authorizes the unchanged call', async () => {
    const received = deferred<{ request: ToolApprovalRequest; signal: AbortSignal }>();
    const decision = deferred<ToolApprovalDecision>();
    const policy = approvalPolicy((request, signal) => {
      received.resolve({ request, signal });
      return decision.promise;
    });
    const call = prepared(policy, 'call', { command: 'echo original' });

    expect(call).toMatchObject({
      name: 'exec',
      callId: 'call',
      arguments: { command: 'echo original' },
      permission: { action: 'ask', reason: 'Confirm call.' }
    });
    expect(policy.stop).toBeUndefined();
    const authorization = policy.authorize(call, context);
    const { request, signal } = await received.promise;
    expect(request).toMatchObject({
      reason: 'Confirm call.',
      source: { sessionId: 'session', executionId: 'execution', callId: 'call', toolName: 'exec' },
      input: { command: 'echo original' }
    });
    expect(signal.aborted).toBe(false);
    expect(policy.stop).toBeUndefined();

    decision.resolve('APPROVED');
    await expect(authorization).resolves.toMatchObject({
      callId: 'call',
      arguments: { command: 'echo original' }
    });
  });

  it('isolates concurrent approvals so each decision applies only to its own call', async () => {
    const firstRequest = deferred<ToolApprovalRequest>();
    const secondRequest = deferred<ToolApprovalRequest>();
    const firstDecision = deferred<ToolApprovalDecision>();
    const secondDecision = deferred<ToolApprovalDecision>();
    const policy = approvalPolicy((request) => {
      const first = request.source.callId === 'first';
      (first ? firstRequest : secondRequest).resolve(request);
      return (first ? firstDecision : secondDecision).promise;
    });
    const first = policy.authorize(prepared(policy, 'first', { command: 'first' }), context);
    const second = policy.authorize(prepared(policy, 'second', { command: 'second' }), context);
    const [firstApproval, secondApproval] = await Promise.all([
      firstRequest.promise,
      secondRequest.promise
    ]);

    expect(firstApproval.approvalId).not.toBe(secondApproval.approvalId);
    expect(firstApproval.input).toEqual({ command: 'first' });
    expect(secondApproval.input).toEqual({ command: 'second' });
    firstDecision.resolve('APPROVED');
    await expect(first).resolves.toMatchObject({ callId: 'first' });
    expect(policy.stop).toBeUndefined();
    secondDecision.resolve('REJECTED');
    await expect(second).rejects.toMatchObject({ code: 'MAR_AGENT_APPROVAL_REJECTED' });
    expect(policy.stop).toBeUndefined();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'expires a late %s even before the timeout callback runs',
    async (response) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const received = deferred<{ request: ToolApprovalRequest; signal: AbortSignal }>();
      const decision = deferred<ToolApprovalDecision>();
      const policy = approvalPolicy((request, signal) => {
        received.resolve({ request, signal });
        return decision.promise;
      });
      const authorization = policy.authorize(
        prepared(policy, 'late-allow', { command: 'echo too late' }),
        context
      );
      const failure = expect(authorization).rejects.toMatchObject({
        code: 'MAR_AGENT_APPROVAL_EXPIRED'
      });
      const { request, signal } = await received.promise;

      vi.setSystemTime(request.expiresAt);
      expect(signal.aborted).toBe(false);
      decision.resolve(response);
      await failure;
      expect(policy.stop).toBeUndefined();
    }
  );

  it('expires a pending request after ten minutes without stopping the execution', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const received = deferred<void>();
    const decision = deferred<ToolApprovalDecision>();
    const policy = approvalPolicy(() => {
      received.resolve();
      return decision.promise;
    });
    const authorization = policy.authorize(
      prepared(policy, 'expired', { command: 'echo wait' }),
      context
    );
    const failure = expect(authorization).rejects.toMatchObject({
      code: 'MAR_AGENT_APPROVAL_EXPIRED'
    });
    await received.promise;

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await failure;
    expect(policy.stop).toBeUndefined();
    expect(
      policy.prepare(
        { name: 'exec', callId: 'next', arguments: { command: 'echo next' } },
        context,
        tool
      ).arguments
    ).toEqual({ command: 'echo next' });

    decision.resolve('APPROVED');
    await Promise.resolve();
    expect(policy.stop).toBeUndefined();
  });

  it('does not authorize after cancellation and ignores a later approval response', async () => {
    const execution = new AbortController();
    const received = deferred<{ signal: AbortSignal }>();
    const decision = deferred<ToolApprovalDecision>();
    const policy = approvalPolicy((_request, signal) => {
      received.resolve({ signal });
      return decision.promise;
    });
    const authorization = policy.authorize(
      prepared(policy, 'cancelled', { command: 'echo cancelled' }),
      { ...context, signal: execution.signal }
    );
    const { signal } = await received.promise;

    execution.abort();
    await expect(authorization).rejects.toBeDefined();
    expect(signal.aborted).toBe(true);
    decision.resolve('APPROVED');
    await Promise.resolve();
    expect(policy.stop).toBeUndefined();
  });

  it('protects the captured business input from later caller and handler mutation', async () => {
    const received = deferred<ToolApprovalRequest>();
    const decision = deferred<ToolApprovalDecision>();
    const policy = approvalPolicy((request) => {
      received.resolve(request);
      return decision.promise;
    });
    const source = {
      command: 'echo original',
      details: { label: 'original' },
      permission: { action: 'ask', reason: 'Confirm captured input.' }
    };
    const call = policy.prepare(
      { name: 'exec', callId: 'snapshot', arguments: source },
      context,
      tool
    );
    const authorization = policy.authorize(call, context);
    const request = await received.promise;

    expect(request.input).toEqual({
      command: 'echo original',
      details: { label: 'original' }
    });
    source.command = 'echo caller-mutated';
    source.details.label = 'caller-mutated';
    (request.input as { command: string; details: { label: string } }).details.label =
      'handler-mutated';
    decision.resolve('APPROVED');

    await expect(authorization).resolves.toMatchObject({
      callId: 'snapshot',
      arguments: { command: 'echo original', details: { label: 'original' } }
    });
  });
});
