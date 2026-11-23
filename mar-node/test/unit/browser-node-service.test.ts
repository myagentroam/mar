import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { BrowserNodeService } from '../../src/browser/browser-node-service.js';

const mock = vi.hoisted(() => ({ launch: vi.fn(), encode: vi.fn() }));
vi.mock('playwright', () => ({
  chromium: { executablePath: () => process.execPath, launch: mock.launch }
}));
vi.mock('../../src/browser/browser-video-encoder.js', () => ({
  createBrowserVideoEncoder: async () => ({ encode: mock.encode, close: async () => {} })
}));

it('requires a real encoded sample and reopens a failed or disconnected encoder host', async () => {
  function host() {
    return Object.assign(new EventEmitter(), {
      isConnected: () => true,
      close: vi.fn(),
      newPage: async () => ({
        route: async () => {},
        goto: async () => {},
        screenshot: async () => Buffer.from([1]),
        close: async () => {}
      })
    });
  }
  const first = host();
  const replacement = host();
  mock.launch
    .mockRejectedValueOnce(new Error('launch failed'))
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(replacement);
  mock.encode
    .mockResolvedValueOnce({ key: true, data: Buffer.alloc(0) })
    .mockResolvedValue({ key: true, data: Buffer.from([2]) });
  const service = new BrowserNodeService({
    root: 'unused',
    generation: 'node',
    requireWorkspace: () => {},
    workspacePath: () => undefined,
    relay: () => {
      throw new Error('not used');
    },
    failed: vi.fn()
  });
  try {
    expect(await service.probe()).toBe(false);
    expect(await service.probe()).toBe(false);
    expect(await service.probe()).toBe(true);
    expect(mock.launch).toHaveBeenCalledTimes(2);
    first.emit('disconnected');
    expect(await service.probe()).toBe(true);
    expect(mock.launch).toHaveBeenCalledTimes(3);
  } finally {
    await service.shutdown();
  }
  expect(replacement.close).toHaveBeenCalledOnce();
});
