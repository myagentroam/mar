import { expect, it, vi } from 'vitest';
import { BrowserNodeService } from '../../src/browser/browser-node-service.js';

const mock = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: mock }));

it('only advertises Browser if Chromium can start and closes the probe process', async () => {
  const unavailable = new Error('Chromium could not load a system dependency');
  const close = vi.fn(async () => {});
  mock.launch.mockRejectedValueOnce(unavailable).mockResolvedValueOnce({ close });
  const failed = vi.fn();
  const service = new BrowserNodeService({
    root: 'unused',
    generation: 'node',
    requireWorkspace: () => {},
    workspacePath: () => undefined,
    relay: () => {
      throw new Error('not used');
    },
    failed
  });
  try {
    expect(await service.probe()).toBe(false);
    expect(await service.probe()).toBe(true);
    expect(failed).toHaveBeenCalledExactlyOnceWith(unavailable);
    expect(mock.launch).toHaveBeenCalledTimes(2);
    expect(mock.launch).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'chromium' }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await service.shutdown();
  }
});
