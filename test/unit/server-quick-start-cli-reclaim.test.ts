import { afterEach, describe, expect, it, vi } from 'vitest';

const argv = process.argv;
const exitCode = process.exitCode;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('../../mar-server/src/quick-start/setup.js');
});

describe('Quick Start reclaim diagnostic', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'reports a retained lock in %s for every managed component',
    async (locale) => {
      for (const component of ['NODE', 'MYSQL', 'SEARCH']) {
        vi.resetModules();
        vi.stubEnv('MAR_LOCALE', locale);
        process.argv = ['node', 'mar-server', 'setup'];
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.doMock('../../mar-server/src/quick-start/setup.js', () => ({
          setupQuickStart: async () => {
            throw new Error(`QUICK_START_${component}_RECLAIM_FAILED`);
          }
        }));
        await import('../../mar-server/src/quick-start/cli.js');
        expect(error).toHaveBeenCalledOnce();
        const message = String(error.mock.calls[0]?.[0]);
        expect(message).toContain(`QUICK_START_${component}_RECLAIM_FAILED`);
        expect(message).toContain(
          locale === 'zh-CN' ? '部署锁已保留' : 'deployment lock has been retained'
        );
        expect(message).not.toContain('--no-node');
        expect(process.exitCode).toBe(1);
        error.mockRestore();
      }
    }
  );
});
