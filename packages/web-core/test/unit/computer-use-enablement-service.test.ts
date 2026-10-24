import { describe, expect, it, vi } from 'vitest';
import { createComputerUseEnablementService } from '../../src/service/computer-use-enablement-service.js';

const capability = {
  apiVersion: 1 as const,
  enabled: true,
  state: 'INITIALIZING' as const,
  backend: 'PYAUTOGUI' as const,
  supportsScreenshot: false,
  supportsInput: false,
  supportsUnicodePaste: false,
  supportsPrimaryDisplay: false,
  measuredAt: 1
};

describe('Computer Use enablement service', () => {
  it('uses strict fixed management routes and parses capability results', async () => {
    const calls = vi.fn();
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls(path, init);
      return { capability } as T;
    };
    const service = createComputerUseEnablementService(request);
    await expect(service.enable('node/1')).resolves.toEqual(capability);
    expect(calls).toHaveBeenNthCalledWith(1, '/api/management/nodes/node%2F1/computer-use/enable', {
      method: 'POST',
      body: JSON.stringify({ enabled: true })
    });
    await expect(service.disable('node/1')).resolves.toEqual(capability);
    expect(calls).toHaveBeenNthCalledWith(
      2,
      '/api/management/nodes/node%2F1/computer-use/disable',
      { method: 'POST', body: JSON.stringify({}) }
    );
  });

  it('rejects malformed Server responses', async () => {
    const request = async <T>(): Promise<T> =>
      ({ capability: { enabled: true, state: 'AVAILABLE' } }) as T;
    const service = createComputerUseEnablementService(request);
    await expect(service.enable('node-1')).rejects.toThrow();
  });
});
