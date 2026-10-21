import { describe, expect, it, vi } from 'vitest';
import { createWebVersionUpdateService } from '../../src/service/WebVersionUpdateService';

describe('Web version update checks', () => {
  it('reports a new deployment identity when the version or build hash differs', async () => {
    const onUpdateAvailable = vi.fn();
    const service = createWebVersionUpdateService({
      currentVersion: '0.9.4',
      currentHash: 'build-a',
      fetchVersion: vi.fn(async () => ({ version: '0.9.4', hash: 'build-b' })),
      onUpdateAvailable
    });

    await service.check();
    await service.check();

    expect(onUpdateAvailable).toHaveBeenCalledTimes(2);
    expect(onUpdateAvailable).toHaveBeenLastCalledWith('0.9.4', 'build-b');
  });

  it('ignores matching, missing, or invalid versions', async () => {
    const onUpdateAvailable = vi.fn();
    const onVersionCurrent = vi.fn();
    const responses = [
      { version: '0.9.4', hash: 'build-a' },
      { version: '0.9.4' },
      null,
      { version: 1, hash: 'build-b' }
    ];
    const service = createWebVersionUpdateService({
      currentVersion: '0.9.4',
      currentHash: 'build-a',
      fetchVersion: vi.fn(async () => responses.shift()),
      onUpdateAvailable,
      onVersionCurrent
    });

    await service.check();
    await service.check();
    await service.check();
    await service.check();

    expect(onUpdateAvailable).not.toHaveBeenCalled();
    expect(onVersionCurrent).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent checks triggered by window focus', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchVersion = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const service = createWebVersionUpdateService({
      currentVersion: '0.9.4',
      currentHash: 'build-a',
      fetchVersion,
      onUpdateAvailable: vi.fn()
    });

    const first = service.check();
    const second = service.check();
    resolveFetch({ version: '0.9.4', hash: 'build-a' });
    await Promise.all([first, second]);

    expect(fetchVersion).toHaveBeenCalledOnce();
  });
});
