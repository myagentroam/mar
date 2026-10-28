import { expect, it, vi } from 'vitest';
import { ExternalSessionResumeService } from '../../src/service/external-session-resume-service.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';

it('joins accepted resume work before clearing its failure timer and state', async () => {
  vi.useFakeTimers();
  try {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const service = new ExternalSessionResumeService({
      runtime: { getAgentSession: () => undefined, beginSessionHistoryMutation: () => () => {} },
      runners: { product: () => ({ resumeExternal: () => gate }) },
      available: () => true,
      projectionFor: () => undefined,
      managedAliasFor: () => undefined,
      ensureConfiguration: (session: NodeAgentSession) => session,
      configuration: () => ({}),
      workspacePath: () => undefined,
      rememberNative: () => {},
      resolve: async () => undefined
    } as unknown as ConstructorParameters<typeof ExternalSessionResumeService>[0]);
    const session = { id: 'session', runner: 'codex', cwd: '/workspace' } as NodeAgentSession;
    const resuming = service.resume(session);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release({ status: 'UNAVAILABLE', code: 'TEST_FAILURE' });
    await Promise.all([resuming, closing]);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.activity('session')).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
