import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Opt-in, using only separately prepared binary components, never another deployment's data.
test(
  'candidate Server cancels setup and preserves its database and Node identity through repeated runs',
  {
    skip:
      process.platform !== 'linux' ||
      !process.env.MAR_SERVER_NPM_ARTIFACT ||
      !process.env.MAR_MYSQL_COMPONENTS,
    timeout: 600_000
  },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'mar-server-lifecycle-'));
    const home = join(fixture, 'home');
    const consumer = join(fixture, 'consumer with spaces');
    const root = join(consumer, 'deployment data');
    await mkdir(home);
    await mkdir(root, { recursive: true });
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    const registry = process.env.MAR_SERVER_NPM_SCOPE_REGISTRY;
    await writeFile(
      join(fixture, 'empty.npmrc'),
      registry ? `@myagentroam:registry=${registry}\n` : ''
    );
    const env = {
      ...process.env,
      HOME: home,
      npm_config_userconfig: join(fixture, 'empty.npmrc'),
      npm_config_cache: join(fixture, 'npm-cache'),
      MAR_LOCALE: 'en-US',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
    };
    delete env.MAR_DATABASE_URL;
    delete env.npm_config_nodedir;
    delete env.npm_config_devdir;
    const artifact = resolve(process.env.MAR_SERVER_NPM_ARTIFACT);
    execFileSync(
      'npm',
      ['install', ...(registry ? [] : ['--offline']), '--no-audit', '--no-fund', artifact],
      {
        cwd: consumer,
        env,
        stdio: 'pipe'
      }
    );
    const server = join(consumer, 'node_modules/@myagentroam/server');
    const cli = join(server, 'dist/quick-start/cli.js');
    const configApi = await import(pathToFileURL(join(server, 'dist/quick-start/config.js')).href);
    const freePort = async () => {
      const socket = createServer();
      await new Promise((done) => socket.listen(0, '127.0.0.1', done));
      const port = socket.address().port;
      await new Promise((done) => socket.close(done));
      return port;
    };
    const ports = new Set();
    while (ports.size < 2) ports.add(await freePort());
    const [serverPort, mysqlPort] = ports;
    const config = configApi.createQuickStartConfig({
      serverPort,
      mysqlPort,
      node: false,
      search: 'disabled'
    });
    const configPath = join(root, 'server.json');
    await configApi.writeQuickStartConfig(configPath, config);
    await mkdir(join(root, 'components'));
    for (const name of ['mysql-8.4.7-linux-x64', 'libaio-0.3.113-4-linux-x64'])
      await cp(join(process.env.MAR_MYSQL_COMPONENTS, name), join(root, 'components', name), {
        recursive: true
      });
    let current;
    let safeToRemove = false;
    const start = (command, path = configPath) => {
      const child = spawn(process.execPath, [cli, command, '--config', path], {
        cwd: consumer,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      const exited = new Promise((done) =>
        child.once('exit', (code, signal) => done({ code, signal }))
      );
      current = { child, exited, output: () => output };
      return current;
    };
    const children = async (pid) =>
      (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''))
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number);
    const waitFor = async (condition, label) => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const result = await condition();
        if (result) return result;
        await delay(50);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    try {
      // A live MySQL process that never opens its socket must not delay cancellation.
      const pendingRoot = join(consumer, 'pending-mysql');
      const pendingConfig = {
        ...config,
        mysql: {
          ...config.mysql,
          installation: {
            version: '8.4.7',
            platform: 'linux',
            arch: 'x64',
            directory: 'components/mysql-fixture',
            libraryVersion: 'fixture',
            libraryDirectory: 'components/lib-fixture'
          }
        }
      };
      const pendingPath = join(pendingRoot, 'server.json');
      await configApi.writeQuickStartConfig(pendingPath, pendingConfig);
      await mkdir(join(pendingRoot, 'mysql-data'));
      await writeFile(join(pendingRoot, 'mysql-data.owner'), `${config.deploymentId}\n`);
      await mkdir(join(pendingRoot, 'components/mysql-fixture/bin'), { recursive: true });
      const ready = join(pendingRoot, 'mysql-started');
      await writeFile(
        join(pendingRoot, 'components/mysql-fixture/bin/mysqld'),
        `#!${process.execPath}\nprocess.on('SIGTERM', () => process.exit(0)); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
        { mode: 0o700 }
      );
      const pending = start('run', pendingPath);
      const pendingPid = Number(
        await waitFor(async () => readFile(ready, 'utf8').catch(() => ''), 'fake MySQL')
      );
      const startedStop = Date.now();
      pending.child.kill('SIGTERM');
      assert.equal((await pending.exited).code, 0);
      assert.ok(
        Date.now() - startedStop < 1500,
        'run cancellation should not wait for MySQL timeout'
      );
      current = undefined;
      await assert.rejects(stat(`/proc/${pendingPid}`), { code: 'ENOENT' });
      await assert.rejects(stat(join(pendingRoot, '.deployment-lock')), { code: 'ENOENT' });

      const setup = start('setup');
      const mysqlPid = await waitFor(async () => {
        for (const pid of await children(setup.child.pid)) {
          const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
          if (command.includes('/mysqld\0')) return pid;
        }
      }, 'the owned initialization process');
      setup.child.kill('SIGTERM');
      assert.notEqual((await setup.exited).code, 0);
      current = undefined;
      await assert.rejects(stat(`/proc/${mysqlPid}`), { code: 'ENOENT' });
      await assert.rejects(stat(join(root, '.deployment-lock')), { code: 'ENOENT' });
      const retry = start('setup');
      assert.equal((await retry.exited).code, 0);
      current = undefined;
      const databaseInode = (await stat(join(root, 'mysql-data/ibdata1'))).ino;
      for (let run = 0; run < 2; run += 1) {
        const instance = start('run');
        await waitFor(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${serverPort}/health`)).ok;
          } catch {
            return false;
          }
        }, 'Server health');
        instance.child.kill('SIGTERM');
        assert.equal((await instance.exited).code, 0);
        current = undefined;
        await assert.rejects(stat(join(root, '.deployment-lock')), { code: 'ENOENT' });
        assert.equal((await stat(join(root, 'mysql-data/ibdata1'))).ino, databaseInode);
      }
      const withNode = JSON.parse(await readFile(configPath, 'utf8'));
      withNode.node.enabled = true;
      await configApi.writeQuickStartConfig(configPath, withNode);
      let nodeId;
      for (let run = 0; run < 2; run += 1) {
        const instance = start('run');
        await waitFor(
          () => instance.output().includes('Local Node is online.'),
          'local Node online'
        );
        const nodeConfig = JSON.parse(await readFile(join(root, 'node-data/node.json'), 'utf8'));
        assert.ok(nodeConfig.nodeId);
        assert.ok(nodeConfig.credential);
        assert.ok(nodeConfig.allowedRoots.includes(join(root, 'workspace')));
        if (nodeId) assert.equal(nodeConfig.nodeId, nodeId);
        else nodeId = nodeConfig.nodeId;
        instance.child.kill('SIGTERM');
        assert.equal((await instance.exited).code, 0);
        current = undefined;
        await assert.rejects(stat(join(root, '.deployment-lock')), { code: 'ENOENT' });
        assert.equal((await stat(join(root, 'mysql-data/ibdata1'))).ino, databaseInode);
      }
      safeToRemove = true;
    } finally {
      if (current) {
        current.child.kill('SIGTERM');
        await current.exited;
      }
      if (safeToRemove) await rm(fixture, { recursive: true, force: true });
    }
  }
);
