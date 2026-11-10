import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  initialize: vi.fn(async () => {})
}));
vi.mock('../../mar-server/src/quick-start/lock.js', () => ({
  acquireQuickStartLock: async () => fixture.release
}));
vi.mock('../../mar-server/src/quick-start/config.js', () => ({
  resolveQuickStartConfigPath: () => '/fixture/server.json',
  readQuickStartConfig: async () => ({
    mysql: {},
    node: { enabled: false },
    search: { mode: 'disabled' }
  }),
  selectQuickStartComponents: (config: unknown) => config,
  writeQuickStartConfig: async () => {}
}));
vi.mock('../../mar-server/src/quick-start/mysql-installation.js', () => ({
  prepareMysqlInstallation: async () => ({})
}));
vi.mock('../../mar-server/src/quick-start/mysql-runtime.js', () => ({
  initializeManagedMysql: fixture.initialize
}));

import { setupQuickStart } from '../../mar-server/src/quick-start/setup.js';

describe('Quick Start setup cleanup', () => {
  it('retains the lock if MySQL could not be reclaimed', async () => {
    fixture.initialize.mockRejectedValueOnce(new Error('QUICK_START_MYSQL_RECLAIM_FAILED'));
    await expect(setupQuickStart({ command: 'setup' })).rejects.toThrow(
      'QUICK_START_MYSQL_RECLAIM_FAILED'
    );
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('retains the lock if a preparation process could not be reclaimed', async () => {
    fixture.release.mockClear();
    fixture.initialize.mockRejectedValueOnce(new Error('QUICK_START_NODE_RECLAIM_FAILED'));
    await expect(setupQuickStart({ command: 'setup' })).rejects.toThrow(
      'QUICK_START_NODE_RECLAIM_FAILED'
    );
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('releases the lock after a confirmed forced MySQL exit but reports failure', async () => {
    fixture.release.mockClear();
    fixture.initialize.mockRejectedValueOnce(new Error('QUICK_START_MYSQL_FORCED_STOP'));
    await expect(setupQuickStart({ command: 'setup' })).rejects.toThrow(
      'QUICK_START_MYSQL_FORCED_STOP'
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
