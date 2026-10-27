import { describe, expect, it, vi } from 'vitest';
import { createExecutionCodeModeContext } from '../../src/sdk/execution-code-mode.js';

describe('execution code mode retention', () => {
  it('releases the retained lease if extension pinning fails', async () => {
    const release = vi.fn(async () => {});
    const failure = new Error('pin failed');
    const create = createExecutionCodeModeContext({
      store: {
        readCodeModeState: async () => [],
        retainSessionLease: async () => release
      } as never,
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      writerOwner: {},
      supportsImages: false,
      tools: [],
      permissionStop: () => undefined,
      assertLive: () => {},
      pin: () => {
        throw failure;
      },
      cleanupFailed: () => {}
    });
    const context = await create({ name: 'code_exec', callId: 'call' } as never);
    await expect(context.retainSession()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  });
});
