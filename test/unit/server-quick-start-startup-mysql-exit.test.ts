import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  let mysqlExited!: () => void;
  let nodeOnline!: (value: boolean) => void;
  const mysqlExit = new Promise<void>((resolve) => {
    mysqlExited = resolve;
  });
  const nodeReady = new Promise<boolean>((resolve) => {
    nodeOnline = resolve;
  });
  return {
    mysqlExit,
    nodeReady,
    online: vi.fn(() => nodeReady),
    mysqlExited: () => mysqlExited(),
    nodeOnline: (v: boolean) => nodeOnline(v),
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  };
});
vi.mock('../../mar-server/src/quick-start/lock.js', () => ({
  acquireQuickStartLock: async () => fixture.release
}));
vi.mock('../../mar-server/src/quick-start/config.js', async (original) => ({
  ...(await original<typeof import('../../mar-server/src/quick-start/config.js')>()),
  resolveQuickStartConfigPath: () => '/fixture/server.json',
  readQuickStartConfig: async () => ({
    serverPort: 41331,
    mysql: { password: 'fixture' },
    node: { enabled: true },
    search: { mode: 'disabled' }
  })
}));
vi.mock('../../mar-server/src/quick-start/mysql-runtime.js', () => ({
  startManagedMysql: async () => ({ exited: fixture.mysqlExit, stop: fixture.stop }),
  waitForMysql: async () => ({ end: async () => {} })
}));
vi.mock('../../mar-server/src/quick-start/application.js', () => ({
  createLocalApplication: async () => ({
    app: { listen: async () => {}, shutdown: async () => {} },
    quickStartNode: {}
  })
}));
vi.mock('../../mar-server/src/quick-start/node-runtime.js', () => ({
  startLocalNode: async () => ({
    online: fixture.online,
    exited: new Promise(() => {}),
    stop: async () => {}
  })
}));

import { runQuickStart } from '../../mar-server/src/quick-start/run.js';

describe('MySQL failure while Node starts', () => {
  it('stops the run without waiting for Node registration', async () => {
    const outcome = runQuickStart({ command: 'run' }).then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await vi.waitFor(() => expect(fixture.online).toHaveBeenCalledOnce());
    fixture.mysqlExited();
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 300))
    ]);
    fixture.nodeOnline(false);
    await outcome;
    expect(result).toBe('QUICK_START_MYSQL_EXITED');
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
