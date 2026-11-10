import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
  mysqlStop: vi.fn(async () => {}),
  nodeStop: vi.fn(async (): Promise<void> => {
    throw new Error('QUICK_START_NODE_RECLAIM_FAILED');
  })
}));
vi.mock('../../mar-server/src/quick-start/lock.js', () => ({
  acquireQuickStartLock: async () => fixture.release
}));
vi.mock('../../mar-server/src/quick-start/config.js', () => ({
  resolveQuickStartConfigPath: () => '/fixture/server.json',
  readQuickStartConfig: async () => ({
    serverPort: 41331,
    mysql: { password: 'fixture' },
    node: { enabled: true },
    search: { mode: 'disabled' }
  })
}));
vi.mock('../../mar-server/src/quick-start/mysql-runtime.js', () => ({
  startManagedMysql: async () => ({
    exited: new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fixture')), 20)),
    stop: fixture.mysqlStop
  }),
  waitForMysql: async () => ({ end: async () => {} })
}));
vi.mock('../../mar-server/src/quick-start/application.js', () => ({
  createLocalApplication: async () => ({
    app: { listen: async () => {}, shutdown: fixture.shutdown },
    quickStartNode: {}
  })
}));
vi.mock('../../mar-server/src/quick-start/node-runtime.js', () => ({
  startLocalNode: async () => ({
    online: async () => true,
    exited: new Promise(() => {}),
    stop: fixture.nodeStop
  })
}));

import { runQuickStart } from '../../mar-server/src/quick-start/run.js';

describe('Quick Start run cleanup', () => {
  it('retains the deployment lock if the owned Node cannot be reclaimed', async () => {
    await expect(runQuickStart({ command: 'run' })).rejects.toThrow(
      'QUICK_START_NODE_RECLAIM_FAILED'
    );
    expect(fixture.nodeStop).toHaveBeenCalledOnce();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.mysqlStop).toHaveBeenCalledOnce();
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('retains the deployment lock if MySQL cannot be reclaimed', async () => {
    fixture.release.mockClear();
    fixture.nodeStop.mockResolvedValueOnce(undefined);
    fixture.mysqlStop.mockRejectedValueOnce(new Error('QUICK_START_MYSQL_RECLAIM_FAILED'));
    await expect(runQuickStart({ command: 'run' })).rejects.toThrow(
      'QUICK_START_MYSQL_RECLAIM_FAILED'
    );
    expect(fixture.release).not.toHaveBeenCalled();
  });
});
