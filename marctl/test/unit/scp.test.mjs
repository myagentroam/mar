import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveNodeId } from '../../src/cli.mjs';
import { runScp } from '../../src/scp.mjs';
import { parseScpEndpoint, scpSourceBasename } from '../../src/scp-endpoint.mjs';
import { createTranslator } from '../../src/i18n/index.mjs';

const translate = createTranslator();

function fakeNodeClient({
  legacy = false,
  corrupt = false,
  closeAfterExit = false,
  onCreate,
  onInput,
  onOutput,
  nodes = [
    { id: 'node-linux', displayName: 'linux', connected: true },
    { id: 'node-windows', displayName: 'windows', connected: true }
  ]
} = {}) {
  const terminals = new Map();
  const createdNodes = [];
  let counter = 0;
  let deleted = 0;
  let started = 0;
  class Socket extends EventEmitter {
    constructor(terminal) {
      super();
      this.terminal = terminal;
      this.readyState = 0;
      this.sequence = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
        this.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: terminal.id, afterSequence: 0 }),
          false
        );
        this.start();
      });
    }

    start() {
      started += 1;
      const child = spawn(
        process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
        process.platform === 'win32'
          ? ['/d', '/s', '/c', `"${this.terminal.command}"`]
          : ['-c', this.terminal.command],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsVerbatimArguments: process.platform === 'win32'
        }
      );
      this.terminal.child = child;
      child.stdin.on('error', () => {});
      child.stderr.resume();
      child.stdout.on('data', (bytes) => {
        for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
          const data = bytes.subarray(offset, offset + 32 * 1024).toString('base64');
          const deliver = () =>
            this.emit(
              'message',
              JSON.stringify({
                type: 'output',
                terminalId: this.terminal.id,
                sequence: ++this.sequence,
                data: corrupt ? 'not-base64!' : data
              }),
              false
            );
          if (onOutput) onOutput(bytes.subarray(offset, offset + 32 * 1024), deliver, this);
          else deliver();
        }
      });
      child.on('close', (exitCode) => {
        this.emit(
          'message',
          JSON.stringify({ type: 'exit', terminalId: this.terminal.id, exitCode }),
          false
        );
        if (closeAfterExit) {
          this.readyState = 3;
          this.emit('close');
        }
      });
    }

    send(text, callback) {
      const frame = JSON.parse(text);
      if (frame.type === 'input') {
        assert.ok(Buffer.from(frame.data, 'base64').length <= 32 * 1024);
        const write = () =>
          this.terminal.child.stdin.write(Buffer.from(frame.data, 'base64'), callback);
        if (onInput) onInput(frame, write, this);
        else write();
      } else callback?.();
    }

    close() {
      this.readyState = 3;
    }
  }
  return {
    get createdNodes() {
      return createdNodes;
    },
    get started() {
      return started;
    },
    get deleted() {
      return deleted;
    },
    async listNodes() {
      return nodes;
    },
    async getTerminalManifest() {
      return { binaryTerminal: true };
    },
    async createTerminal(input) {
      const id = `terminal-${++counter}`;
      createdNodes.push(input.nodeId);
      terminals.set(id, { id, command: input.command });
      onCreate?.();
      return { terminalId: id, binary: !legacy };
    },
    async createAttachTicket() {
      return 'ticket';
    },
    openTerminalWebSocket(_WebSocketClass, { terminalId }) {
      return new Socket(terminals.get(terminalId));
    },
    async deleteTerminal({ terminalId }) {
      deleted += 1;
      terminals.get(terminalId)?.child?.kill();
    }
  };
}

function copy(client, source, destination) {
  return runScp({
    source,
    destination,
    client,
    WebSocketClass: class {},
    resolveNodeId: (host) => resolveNodeId(client, host, translate),
    translate
  });
}

test('parses absolute Node paths and local paths without interpreting commands', () => {
  assert.deepEqual(parseScpEndpoint('ubuntu://C:\\Users\\me\\file'), {
    host: 'ubuntu',
    path: 'C:\\Users\\me\\file'
  });
  assert.deepEqual(parseScpEndpoint('linux:///tmp/a'), { host: 'linux', path: '/tmp/a' });
  assert.deepEqual(parseScpEndpoint('linux:/tmp/a'), { host: 'linux', path: '/tmp/a' });
  assert.deepEqual(parseScpEndpoint('win:C:\\Users\\me\\file'), {
    host: 'win',
    path: 'C:\\Users\\me\\file'
  });
  assert.throws(() => parseScpEndpoint('linux://relative'), /Invalid Node file path/);
  assert.throws(() => parseScpEndpoint('linux:///tmp/\0bad'), /Invalid copy endpoint/);
});

test('resolves source basenames using POSIX and Windows path syntax', () => {
  assert.equal(scpSourceBasename('/var/tmp/artifact.bin'), 'artifact.bin');
  assert.equal(scpSourceBasename('C:\\Users\\vito\\artifact.bin'), 'artifact.bin');
  assert.equal(scpSourceBasename('\\\\server\\share\\folder\\artifact.bin'), 'artifact.bin');
  assert.equal(scpSourceBasename('/tmp/linux\\filename.bin'), 'linux\\filename.bin');
  assert.throws(() => scpSourceBasename('\\\\server\\share\\folder\\'), /Invalid source filename/);
  assert.equal(scpSourceBasename('C:/Users/vito/artifact.bin'), 'artifact.bin');
  assert.throws(() => scpSourceBasename('/var/tmp/'), /Invalid source filename/);
  assert.throws(() => scpSourceBasename('C:\\Users\\vito\\'), /Invalid source filename/);
});

test('copies binary files local-to-Node, Node-to-local and Node-to-Node with default overwrite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-'));
  const client = fakeNodeClient();
  try {
    const payload = Buffer.alloc(140_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const source = path.join(dir, 'source.bin');
    const first = path.join(dir, 'first.bin');
    const second = path.join(dir, 'second.bin');
    const third = path.join(dir, 'third.bin');
    await writeFile(source, payload);
    assert.equal(await copy(client, source, `linux://${first}`), 0);
    assert.equal(await copy(client, `linux://${first}`, second), 0);
    assert.equal(await copy(client, `linux://${first}`, `windows://${third}`), 0);
    for (const file of [first, second, third]) assert.deepEqual(await readFile(file), payload);
    assert.deepEqual(client.createdNodes, [
      'node-linux',
      'node-linux',
      'node-linux',
      'node-windows'
    ]);
    await writeFile(source, 'replacement');
    await chmod(first, 0o644);
    assert.equal(await copy(client, source, `linux://${first}`), 0);
    assert.equal((await readFile(first)).toString(), 'replacement');
    if (process.platform !== 'win32') assert.equal((await lstat(first)).mode & 0o777, 0o644);
    assert.equal(await copy(client, `linux://${first}`, second), 0);
    assert.equal((await readFile(second)).toString(), 'replacement');
    assert.equal(await copy(client, `linux://${first}`, `windows://${third}`), 0);
    assert.equal((await readFile(third)).toString(), 'replacement');
    assert.equal(client.deleted, 8);
    assert.deepEqual(
      (await readdir(dir)).filter((file) => file.includes('.marctl-')),
      []
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copies to existing local and Node directories using the source filename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-directories-'));
  const client = fakeNodeClient();
  try {
    const localSource = path.join(dir, 'release.bin');
    const remoteSource = path.join(dir, 'remote-source', 'report.txt');
    const localDirectory = path.join(dir, 'local-target');
    const remoteDirectory = path.join(dir, 'remote-target');
    const secondRemoteDirectory = path.join(dir, 'second-remote-target');
    await mkdir(path.dirname(remoteSource), { recursive: true });
    await mkdir(localDirectory);
    await mkdir(remoteDirectory);
    await mkdir(secondRemoteDirectory);
    await writeFile(localSource, 'local payload');
    await writeFile(remoteSource, 'remote payload');
    await writeFile(path.join(remoteDirectory, 'release.bin'), 'old payload');
    await chmod(path.join(remoteDirectory, 'release.bin'), 0o600);

    assert.equal(await copy(client, localSource, `linux://${remoteDirectory}`), 0);
    assert.equal(
      (await readFile(path.join(remoteDirectory, 'release.bin'))).toString(),
      'local payload'
    );
    if (process.platform !== 'win32')
      assert.equal((await lstat(path.join(remoteDirectory, 'release.bin'))).mode & 0o777, 0o600);

    assert.equal(await copy(client, `linux://${remoteSource}`, `${localDirectory}${path.sep}`), 0);
    assert.equal(
      (await readFile(path.join(localDirectory, 'report.txt'))).toString(),
      'remote payload'
    );

    assert.equal(
      await copy(client, `linux://${remoteSource}`, `windows://${secondRemoteDirectory}/`),
      0
    );
    assert.equal(
      (await readFile(path.join(secondRemoteDirectory, 'report.txt'))).toString(),
      'remote payload'
    );
    assert.equal(client.deleted, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requires trailing-separator destinations to already be directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-directory-target-'));
  try {
    const source = path.join(dir, 'source.bin');
    const missingDirectory = path.join(dir, 'missing');
    await writeFile(source, 'payload');
    await assert.rejects(copy(fakeNodeClient(), source, `linux://${missingDirectory}/`));
    await assert.rejects(
      copy(fakeNodeClient(), `linux://${source}`, `${missingDirectory}${path.sep}`)
    );
    for (const suffix of ['/.', '/child/..', '/..', '/../new-target.bin']) {
      await assert.rejects(copy(fakeNodeClient(), source, `linux://${missingDirectory}${suffix}`));
      await assert.rejects(
        copy(fakeNodeClient(), `linux://${source}`, `${missingDirectory}${suffix}`)
      );
    }
    await assert.rejects(lstat(missingDirectory), { code: 'ENOENT' });
    assert.deepEqual(
      (await readdir(dir)).filter((file) => file.includes('.marctl-')),
      []
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'preserves OS resolution of symlink parents for directory and file destinations',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-parent-resolution-'));
    try {
      const source = path.join(dir, 'input', 'payload.bin');
      const actualParent = path.join(dir, 'actual');
      const alias = path.join(dir, 'alias');
      await mkdir(path.dirname(source));
      await mkdir(path.join(actualParent, 'child'), { recursive: true });
      await writeFile(source, 'payload');
      await symlink(path.join(actualParent, 'child'), alias, 'dir');
      const client = fakeNodeClient();
      assert.equal(await copy(client, source, `linux://${alias}/..`), 0);
      assert.equal(await readFile(path.join(actualParent, 'payload.bin'), 'utf8'), 'payload');
      assert.equal(await copy(client, `linux://${source}`, `${alias}/../renamed.bin`), 0);
      assert.equal(await readFile(path.join(actualParent, 'renamed.bin'), 'utf8'), 'payload');
      await assert.rejects(lstat(path.join(dir, 'payload.bin')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(dir, 'renamed.bin')), { code: 'ENOENT' });
      assert.deepEqual((await readdir(actualParent)).sort(), [
        'child',
        'payload.bin',
        'renamed.bin'
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test('rejects final directories and symlinks inside a destination directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-directory-leaf-'));
  try {
    const source = path.join(dir, 'source.bin');
    const destination = path.join(dir, 'destination');
    const outside = path.join(dir, 'outside.bin');
    const leaf = path.join(destination, 'source.bin');
    await writeFile(source, 'payload');
    await mkdir(destination);
    await mkdir(leaf);
    await assert.rejects(copy(fakeNodeClient(), source, `linux://${destination}`));
    assert.equal((await lstat(leaf)).isDirectory(), true);
    await rm(leaf, { recursive: true });
    await writeFile(outside, 'unchanged');
    await symlink(outside, leaf);
    await assert.rejects(copy(fakeNodeClient(), `linux://${source}`, destination));
    assert.equal((await lstat(leaf)).isSymbolicLink(), true);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    assert.deepEqual(await readdir(destination), ['source.bin']);
    const directoryAlias = path.join(dir, 'directory-alias');
    await symlink(destination, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const suffix of ['', path.sep, `${path.sep}.`, `${path.sep}.${path.sep}.`])
      await assert.rejects(copy(fakeNodeClient(), source, `linux://${directoryAlias}${suffix}`));
    assert.deepEqual(await readdir(destination), ['source.bin']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects source filenames that cannot be a Windows destination leaf', async () => {
  const worker = readFileSync(new URL('../../src/scp-worker.cjs', import.meta.url), 'utf8');
  const script = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    require('node:fs/promises').lstat = async () => ({
      isDirectory: () => true, isSymbolicLink: () => false
    });
    eval(${JSON.stringify(worker)});
  `;
  for (const filename of [
    '../escape',
    'nested\\escape',
    'report:stream',
    'NUL.txt',
    'COM1',
    'trailing.',
    'trailing '
  ]) {
    const child = spawn(
      process.execPath,
      [
        '-e',
        script,
        'write',
        Buffer.from(path.resolve('target')).toString('base64url'),
        '0',
        Buffer.alloc(20).toString('base64url'),
        '0',
        Buffer.from(filename).toString('base64url')
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const errors = [];
    child.stdout.resume();
    child.stderr.on('data', (bytes) => errors.push(bytes));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, filename);
    assert.match(Buffer.concat(errors).toString(), /SCP_SOURCE_FILENAME_INVALID/u, filename);
  }
});

test('resolves unique names and IDs for both copy endpoints and rejects ambiguous names first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-names-'));
  try {
    const source = path.join(dir, 'source');
    const copied = path.join(dir, 'copied');
    await writeFile(source, 'name resolution');
    const client = fakeNodeClient({
      nodes: [
        { id: 'node-1', displayName: 'ubuntu-develop', connected: true },
        { id: 'node-2', displayName: 'windows-develop', connected: true },
        { id: 'node-3', displayName: 'ubuntu-develop', connected: false }
      ]
    });
    await assert.rejects(
      copy(client, `ubuntu-develop://${source}`, `windows-develop://${copied}`),
      /Multiple accessible nodes share that name/
    );
    await assert.rejects(
      copy(client, `node-1://${source}`, `ubuntu-develop://${copied}`),
      /Multiple accessible nodes share that name/
    );
    assert.deepEqual(client.createdNodes, []);
    assert.equal(await copy(client, `node-1://${source}`, `windows-develop://${copied}`), 0);
    const second = path.join(dir, 'second');
    assert.equal(await copy(client, `windows-develop://${copied}`, `node-1://${second}`), 0);
    assert.deepEqual(client.createdNodes, ['node-1', 'node-2', 'node-2', 'node-1']);
    assert.equal((await readFile(copied)).toString(), 'name resolution');
    assert.equal((await readFile(second)).toString(), 'name resolution');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preserves source mode and timestamps with standard -p semantics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-preserve-'));
  try {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'destination');
    await writeFile(source, 'preserve');
    await chmod(source, 0o640);
    const when = new Date('2024-01-02T03:04:05Z');
    await utimes(source, when, when);
    await writeFile(destination, 'old');
    await chmod(destination, 0o600);
    const client = fakeNodeClient();
    assert.equal(
      await runScp({
        source,
        destination: `linux://${destination}`,
        preserve: true,
        client,
        WebSocketClass: class {},
        resolveNodeId: (host) => resolveNodeId(client, host, translate),
        translate
      }),
      0
    );
    const result = await lstat(destination);
    assert.equal((await readFile(destination)).toString(), 'preserve');
    if (process.platform !== 'win32') assert.equal(result.mode & 0o777, 0o640);
    assert.ok(Math.abs(result.mtimeMs - when.getTime()) < 1000);
    assert.ok(Math.abs(result.atimeMs - when.getTime()) < 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a symlink source and rejects an invalid binary output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-fail-'));
  try {
    const source = path.join(dir, 'source');
    const alias = path.join(dir, 'alias');
    await writeFile(source, 'test');
    await symlink(source, alias);
    await assert.rejects(copy(fakeNodeClient(), `linux://${alias}`, path.join(dir, 'nope')));
    const original = path.join(dir, 'original');
    await writeFile(original, 'unchanged');
    await assert.rejects(
      copy(fakeNodeClient({ corrupt: true }), `linux://${source}`, original),
      /not valid base64/
    );
    assert.equal((await readFile(original)).toString(), 'unchanged');
    await assert.rejects(lstat(path.join(dir, 'nope')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copies an empty file and never follows or replaces an existing destination symlink', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-empty-'));
  try {
    const source = path.join(dir, 'empty');
    const destination = path.join(dir, 'destination');
    const alias = path.join(dir, 'alias');
    await writeFile(source, '');
    const client = fakeNodeClient();
    assert.equal(await copy(client, source, `linux://${destination}`), 0);
    assert.deepEqual(await readFile(destination), Buffer.alloc(0));
    await symlink(destination, alias);
    await assert.rejects(copy(client, source, `linux://${alias}`));
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.deepEqual(
      (await readdir(dir)).filter((file) => file.includes('.marctl-')),
      []
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads a Windows file when path stat omits its device ID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-windows-stat-'));
  try {
    const source = path.join(dir, 'empty');
    await writeFile(source, '');
    const worker = readFileSync(new URL('../../src/scp-worker.cjs', import.meta.url), 'utf8');
    const script = `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const files = require('node:fs/promises');
      const actualLstat = files.lstat;
      files.lstat = async (...args) =>
        Object.assign(Object.create(await actualLstat(...args)), { dev: 0 });
      eval(${JSON.stringify(worker)});
    `;
    const child = spawn(
      process.execPath,
      ['-e', script, 'read', Buffer.from(source).toString('base64url')],
      {
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    const output = [];
    const errors = [];
    child.stdout.on('data', (bytes) => output.push(bytes));
    child.stderr.on('data', (bytes) => errors.push(bytes));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, Buffer.concat(errors).toString());
    const bytes = Buffer.concat(output);
    assert.equal(bytes.length, 64);
    assert.equal(bytes.readBigUInt64BE(0), 0n);
    assert.equal(bytes.readUInt32BE(28), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a legacy Server response before attaching or starting a PTY command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-legacy-'));
  const client = fakeNodeClient({ legacy: true });
  try {
    const source = path.join(dir, 'source');
    await writeFile(source, 'test');
    await assert.rejects(
      copy(client, `linux://${source}`, path.join(dir, 'destination')),
      /binary|pipe/i
    );
    assert.equal(client.started, 0);
    assert.equal(client.deleted, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancels Node resolution promptly and ignores its late result', async () => {
  const signals = new AbortController();
  let releaseResolution;
  let markResolutionStarted;
  let workerStarts = 0;
  const resolutionStarted = new Promise((resolve) => {
    markResolutionStarted = resolve;
  });
  const client = {
    async getTerminalManifest() {
      workerStarts += 1;
      return { binaryTerminal: true };
    },
    async createTerminal() {
      workerStarts += 1;
      return { terminalId: 'terminal-1', binary: true };
    },
    async deleteTerminal() {}
  };
  const copying = runScp({
    source: 'linux:///remote/source',
    destination: '/tmp/marctl-scp-destination',
    client,
    WebSocketClass: class {},
    resolveNodeId: () => {
      markResolutionStarted();
      return new Promise((resolve) => {
        releaseResolution = resolve;
      });
    },
    translate,
    signal: signals.signal
  }).then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error })
  );

  await resolutionStarted;
  signals.abort('SIGINT');
  let timer;
  const prompt = await Promise.race([
    copying,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), 100);
    })
  ]);
  clearTimeout(timer);
  releaseResolution('node-linux');

  const late = await copying;
  assert.equal(late.kind, 'rejected');
  assert.equal(workerStarts, 0);
  assert.equal(prompt?.kind, 'rejected', 'cancellation should settle before Node resolution');
});

for (const remoteSide of ['source', 'target'])
  test(`interrupts remote ${remoteSide} preparation before the worker starts`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-interrupt-'));
    const signals = new AbortController();
    const client = fakeNodeClient({ onCreate: () => signals.abort('SIGINT') });
    try {
      const source = path.join(dir, 'source');
      const destination = path.join(dir, 'destination');
      await writeFile(source, 'test');
      await writeFile(destination, 'previous');
      await assert.rejects(
        runScp({
          source: remoteSide === 'source' ? `linux://${source}` : source,
          destination: remoteSide === 'target' ? `linux://${destination}` : destination,
          client,
          WebSocketClass: class {},
          resolveNodeId: async (host) => host,
          translate,
          signal: signals.signal
        }),
        /interrupted/
      );
      assert.equal(client.deleted, 1);
      assert.equal(client.started, 0);
      assert.equal(await readFile(destination, 'utf8'), 'previous');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test(
  'interrupts a copy even while its actual relay write is blocked',
  { timeout: 5_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-write-interrupt-'));
    const signals = new AbortController();
    let releaseWrite;
    let notifyBlocked;
    const blocked = new Promise((resolve) => {
      notifyBlocked = resolve;
    });
    const client = fakeNodeClient({
      onInput(frame, write) {
        if (Buffer.from(frame.data, 'base64').length > 1024 && !releaseWrite) {
          releaseWrite = write;
          notifyBlocked();
        } else write();
      }
    });
    let copying;
    try {
      const source = path.join(dir, 'source');
      await writeFile(source, Buffer.alloc(64 * 1024, 42));
      copying = runScp({
        source,
        destination: `linux://${path.join(dir, 'destination')}`,
        client,
        WebSocketClass: class {},
        resolveNodeId: async (host) => host,
        translate,
        signal: signals.signal
      });
      let failure;
      const settled = copying.catch((error) => {
        failure = error;
      });
      await blocked;
      signals.abort('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(failure?.message ?? '', /interrupted/);
      await settled;
      assert.equal(client.deleted, 1);
    } finally {
      releaseWrite?.();
      await copying?.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test('preserves a successful exit when the relay closes before the peer completes verification', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-normal-close-'));
  const client = fakeNodeClient({ closeAfterExit: true });
  try {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'target');
    const payload = Buffer.alloc(128 * 1024, 42);
    await writeFile(source, payload);
    assert.equal(await copy(client, `linux://${source}`, `windows://${target}`), 0);
    assert.deepEqual(await readFile(target), payload);
    assert.equal(client.deleted, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'rejects a disconnect without an exit and preserves the destination during a blocked write',
  { timeout: 5_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-lost-write-'));
    let releaseWrite;
    const client = fakeNodeClient({
      onInput(frame, write, socket) {
        if (Buffer.from(frame.data, 'base64').length > 1024 && !releaseWrite) {
          releaseWrite = write;
          socket.readyState = 3;
          socket.emit('close');
        } else write();
      }
    });
    try {
      const source = path.join(dir, 'source');
      const target = path.join(dir, 'target');
      await writeFile(source, Buffer.alloc(64 * 1024, 42));
      await writeFile(target, 'original');
      await assert.rejects(copy(client, source, `linux://${target}`), /connection was lost/);
      assert.equal((await readFile(target)).toString(), 'original');
      assert.equal(client.deleted, 1);
    } finally {
      releaseWrite?.();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'does not retry or roll back a published file when its final acknowledgement is lost',
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-published-'));
    const client = fakeNodeClient({
      onOutput(bytes, deliver, socket) {
        if (bytes.length === 1 && bytes[0] === 2) {
          socket.readyState = 3;
          socket.emit('close');
        } else deliver();
      }
    });
    try {
      const source = path.join(dir, 'source');
      const target = path.join(dir, 'target');
      await writeFile(source, 'new payload');
      await writeFile(target, 'original');
      await assert.rejects(copy(client, source, `linux://${target}`), /connection was lost/);
      assert.equal((await readFile(target)).toString(), 'new payload');
      assert.equal(client.started, 1);
      assert.equal(client.deleted, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'rejects a failed remote exit while a relay write remains blocked',
  { timeout: 5_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-exit-during-write-'));
    let releaseWrite;
    let notifyExit;
    const exited = new Promise((resolve) => {
      notifyExit = resolve;
    });
    const client = fakeNodeClient({
      onInput(frame, write, socket) {
        if (Buffer.from(frame.data, 'base64').length > 1024 && !releaseWrite) {
          releaseWrite = write;
          socket.emit(
            'message',
            JSON.stringify({ type: 'exit', terminalId: frame.terminalId, exitCode: 1 }),
            false
          );
          notifyExit();
        } else write();
      }
    });
    let copying;
    try {
      const source = path.join(dir, 'source');
      await writeFile(source, Buffer.alloc(64 * 1024, 42));
      let failure;
      copying = copy(client, source, `linux://${path.join(dir, 'destination')}`);
      copying.catch((error) => {
        failure = error;
      });
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(failure?.message ?? '', /Remote copy command failed/);
      await copying.catch(() => {});
      assert.equal(client.deleted, 1);
    } finally {
      releaseWrite?.();
      await copying?.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
);

for (const side of ['source', 'target']) {
  for (const event of ['exit', 'disconnect']) {
    test(
      `propagates ${side} ${event} while the peer relay write is blocked`,
      { timeout: 10_000 },
      async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-peer-failure-'));
        const sockets = new Map();
        let releaseWrite;
        let notifyBlocked;
        const blocked = new Promise((resolve) => {
          notifyBlocked = resolve;
        });
        const client = fakeNodeClient({
          onOutput(bytes, deliver, socket) {
            sockets.set(socket.terminal.command.includes('" read ') ? 'source' : 'target', socket);
            deliver();
          },
          onInput(frame, write, socket) {
            const bytes = Buffer.from(frame.data, 'base64');
            const isSource = socket.terminal.command.includes('" read ');
            if (
              !releaseWrite &&
              ((side === 'source' && !isSource && bytes.length > 1024) ||
                (side === 'target' && isSource && bytes.length === 1))
            ) {
              releaseWrite = write;
              const failed = sockets.get(side);
              if (event === 'exit')
                failed.emit(
                  'message',
                  JSON.stringify({
                    type: 'exit',
                    terminalId: failed.terminal.id,
                    exitCode: 1
                  }),
                  false
                );
              else {
                failed.readyState = 3;
                failed.emit('close');
              }
              notifyBlocked();
            } else write();
          }
        });
        let copying;
        let timer;
        try {
          const source = path.join(dir, 'source');
          const destination = path.join(dir, 'destination');
          await writeFile(source, Buffer.alloc(1024 * 1024, 42));
          await writeFile(destination, 'original');
          copying = copy(client, `linux://${source}`, `windows://${destination}`).then(
            () => ({ success: true }),
            (error) => ({ error })
          );
          await blocked;
          const result = await Promise.race([
            copying,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ timedOut: true }), 1000);
            })
          ]);
          assert.equal(result.timedOut, undefined, 'Peer failure must wake a blocked relay write.');
          assert.match(
            result.error?.message ?? '',
            event === 'exit' ? /Remote copy command failed/ : /connection was lost/
          );
          assert.equal((await readFile(destination)).toString(), 'original');
          assert.equal(client.deleted, 2);
        } finally {
          clearTimeout(timer);
          releaseWrite?.();
          await copying;
          await rm(dir, { recursive: true, force: true });
        }
      }
    );
  }
}

test(
  'keeps source operations responsive while a Node-to-Node copy waits for an ACK',
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-ack-'));
    let releaseAck;
    let notifyBlocked;
    let acknowledgements = 0;
    const blocked = new Promise((resolve) => {
      notifyBlocked = resolve;
    });
    const client = fakeNodeClient({
      onOutput(bytes, deliver) {
        if (bytes.length === 1 && bytes[0] === 1 && ++acknowledgements === 2) {
          releaseAck = deliver;
          notifyBlocked();
        } else deliver();
      }
    });
    let copying;
    try {
      const source = path.join(dir, 'source');
      const destination = path.join(dir, 'destination');
      const payload = Buffer.alloc(4 * 1024 * 1024, 42);
      await writeFile(source, payload);
      let finished = false;
      copying = copy(client, `linux://${source}`, `windows://${destination}`).then((result) => {
        finished = true;
        return result;
      });
      copying.catch(() => {});
      await blocked;
      let heartbeats = 0;
      for (let index = 0; index < 5; index++) {
        await new Promise((resolve) => setImmediate(resolve));
        const nodes = await client.listNodes();
        assert.equal(nodes.length, 2);
        heartbeats++;
      }
      assert.equal(heartbeats, 5);
      assert.equal(finished, false);
      releaseAck();
      assert.equal(await copying, 0);
      assert.deepEqual(await readFile(destination), payload);
      assert.equal(client.deleted, 2);
    } finally {
      releaseAck?.();
      await copying?.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
);

for (const direction of ['upload', 'download', 'Node-to-Node']) {
  test(
    `uses a bounded sliding window during ${direction} with stalled acknowledgements`,
    {
      timeout: 10_000
    },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-window-'));
      const held = [];
      let holding = true;
      let targetReady = false;
      let frames = 0;
      let pending = Buffer.alloc(0);
      let notifyBlocked;
      const blocked = new Promise((resolve) => {
        notifyBlocked = resolve;
      });
      let notifyWindowFilled;
      const windowFilled = new Promise((resolve) => {
        notifyWindowFilled = resolve;
      });
      const client = fakeNodeClient({
        onInput(frame, write, socket) {
          if (socket.terminal.command.includes('" write ')) {
            pending = Buffer.concat([pending, Buffer.from(frame.data, 'base64')]);
            while (pending.length >= 4) {
              const length = pending.readUInt32BE();
              if (length === 0 || pending.length < length + 4) break;
              frames++;
              if (frames === 8) notifyWindowFilled();
              pending = pending.subarray(length + 4);
            }
          }
          if (Buffer.from(frame.data, 'base64').length > 4) setTimeout(write, 40);
          else write();
        },
        onOutput(bytes, deliver, socket) {
          if (socket.terminal.command.includes('" write ')) {
            if (!targetReady) {
              targetReady = true;
              deliver();
            } else if (holding) {
              held.push(deliver);
              notifyBlocked();
            } else deliver();
          } else deliver();
        }
      });
      let copying;
      try {
        const source = path.join(dir, 'source');
        const destination = path.join(dir, 'destination');
        const payload = Buffer.alloc(1024 * 1024 + 7, 42);
        await writeFile(source, payload);
        if (direction === 'download') {
          // Delay source ACK writes to exercise the worker's own read-ahead window.
          const originalOpen = client.openTerminalWebSocket;
          client.openTerminalWebSocket = (...args) => {
            const socket = originalOpen(...args);
            const send = socket.send.bind(socket);
            socket.send = (raw, callback) => {
              const frame = JSON.parse(raw);
              if (frame.type === 'input' && holding) {
                held.push(() => send(raw, callback));
                notifyBlocked();
              } else send(raw, callback);
            };
            socket.on('message', (raw) => {
              const frame = JSON.parse(raw);
              if (frame.type === 'output') {
                pending = Buffer.concat([pending, Buffer.from(frame.data, 'base64')]);
                if (!targetReady && pending.length >= 28) {
                  pending = pending.subarray(28);
                  targetReady = true;
                }
                while (targetReady && pending.length >= 4) {
                  const length = pending.readUInt32BE();
                  if (length === 0 || pending.length < length + 4) break;
                  frames++;
                  if (frames === 8) notifyWindowFilled();
                  pending = pending.subarray(length + 4);
                }
              }
            });
            return socket;
          };
        }
        let finished = false;
        copying = copy(
          client,
          direction === 'upload' ? source : `linux://${source}`,
          direction === 'download' ? destination : `windows://${destination}`
        ).finally(() => {
          finished = true;
        });
        copying.catch(() => {});
        await blocked;
        let windowTimeout;
        try {
          await Promise.race([
            windowFilled,
            new Promise((_, reject) => {
              windowTimeout = setTimeout(
                () => reject(new Error('Copy window did not fill.')),
                3000
              );
            })
          ]);
        } finally {
          clearTimeout(windowTimeout);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(frames, 8);
        assert.equal(finished, false);
        holding = false;
        for (const release of held.splice(0)) release();
        assert.equal(await copying, 0);
        assert.deepEqual(await readFile(destination), payload);
        assert.equal(client.deleted, direction === 'Node-to-Node' ? 2 : 1);
      } finally {
        holding = false;
        for (const release of held.splice(0)) release();
        await copying?.catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
}

for (const side of ['target', 'source']) {
  test(
    `rejects an invalid ${side} window ACK without publishing or leaving pending readers`,
    {
      timeout: 5_000
    },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-window-rejected-'));
      let targetReady = false;
      const client = fakeNodeClient({
        onInput(frame, write, socket) {
          if (side === 'source' && socket.terminal.command.includes('" read '))
            frame.data = Buffer.alloc(Buffer.from(frame.data, 'base64').length).toString('base64');
          write();
        },
        onOutput(bytes, deliver, socket) {
          if (side === 'source' || !socket.terminal.command.includes('" write ')) return deliver();
          if (!targetReady) {
            targetReady = true;
            return deliver();
          }
          socket.emit(
            'message',
            JSON.stringify({
              type: 'output',
              terminalId: socket.terminal.id,
              sequence: ++socket.sequence,
              data: Buffer.alloc(bytes.length).toString('base64')
            }),
            false
          );
        }
      });
      try {
        const source = path.join(dir, 'source');
        const destination = path.join(dir, 'destination');
        await writeFile(source, Buffer.alloc(1024 * 1024, 42));
        await writeFile(destination, 'original');
        await assert.rejects(
          copy(client, `linux://${source}`, `windows://${destination}`),
          side === 'target' ? /Copy target rejected the chunk/ : /Remote copy command failed/
        );
        assert.equal(await readFile(destination, 'utf8'), 'original');
        assert.equal(client.deleted, 2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
}

test(
  'keeps independent requests responsive during a Node-to-Node copy over real WebSockets',
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marctl-scp-websocket-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const client = fakeNodeClient();
    const originalOpen = client.openTerminalWebSocket;
    let control;
    let copying;
    let maxBufferedBytes = 0;
    try {
      await once(server, 'listening');
      const url = `ws://127.0.0.1:${server.address().port}`;
      server.on('connection', (socket, request) => {
        const parameters = new URL(request.url, url).searchParams;
        if (parameters.has('control')) {
          socket.on('message', () => socket.send('reply'));
          return;
        }
        const upstream = originalOpen(class {}, { terminalId: parameters.get('terminalId') });
        upstream.on('message', (raw) => {
          if (socket.readyState === 1) socket.send(raw);
        });
        socket.on('message', (raw) =>
          upstream.send(raw.toString(), (error) => {
            if (error) socket.close();
          })
        );
        socket.once('close', () => upstream.close());
      });
      client.openTerminalWebSocket = (_Socket, { terminalId }) => {
        const socket = new WebSocket(`${url}/?terminalId=${encodeURIComponent(terminalId)}`);
        const originalSend = socket.send.bind(socket);
        socket.send = (...args) => {
          const result = originalSend(...args);
          maxBufferedBytes = Math.max(maxBufferedBytes, socket.bufferedAmount);
          return result;
        };
        return socket;
      };
      control = new WebSocket(`${url}/?control=1`);
      await once(control, 'open');
      const source = path.join(dir, 'source');
      const destination = path.join(dir, 'destination');
      const payload = Buffer.alloc(8 * 1024 * 1024, 42);
      await writeFile(source, payload);
      let finished = false;
      copying = copy(client, `linux://${source}`, `windows://${destination}`).finally(() => {
        finished = true;
      });
      copying.catch(() => {});
      let repliesDuringCopy = 0;
      for (let index = 0; index < 1000 && !finished; index++) {
        const response = once(control, 'message');
        control.send('request');
        const [reply] = await response;
        assert.equal(reply.toString(), 'reply');
        if (!finished) repliesDuringCopy++;
      }
      assert.ok(repliesDuringCopy > 0);
      assert.equal(await copying, 0);
      assert.deepEqual(await readFile(destination), payload);
      assert.ok(maxBufferedBytes < 512 * 1024);
      assert.equal(client.deleted, 2);
    } finally {
      control?.terminate();
      for (const socket of server.clients) socket.terminate();
      await copying?.catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  }
);
