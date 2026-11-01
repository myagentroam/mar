import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContextService } from '../../src/session/session-context-service.js';
import type { NodeAgentSession } from '../../src/session/contracts.js';
import type { RunnerRegistry } from '../../src/runner/runner-registry.js';
import type { RunnerContextUsage } from '../../src/runner/contracts.js';

afterEach(() => vi.useRealTimers());

describe('Session context GC count', () => {
  it('publishes count-only and token-only changes and retains them in the authoritative snapshot', async () => {
    vi.useFakeTimers();
    const session = {
      id: 'session',
      workspaceId: 'workspace',
      runner: 'mar-agent',
      externalSessionId: 'native',
      modelId: 'model'
    } as NodeAgentSession;
    let usage: RunnerContextUsage = {
      usedTokens: 500,
      maxTokens: 1000,
      gcCount: 0,
      gcReclaimedTokens: 0
    };
    const publish = vi.fn();
    const service = new SessionContextService({
      runners: {
        product: () => ({ readContextUsage: async () => usage })
      } as unknown as RunnerRegistry,
      session: () => session,
      stopped: () => false,
      publish
    });
    try {
      expect((await service.read(session)).context).toEqual({
        model: 'model',
        usedTokens: 500,
        maxTokens: 1000,
        percentage: 50,
        gcCount: 0,
        gcReclaimedTokens: 0
      });
      usage = { ...usage, gcCount: 1 };
      service.schedule(session);
      await vi.advanceTimersByTimeAsync(100);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.[0].context.gcCount).toBe(1);
      expect(service.snapshot(session.id)?.gcCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1400);
      expect(publish).toHaveBeenCalledTimes(1);
      usage = { ...usage, gcReclaimedTokens: 12345 };
      service.schedule(session);
      await vi.advanceTimersByTimeAsync(100);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.[0].context.gcReclaimedTokens).toBe(12345);
      expect(service.snapshot(session.id)?.gcReclaimedTokens).toBe(12345);
      await vi.advanceTimersByTimeAsync(1400);
      expect(publish).toHaveBeenCalledTimes(2);
      usage = { usedTokens: 500, maxTokens: 1000 };
      service.schedule(session);
      await vi.advanceTimersByTimeAsync(100);
      expect(publish).toHaveBeenCalledTimes(3);
      expect(publish.mock.calls[2]?.[0].context).not.toHaveProperty('gcCount');
      expect(publish.mock.calls[2]?.[0].context).not.toHaveProperty('gcReclaimedTokens');
    } finally {
      service.dispose();
    }
  });
});
