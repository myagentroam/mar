import { describe, expect, it, vi } from 'vitest';
import type { NodeSummary } from '../../src/model/workbench.js';
import { createRunnerUsageService } from '../../src/service/runner-usage-service.js';

describe('Runner usage service', () => {
  it('forwards the original usage query failure to the error callback', async () => {
    const failure = new Error('NETWORK_FAILURE');
    const request = vi
      .fn()
      .mockResolvedValueOnce({ statuses: [] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ statuses: [] });
    const error = vi.fn();
    const service = createRunnerUsageService({
      request: request as never,
      error,
      errorMessage: (cause) => (cause instanceof Error ? cause.message : String(cause))
    });

    service.openNode({ id: 'node-1' } as NodeSummary);
    await vi.waitFor(() => expect(service.statuses.value).toEqual([]));
    await service.show('codex');

    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NETWORK_FAILURE'), failure);
  });
});
