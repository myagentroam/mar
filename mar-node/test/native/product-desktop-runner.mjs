import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from '../../../test/e2e/support/playwright-test-database.ts';

// Own only this runner's package installation, native window, database and peer.
// The peer drives the real Server/Connector and production page; no native probe
// or frontend substitute is counted as a product journey.
const product = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runId = process.env.MAR_TEST_RUN_ID;
assert(runId, 'MAR_TEST_RUN_ID is required.');
const report = join(product, 'test/runs', runId);
await mkdir(report, { recursive: true });
const root = await mkdtemp(join(report, 'product-'));
const windows = process.platform === 'win32';
const target = `${process.platform}-${process.arch}`;
const children = new Set();
let mysqlSocketDirectory;
if (process.platform === 'darwin' || windows)
  for (const [name, filename] of [
    ['MAR_DESKTOP_KEY_RECEIPT', 'key-down'],
    ['MAR_DESKTOP_MOUSE_RECEIPT', 'mouse-down'],
    ['MAR_DESKTOP_KEY_UP_RECEIPT', 'key-up'],
    ['MAR_DESKTOP_MOUSE_UP_RECEIPT', 'mouse-up']
  ])
    process.env[name] = join(report, filename);

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: product,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function command(command, args, options = {}) {
  const child = start(command, args, options);
  let output = '';
  let error = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    error += data;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, `${command} failed: ${error}`);
  return output;
}

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function until(check, message, child) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await check()) return;
    assert(child?.exitCode === null, `${message}: child exited (${child?.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function link(from, to) {
  await symlink(await realpath(from), to, windows ? 'junction' : 'dir');
}

try {
  if (process.env.MAR_TEST_MYSQLD) {
    const binary = process.env.MAR_TEST_MYSQLD;
    const data = join(root, 'mysql');
    await command(binary, [
      '--no-defaults',
      ...(windows ? ['--console'] : []),
      '--initialize-insecure',
      `--datadir=${data}`
    ]);
    if (!windows) mysqlSocketDirectory = await mkdtemp(join(tmpdir(), 'mrd-'));
    const tcp = await port();
    const server = start(binary, [
      '--no-defaults',
      ...(windows ? ['--console', '--no-monitor'] : []),
      `--datadir=${data}`,
      `--port=${tcp}`,
      '--bind-address=127.0.0.1',
      '--mysqlx=OFF',
      ...(mysqlSocketDirectory ? [`--socket=${join(mysqlSocketDirectory, 's')}`] : [])
    ]);
    const log = createWriteStream(join(report, 'mysql.log'));
    server.stdout.pipe(log, { end: false });
    server.stderr.pipe(log, { end: false });
    server.once('close', () => log.end());
    process.env.MAR_TEST_DATABASE_ADMIN_URL = `mysql://root@127.0.0.1:${tcp}/mysql`;
    await until(
      async () => {
        try {
          const connection = await mysql.createConnection(process.env.MAR_TEST_DATABASE_ADMIN_URL);
          await connection.end();
          return true;
        } catch {
          return false;
        }
      },
      'Private MySQL did not become ready.',
      server
    );
  }
  assert(
    process.env.MAR_TEST_DATABASE_ADMIN_URL,
    'Private database administrator URL is required.'
  );

  const installation = join(root, 'installation');
  await mkdir(installation);
  await writeFile(join(installation, 'package.json'), '{"private":true}\n');
  const archives = [];
  for (const name of ['binaries', `binaries-${target}`]) {
    const cwd = join(product, 'packages', name);
    const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', root];
    const packed = JSON.parse(
      await command(
        windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
        windows ? ['/d', '/s', '/c', 'npm', ...args] : args,
        { cwd }
      )
    )[0];
    archives.push(join(root, packed.filename));
  }
  const installArgs = [
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    ...archives
  ];
  await command(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
    windows ? ['/d', '/s', '/c', 'npm', ...installArgs] : installArgs,
    { cwd: installation }
  );
  assert.deepEqual(
    (await readdir(join(installation, 'node_modules/@myagentroam'))).sort(),
    ['binaries', `binaries-${target}`].sort()
  );

  const node = join(root, 'mar-node');
  await cp(join(product, 'mar-node/src'), join(node, 'src'), { recursive: true });
  await cp(join(product, 'mar-node/package.json'), join(node, 'package.json'));
  await link(join(product, 'node_modules'), join(root, 'node_modules'));
  const modules = join(node, 'node_modules');
  await mkdir(join(modules, '@myagentroam'), { recursive: true });
  for (const name of await readdir(join(product, 'mar-node/node_modules'))) {
    if (name !== '@myagentroam' && name !== '.bin')
      await link(join(product, 'mar-node/node_modules', name), join(modules, name));
  }
  for (const name of await readdir(join(product, 'mar-node/node_modules/@myagentroam'))) {
    await link(
      name === 'binaries'
        ? join(installation, 'node_modules/@myagentroam/binaries')
        : join(product, 'mar-node/node_modules/@myagentroam', name),
      join(modules, '@myagentroam', name)
    );
  }
  const peer = join(node, 'test/native/product-desktop-discovery-peer.mts');
  await mkdir(dirname(peer), { recursive: true });
  await cp(join(product, 'mar-node/test/native/product-desktop-discovery-peer.mts'), peer);

  let window;
  if (process.platform === 'darwin') {
    const binary = join(root, 'window');
    await command('swiftc', [
      join(product, 'mar-node/test/native/macos-desktop-window.swift'),
      '-o',
      binary
    ]);
    window = start(binary, []);
  } else if (windows) {
    window = start('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-File',
      join(product, 'mar-node/test/native/windows-desktop-window.ps1')
    ]);
  }
  if (window) {
    let ready = false;
    window.stdout.on('data', (data) => {
      if (data.toString().includes('DESKTOP_WINDOW_READY')) ready = true;
    });
    window.stderr.pipe(createWriteStream(join(report, 'window.log')));
    await until(() => ready, 'Native window did not become ready.', window);
  }

  const transports = process.env.MAR_TEST_TRANSPORT
    ? [process.env.MAR_TEST_TRANSPORT]
    : ['DIRECT', 'RELAY'];
  for (const transport of transports) {
    assert(['DIRECT', 'RELAY'].includes(transport));
    for (const name of [
      'MAR_DESKTOP_KEY_RECEIPT',
      'MAR_DESKTOP_MOUSE_RECEIPT',
      'MAR_DESKTOP_KEY_UP_RECEIPT',
      'MAR_DESKTOP_MOUSE_UP_RECEIPT'
    ])
      if (process.env[name]) await rm(process.env[name], { force: true });
    const database = resolvePlaywrightTestDatabase(`${runId}-${transport.toLowerCase()}`);
    await createPlaywrightTestDatabase(database);
    try {
      const outputPath = join(report, `${transport.toLowerCase()}.log`);
      const output = createWriteStream(outputPath);
      const peerProcess = start(
        process.execPath,
        ['--import', 'tsx', peer, join(root, transport), product, database.databaseUrl],
        {
          env: {
            ...process.env,
            MAR_TEST_TRANSPORT: transport,
            MAR_TEST_PAGE_QUALITY: '1',
            MAR_TEST_TRACE: '1',
            MAR_TEST_DESKTOP_REPORT: report,
            MAR_TEST_WEB_ROOT: join(product, 'mar-web-console/dist')
          }
        }
      );
      peerProcess.stdout.pipe(output, { end: false });
      peerProcess.stderr.pipe(output, { end: false });
      let timeout;
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          peerProcess.kill();
          reject(new Error(`${transport} did not exit in 90s.`));
        }, 90_000);
      });
      let code;
      try {
        [code] = await Promise.race([once(peerProcess, 'close'), deadline]);
      } finally {
        clearTimeout(timeout);
      }
      output.end();
      await once(output, 'finish');
      const log = await readFile(outputPath, 'utf8');
      assert.equal(code, 0, log);
      assert(log.includes(`PRODUCT_DESKTOP_TRANSPORT_${transport}`), log);
      assert(log.includes('PRODUCT_DESKTOP_BROWSER_READY'), log);
      if (window)
        assert.equal(
          (await readFile(process.env.MAR_DESKTOP_MOUSE_RECEIPT, 'utf8')).trim(),
          'mouse-down'
        );
      console.log(
        `PASS product ${target} ${transport}: package install, RBAC, discovery, VIEW/CONTROL frame, quality, input and natural exit.`
      );
    } finally {
      await dropPlaywrightTestDatabase(database);
    }
  }
} catch (error) {
  console.error('PRODUCT_JOURNEY_ERROR', error);
  throw error;
} finally {
  for (const child of [...children]) {
    if (!children.has(child)) continue;
    const closed = once(child, 'close');
    if (child.exitCode === null) child.kill();
    await closed;
  }
  if (mysqlSocketDirectory) await rm(mysqlSocketDirectory, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
