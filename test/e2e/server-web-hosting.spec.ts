import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { openMysqlDatabase } from '../../ee/server/src/mysql/connection.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';
import { PLAYWRIGHT_LICENSE_PRODUCT_UUID } from './support/playwright-test-license.js';

test('The installed Server hosts Web, help and login without bundling or starting a Node', async ({
  browser
}, testInfo) => {
  test.setTimeout(60_000);
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-web-runtime`);
  await mkdir(resolve('test/runs'), { recursive: true });
  const directory = await mkdtemp(resolve('test/runs/mar-server-web-'));
  const data = resolve(directory, 'server-data');
  const packageRoot = resolve(process.env['MAR_E2E_PRODUCTION_PACKAGE'] ?? 'mar-server');
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  let context: BrowserContext | undefined;
  let database: MysqlServerDatabase | undefined;
  let created = false;
  let log = '';
  try {
    await writeFile(resolve(directory, 'license-host.txt'), PLAYWRIGHT_LICENSE_PRODUCT_UUID);
    await createPlaywrightTestDatabase(target);
    created = true;
    child = spawn(process.execPath, [resolve(packageRoot, 'dist/main.js')], {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HOME: directory,
        MAR_DATA_DIR: data,
        MAR_DATABASE_URL: target.databaseUrl,
        MAR_SERVER_HOST: '127.0.0.1',
        MAR_SERVER_PORT: '0',
        MAR_SECURE_COOKIES: 'false',
        MAR_LICENSE_HOST_PATH: resolve(directory, 'license-host.txt')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    closed = once(child, 'close');
    for (const stream of [child.stdout, child.stderr])
      stream!.on('data', (value) => (log += String(value)));
    await expect
      .poll(() => /Server listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(log)?.[1], {
        timeout: 30_000
      })
      .toBeTruthy();
    const baseURL = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(log)![1]!;
    database = new MysqlServerDatabase(await openMysqlDatabase({ url: target.databaseUrl }));
    await database.changePassword(1, 'WebRuntimePassword123!');
    context = await browser.newContext({ baseURL, locale: 'zh-CN' });
    const api = context.request;
    expect((await api.get('/health')).status()).toBe(200);
    expect((await api.get('/console')).status()).toBe(200);
    for (const path of [
      '/docs/getting-started/server-installation.html',
      '/docs/en-US/getting-started/server-installation.html'
    ]) {
      const help = await api.get(path);
      expect(help.status()).toBe(200);
      expect(await help.text()).not.toContain('builtin-node');
    }
    expect((await api.get('/manifest.webmanifest')).status()).toBe(200);
    expect((await api.get('/api/missing')).status()).toBe(404);
    expect(
      (
        await api.post('/api/auth/login', {
          data: { username: 'admin', password: 'WebRuntimePassword123!' }
        })
      ).status()
    ).toBe(200);
    expect(await (await api.get('/api/auth/me')).json()).toMatchObject({
      edition: 'COMMUNITY',
      role: 'ADMIN',
      organizationId: 1
    });
    const page = await context.newPage();
    await page.goto('/console');
    await expect(page.getByTestId('workbench-brand')).toBeVisible();
    expect(await (await api.get('/api/nodes')).json()).toEqual({ nodes: [] });
    await expect(access(resolve(data, 'builtin-node'))).rejects.toThrow();
    if (process.platform === 'linux') {
      const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8');
      expect(children.trim()).toBe('');
    }
    if (process.env['MAR_E2E_PRODUCTION_PACKAGE'])
      await expect(
        access(resolve(packageRoot, 'node_modules/@myagentroam/node'))
      ).rejects.toThrow();
  } finally {
    await context?.close();
    await testInfo.attach('server-output', { body: log, contentType: 'text/plain' });
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (closed)
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('TEST_SERVER_STOP_TIMEOUT')), 15_000);
          timer.unref();
        })
      ]);
    await database?.close();
    if (created) await dropPlaywrightTestDatabase(target);
    await rm(directory, { recursive: true, force: true });
  }
});
