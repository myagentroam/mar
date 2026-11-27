import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSocket } from 'node:dgram';
import WebSocket, { WebSocketServer } from 'ws';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { nodeExecutionEnvironment } from '../../src/node-execution-environment.js';
import {
  TerminalManager,
  defaultTerminalProfiles,
  type TerminalPipe,
  type TerminalPty,
  type TerminalPtyFactory
} from '../../src/terminal.js';
import { TerminalStreamService } from '../../src/service/terminal-stream-service.js';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import {
  decodeNodeRelayHandshake,
  decodeNodeStreamFrame,
  encodeNodeRelayHandshake
} from '@myagentroam/protocol/node-stream-wire';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import {
  createEnvelope,
  decodeTerminalMessage,
  encodeTerminalMessage
} from '@myagentroam/protocol';

class FakePty implements TerminalPty {
  paused = false;
  kills = 0;
  readonly writes: string[] = [];
  readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
  readonly pid = 4242;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  write(data: string): void {
    this.writes.push(data);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): boolean {
    this.kills++;
    return true;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

it.each(['eof', 'disconnect'] as const)(
  'keeps remote desktop data out of Terminal replay and history after %s',
  async (ending) => {
    const manager = new TerminalManager({ platform: 'linux' });
    const database = new NodeDatabase(':memory:', 'terminal-computer');
    const connector = new NodeConnector({ reconnect: false, database, terminalManager: manager });
    let output!: (data: Buffer) => void;
    let exit!: (code: number) => void;
    try {
      const terminal = manager.openComputer(() => ({
        kill: () => true,
        close: async () => undefined,
        write: () => undefined,
        end: () => exit(0),
        onData: (listener) => {
          output = listener;
        },
        onExit: (listener) => {
          exit = listener;
        }
      }));
      expect(database.getTerminalSession(terminal.id)).toBeUndefined();
      const { attachmentId } = manager.authorizeAttach({ terminalId: terminal.id });
      const frames: unknown[] = [];
      manager.onFrame((frame) => frames.push(frame));
      manager.startCommand(terminal.id);
      output(Buffer.from([0x89, 0x50]));
      expect(frames).toEqual([
        { type: 'output', terminalId: terminal.id, sequence: 1, data: Uint8Array.of(0x89, 0x50) }
      ]);
      expect(
        manager.synchronizeAttachment({ terminalId: terminal.id, attachmentId, afterSequence: 0 })
      ).toEqual({ active: true, frames: [] });
      if (ending === 'eof')
        await manager.acceptFrame(attachmentId, { type: 'eof', terminalId: terminal.id });
      else manager.detach(attachmentId);
      await vi.waitFor(() => expect(manager.list()).toEqual([]));
      expect(database.getTerminalSession(terminal.id)).toBeUndefined();
    } finally {
      await connector.stop();
    }
  }
);

function fakeFactory(output: {
  value?: FakePty;
  shell?: string;
  args?: readonly string[];
  cwd?: string;
}): TerminalPtyFactory {
  return (shell, args, options) => {
    const pty = new FakePty();
    output.value = pty;
    output.shell = shell;
    output.args = args;
    output.cwd = options.cwd;
    return pty;
  };
}

function terminalStreamFixture(
  manager: TerminalManager,
  beforeSend?: (bytes: Uint8Array) => Promise<void>
) {
  const service = new TerminalStreamService(manager);
  const client = new NodeStreamMux({
    maxStreams: 4,
    async send(bytes) {
      node.receive(bytes);
    }
  });
  const node = new NodeStreamMux({
    maxStreams: 4,
    accept: async ({ grant }) => service.consume(grant),
    async send(bytes) {
      await beforeSend?.(bytes);
      client.receive(bytes);
    }
  });
  return {
    async open(terminalId: string, options?: { readonly?: boolean; closeOnDisconnect?: boolean }) {
      const grant = service.issue({
        terminalId,
        workspaceId: null,
        afterSequence: 0,
        readonly: false,
        closeOnDisconnect: false,
        ...options
      });
      const stream = await client.openStream({ kind: 'terminal', grant });
      if (stream === undefined) throw new Error('Expected a Terminal stream');
      return stream;
    },
    close() {
      client.disconnect();
      node.disconnect();
      service.clear();
    }
  };
}

describe('Node Admin Terminal', () => {
  it.each([
    { afterSequence: undefined, sequences: [2, 3], gap: true },
    { afterSequence: 0, sequences: [2, 3], gap: true },
    { afterSequence: 1, sequences: [2, 3], gap: false },
    { afterSequence: 2, sequences: [3], gap: false },
    { afterSequence: 3, sequences: [], gap: false },
    { afterSequence: Number.MAX_SAFE_INTEGER, sequences: [], gap: false }
  ])(
    'preserves replay and GAP for safe cursor $afterSequence',
    async ({ afterSequence, sequences, gap }) => {
      const holder: { value?: FakePty } = {};
      const manager = new TerminalManager({
        platform: 'linux',
        ptyFactory: fakeFactory(holder),
        maxReplayBytes: 2,
        terminate: async () => undefined
      });
      try {
        const terminal = manager.open({ cwd: '/workspace' });
        holder.value!.emitData('a');
        holder.value!.emitData('b');
        holder.value!.emitData('c');
        const frames = [
          ...(gap ? [{ type: 'error', terminalId: terminal.id, code: 'TERMINAL_REPLAY_GAP' }] : []),
          ...sequences.map((sequence) => ({
            type: 'output',
            terminalId: terminal.id,
            sequence,
            data: Uint8Array.of(sequence === 2 ? 98 : 99)
          }))
        ];
        const attachment = manager.authorizeAttach({ terminalId: terminal.id, afterSequence });
        expect(attachment.latestSequence).toBe(3);
        expect(attachment.frames).toEqual(frames);
        expect(
          manager.synchronizeAttachment({
            attachmentId: attachment.attachmentId,
            terminalId: terminal.id,
            afterSequence
          })
        ).toEqual({ active: true, frames });
        expect(
          manager.synchronizeAttachment({
            attachmentId: attachment.attachmentId,
            terminalId: terminal.id,
            afterSequence: 3
          })
        ).toEqual({ active: true, frames: [] });
        manager.detach(attachment.attachmentId);
        const resumed = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 3 });
        expect(resumed.frames).toEqual([]);
      } finally {
        await manager.shutdown();
      }
    }
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.5, NaN, Infinity, -Infinity, '1', null])(
    'rejects invalid replay cursor %s without allocating or invalidating an attachment',
    async (afterSequence) => {
      const manager = new TerminalManager({
        platform: 'linux',
        ptyFactory: fakeFactory({}),
        terminate: async () => undefined
      });
      try {
        const terminal = manager.open({ cwd: '/workspace' });
        expect(() =>
          manager.authorizeAttach({ terminalId: terminal.id, afterSequence })
        ).toThrowError(new Error('TERMINAL_REPLAY_INVALID'));
        const attachment = manager.authorizeAttach({ terminalId: terminal.id });
        expect(() =>
          manager.synchronizeAttachment({
            attachmentId: attachment.attachmentId,
            terminalId: terminal.id,
            afterSequence
          })
        ).toThrowError(new Error('TERMINAL_REPLAY_INVALID'));
        expect(
          manager.synchronizeAttachment({
            attachmentId: attachment.attachmentId,
            terminalId: terminal.id,
            afterSequence: 0
          })
        ).toEqual({ active: true, frames: [] });
      } finally {
        await manager.shutdown();
      }
    }
  );

  it.each([1001, 1006, 4003])(
    'preserves Terminal lifecycle and idle collection after control close %s',
    async (code) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let timestamp = 0;
      const ptys: FakePty[] = [];
      const terminate = vi.fn(async () => undefined);
      const manager = new TerminalManager({
        platform: 'linux',
        now: () => timestamp,
        ptyFactory: () => {
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
        terminate
      });
      const directory = await mkdtemp(join(tmpdir(), 'mar-terminal-reconnect-'));
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      let connector: NodeConnector | undefined;
      const controls: WebSocket[] = [];
      const relays: NodeStreamMux[] = [];
      const exits: string[] = [];
      manager.onFrame((frame) => {
        if (frame.type === 'exit') exits.push(frame.terminalId);
      });
      try {
        await once(server, 'listening');
        const udp = createSocket('udp4');
        await new Promise<void>((resolve, reject) => {
          udp.once('error', reject);
          udp.bind(0, '127.0.0.1', resolve);
        });
        const udpPort = udp.address().port;
        await new Promise<void>((resolve) => udp.close(() => resolve()));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('ADDRESS_INVALID');
        server.on('connection', (socket, request) => {
          if (request.url === '/api/node/connect') {
            socket.on('message', (raw) => {
              const message = JSON.parse(raw.toString());
              if (message.type === 'authenticate') {
                controls.push(socket);
                socket.send(JSON.stringify(createEnvelope('authenticated', {})));
              } else if (message.type === 'capabilities') {
                socket.send(
                  JSON.stringify(
                    createEnvelope(
                      'ack',
                      {
                        type: 'capabilities',
                        dataControlBinding: `binding-${controls.length}`
                      },
                      { replyTo: message.id }
                    )
                  )
                );
              }
            });
            return;
          }
          if (request.url !== '/api/node/relay') return socket.close();
          socket.once('message', (raw) => {
            const auth = decodeNodeRelayHandshake(raw);
            if (auth.type !== 'RELAY_AUTH' || auth.controlBinding !== `binding-${controls.length}`)
              return socket.close();
            const mux = new NodeStreamMux({
              maxStreams: 4,
              send: (bytes) =>
                new Promise((resolve, reject) => {
                  socket.send(bytes, (error) => (error ? reject(error) : resolve()));
                })
            });
            socket.on('message', (bytes) => mux.receive(bytes));
            socket.once('close', () => mux.disconnect());
            socket.send(encodeNodeRelayHandshake({ type: 'RELAY_READY' }));
            relays.push(mux);
          });
        });
        connector = new NodeConnector({
          configPath: join(directory, 'node.json'),
          config: {
            serverUrl: `http://127.0.0.1:${address.port}`,
            nodeId: 'terminal-node',
            credential: 'fixture-credential',
            directTransfer: { udpPortRangeBegin: udpPort, udpPortRangeEnd: udpPort },
            allowedRoots: [directory]
          },
          database: new NodeDatabase(':memory:', 'terminal-node'),
          terminalManager: manager,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        });
        await connector.start();
        await vi.waitFor(() => expect(relays).toHaveLength(1));
        const original = manager.open();
        const { grant } = (await operation(connector, 'terminal.attach.authorize', {
          terminalId: original.id
        })) as { grant: string };
        const stream = (await relays[0]!.openStream({ kind: 'terminal', grant }))!;
        const records = readTerminalRecords(stream);
        expect(decodeTerminalMessage((await records.next()).value!)).toMatchObject({
          type: 'attach'
        });
        const input = (data: string) =>
          writeTerminalRecord(
            encodeTerminalMessage({
              type: 'input',
              terminalId: original.id,
              data: new TextEncoder().encode(data)
            })
          );
        await stream.write(input('long-running-command\n'));
        await vi.waitFor(() => expect(ptys[0]!.writes).toEqual(['long-running-command\n']));
        if (code === 1006) controls[0]!.terminate();
        else controls[0]!.close(code, code === 1001 ? 'SERVER_SHUTDOWN' : 'NODE_REVOKED');
        await vi.waitFor(() => expect(controls).toHaveLength(2), { timeout: 5_000 });
        await vi.waitFor(() => expect(relays).toHaveLength(2));
        expect(manager.get(original.id).state).toBe(code === 4003 ? 'CLOSED' : 'RUNNING');
        await stream.finished;
        await expect(stream.write(input('stale-input'))).rejects.toThrow(
          'NODE_STREAM_DISCONNECTED'
        );
        expect(ptys).toHaveLength(1);
        expect(ptys[0]!.writes).toEqual(['long-running-command\n']);
        if (code !== 4003) {
          ptys[0]!.emitData('continued output');
          expect(manager.authorizeAttach({ terminalId: original.id }).frames).toEqual([
            expect.objectContaining({
              type: 'output',
              data: new TextEncoder().encode('continued output')
            })
          ]);
        }
        const detached = manager.open();
        const active = manager.open();
        const writer = manager.authorizeAttach({ terminalId: active.id });
        timestamp += 2 * 60 * 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(manager.get(detached.id).state).toBe('CLOSED');
        expect(manager.get(active.id).state).toBe('RUNNING');
        manager.detach(writer.attachmentId);
        timestamp += 60 * 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(manager.get(active.id).state).toBe('CLOSED');
        const final = manager.open();
        manager.authorizeAttach({ terminalId: final.id });
        await connector.stop();
        await connector.stop();
        expect(manager.list().every((terminal) => terminal.state === 'CLOSED')).toBe(true);
        expect(terminate).not.toHaveBeenCalled();
        expect(ptys.map((pty) => pty.kills)).toEqual(ptys.map(() => 1));
        expect(new Set(exits).size).toBe(ptys.length);
        expect(exits).toHaveLength(ptys.length);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await connector?.stop();
        await manager.shutdown();
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
    15_000
  );

  it('closes CLI jobs but keeps browser terminals when the shared data carrier disconnects', async () => {
    const cliPty = new FakePty();
    const browserPty = new FakePty();
    const manager = new TerminalManager({
      ptyFactory: vi.fn(() => browserPty).mockReturnValueOnce(cliPty)
    });
    const fixture = terminalStreamFixture(manager);
    try {
      const cli = manager.open();
      const browser = manager.open();
      await fixture.open(cli.id, { closeOnDisconnect: true });
      await fixture.open(browser.id);
      fixture.close();
      await vi.waitFor(() => expect(manager.get(cli.id).state).toBe('CLOSED'));
      expect(cliPty.kills).toBe(1);
      expect(manager.get(browser.id).state).toBe('RUNNING');
      expect(browserPty.kills).toBe(0);
      expect(manager.authorizeAttach({ terminalId: browser.id }).terminalId).toBe(browser.id);
    } finally {
      fixture.close();
      await manager.shutdown();
    }
  });

  it('waits for in-flight terminal cleanup on repeated close and shutdown', async () => {
    const pty = new FakePty();
    vi.spyOn(pty, 'kill').mockImplementation(() => {
      throw new Error('PTY_CLOSE_FAILED');
    });
    let release!: () => void;
    const terminate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const manager = new TerminalManager({ ptyFactory: () => pty, terminate });
    const terminal = manager.open();
    const first = manager.close(terminal.id);
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    let shutdownFinished = false;
    const second = manager.close(terminal.id);
    const shutdown = manager.shutdown().then(() => {
      shutdownFinished = true;
    });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    release();
    await Promise.all([first, second, shutdown]);
    expect(shutdownFinished).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each(
    (['win32', 'linux', 'darwin'] as const).flatMap((platform) =>
      (['close', 'shutdown'] as const).map((operation) => [platform, operation] as const)
    )
  )('releases a %s PTY through %s exactly once', async (platform, operation) => {
    const pty = new FakePty();
    const kill = vi.spyOn(pty, 'kill').mockImplementation(() => {
      pty.emitExit(0);
      return true;
    });
    const terminate = vi.fn(async () => undefined);
    const manager = new TerminalManager({ platform, ptyFactory: () => pty, terminate });
    const frames: { type: string }[] = [];
    manager.onFrame((frame) => frames.push(frame));
    const terminal = manager.open();
    if (operation === 'shutdown') await manager.shutdown();
    expect((await manager.close(terminal.id)).state).toBe('CLOSED');
    await manager.close(terminal.id);
    await manager.shutdown();
    expect(kill).toHaveBeenCalledExactlyOnceWith();
    expect(terminate).not.toHaveBeenCalled();
    expect(frames.filter((frame) => frame.type === 'exit')).toHaveLength(1);
  });

  it.each(['win32', 'linux', 'darwin'] as const)(
    'falls back to process-tree termination when %s native PTY kill throws',
    async (platform) => {
      const pty = new FakePty();
      vi.spyOn(pty, 'kill').mockImplementation(() => {
        throw new Error('Native console cleanup failed.');
      });
      const terminate = vi.fn(async () => undefined);
      const manager = new TerminalManager({ platform, ptyFactory: () => pty, terminate });
      const terminal = manager.open();
      await manager.close(terminal.id);
      expect(terminate).toHaveBeenCalledExactlyOnceWith(pty, platform);
      await manager.shutdown();
    }
  );

  it('adds the installed CLI bin to MAR child PATH without treating the context marker as authorization', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'mar-node-cli-env-'));
    const bin = join(packageRoot, 'node_modules', '.bin');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'marnodes'), '');
      const inherited = { PATH: '/usr/bin', MAR_NODE_CONTEXT: '0' };
      const input = { PATH: '/custom/bin', MAR_NODE_CONTEXT: '0' };
      const environment = nodeExecutionEnvironment(input, inherited, {
        platform: 'linux',
        packageRoot
      });
      expect(environment).toMatchObject({
        PATH: `${bin}:/custom/bin`,
        MAR_NODE_CONTEXT: '1'
      });
      expect(environment['MAR_CTL_USER_TOKEN']).toBeUndefined();
      expect(
        nodeExecutionEnvironment(environment, inherited, { platform: 'linux', packageRoot })
      ).toMatchObject({ PATH: `${bin}:/custom/bin` });
      expect(inherited.MAR_NODE_CONTEXT).toBe('0');
      expect(input.PATH).toBe('/custom/bin');

      await writeFile(join(bin, 'marnodes.cmd'), '');
      const windows = nodeExecutionEnvironment(
        { PATH: 'D:\\Tools', MAR_NODE_CONTEXT: '0' },
        { Path: 'C:\\Windows\\System32' },
        { platform: 'win32', packageRoot }
      );
      expect(windows['PATH']).toBe(`${bin};D:\\Tools`);
      expect(windows['Path']).toBeUndefined();
      expect(windows['MAR_NODE_CONTEXT']).toBe('1');
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
  it('uses only the current execution username and clears inherited service identity', () => {
    const inherited = { MAR_USERNAME: 'service-owner', USER: 'os-user' };
    expect(nodeExecutionEnvironment({ MAR_USERNAME: 'alice' }, inherited)['MAR_USERNAME']).toBe(
      'alice'
    );
    expect(nodeExecutionEnvironment({}, inherited)['MAR_USERNAME']).toBe('');
    expect(inherited.MAR_USERNAME).toBe('service-owner');
    for (const username of ['bad\0name', 'bad\nname', 'x'.repeat(129)])
      expect(() => nodeExecutionEnvironment({ MAR_USERNAME: username }, inherited)).toThrow(
        'SECRET_ENVIRONMENT_INVALID'
      );
  });
  it.each([
    ['linux', 'prefix', 'node_modules/@myagentroam/node', 'node_modules/.bin'],
    ['win32', 'prefix', 'node_modules/@myagentroam/node', 'node_modules/.bin'],
    ['linux', 'global', 'lib/node_modules/@myagentroam/node', 'bin'],
    ['win32', 'global', 'node_modules/@myagentroam/node', '.'],
    [
      'linux',
      'pnpm',
      'node_modules/.pnpm/@myagentroam+node@1/node_modules/@myagentroam/node',
      'node_modules/.pnpm/@myagentroam+node@1/node_modules/.bin'
    ],
    [
      'win32',
      'pnpm',
      'node_modules/.pnpm/@myagentroam+node@1/node_modules/@myagentroam/node',
      'node_modules/.pnpm/@myagentroam+node@1/node_modules/.bin'
    ]
  ] as const)(
    'resolves %s CLI commands from the %s installation layout',
    async (platform, _layout, packageDirectory, binDirectory) => {
      const installation = await mkdtemp(join(tmpdir(), 'mar-node-installed-cli-'));
      const packageRoot = join(installation, packageDirectory);
      const bin = join(installation, binDirectory);
      try {
        await mkdir(packageRoot, { recursive: true });
        await mkdir(bin, { recursive: true });
        for (const name of ['marctl', 'marnodes', 'marssh', 'marscp'])
          await writeFile(join(bin, platform === 'win32' ? `${name}.cmd` : name), '');
        const inherited =
          platform === 'win32' ? { Path: 'C:\\Windows\\System32' } : { PATH: '/usr/bin' };
        const environment = nodeExecutionEnvironment({}, inherited, { platform, packageRoot });
        const key = platform === 'win32' ? 'Path' : 'PATH';
        const separator = platform === 'win32' ? ';' : ':';
        expect(environment[key]).toBe(`${bin}${separator}${inherited[key]}`);
        expect(environment['MAR_NODE_CONTEXT']).toBe('1');
        expect(environment['MAR_CTL_USER_TOKEN']).toBeUndefined();
        if (platform === 'win32') expect(environment['PATH']).toBeUndefined();
        expect(nodeExecutionEnvironment({}, environment, { platform, packageRoot })[key]).toBe(
          environment[key]
        );
      } finally {
        await rm(installation, { recursive: true, force: true });
      }
    }
  );

  it('prefers package-local CLI commands over installation-level commands', async () => {
    const installation = await mkdtemp(join(tmpdir(), 'mar-node-local-cli-'));
    const packageRoot = join(installation, 'node_modules', '@myagentroam', 'node');
    const localBin = join(packageRoot, 'node_modules', '.bin');
    const outerBin = join(installation, 'node_modules', '.bin');
    try {
      for (const bin of [localBin, outerBin]) {
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, 'marnodes'), '');
      }
      expect(
        nodeExecutionEnvironment({}, { PATH: '/usr/bin' }, { platform: 'linux', packageRoot })
      ).toMatchObject({ PATH: `${localBin}:/usr/bin` });
    } finally {
      await rm(installation, { recursive: true, force: true });
    }
  });

  it('keeps PATH when this installation has no CLI without using unrelated ancestor commands', async () => {
    const installation = await mkdtemp(join(tmpdir(), 'mar-node-missing-cli-'));
    const packageRoot = join(installation, 'mar-node');
    const unrelatedBin = join(installation, 'node_modules', '.bin');
    try {
      await mkdir(packageRoot, { recursive: true });
      await mkdir(unrelatedBin, { recursive: true });
      await writeFile(join(unrelatedBin, 'marnodes'), '');
      expect(
        nodeExecutionEnvironment({}, { PATH: '/usr/bin' }, { platform: 'linux', packageRoot })
      ).toEqual({ PATH: '/usr/bin', MAR_NODE_CONTEXT: '1', MAR_USERNAME: '' });
    } finally {
      await rm(installation, { recursive: true, force: true });
    }
  });

  it('round-trips raw bytes through a real pipe command and exits after stdout closes', async () => {
    const manager = new TerminalManager({
      platform: 'linux',
      profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }],
      ptyFactory: () => {
        throw new Error('PTY_MUST_NOT_START');
      }
    });
    const frames: { type: string; data?: Uint8Array; exitCode?: number | null }[] = [];
    try {
      manager.onFrame((frame) => frames.push(frame));
      const command = `${JSON.stringify(process.execPath)} -e 'process.stdin.once("data", bytes => { process.stdout.write(bytes); process.stdin.destroy(); })'`;
      const terminal = manager.openCommand({}, command);
      const writer = manager.authorizeAttach({ terminalId: terminal.id });
      manager.startCommand(terminal.id);
      const bytes = Buffer.from([0, 255, 42, 10, 128]);
      await manager.acceptFrame(writer.attachmentId, {
        type: 'input',
        terminalId: terminal.id,
        data: bytes
      });
      await vi.waitFor(() => expect(manager.get(terminal.id).state).toBe('EXITED'), {
        timeout: 5_000
      });
      expect(
        Buffer.concat(
          frames.filter((frame) => frame.type === 'output').map((frame) => Buffer.from(frame.data!))
        )
      ).toEqual(bytes);
      expect(frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
    } finally {
      await manager.shutdown();
    }
  });

  it.runIf(process.platform === 'linux')(
    'preserves real PTY tail output and exit ordering when transport writes are pending',
    async () => {
      const gate = Promise.withResolvers<void>();
      const writing = Promise.withResolvers<void>();
      const manager = new TerminalManager({
        profiles: [
          {
            id: 'default',
            label: 'sh',
            shell: '/bin/sh',
            isDefault: true,
            args: [
              '-c',
              `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(24576))'`
            ]
          }
        ]
      });
      const fixture = terminalStreamFixture(manager, async (bytes) => {
        if (decodeNodeStreamFrame(bytes).type === 'DATA') {
          writing.resolve();
          await gate.promise;
        }
      });
      try {
        const terminal = manager.open();
        const stream = await fixture.open(terminal.id);
        await writing.promise;
        await vi.waitFor(() => expect(manager.get(terminal.id).state).toBe('EXITED'));
        gate.resolve();
        const frames = [];
        await stream.endWrite();
        for await (const record of readTerminalRecords(stream))
          frames.push(decodeTerminalMessage(record));
        expect(frames[0]).toMatchObject({ type: 'attach' });
        expect(frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
        const bytes = Buffer.concat(frames.slice(1, -1).map((frame) => frame.data as Uint8Array));
        expect(bytes).toEqual(Buffer.alloc(24576, 'x'));
      } finally {
        gate.resolve();
        fixture.close();
        await manager.shutdown();
      }
    }
  );

  it('releases pipe backpressure immediately when the relay writer detaches or changes', async () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const manager = new TerminalManager({
      platform: 'linux',
      terminate: async () => undefined,
      pipeFactory: () => ({
        pid: 4242,
        kill: () => true,
        pause,
        resume,
        write: vi.fn(),
        onData: () => undefined,
        onExit: () => undefined
      })
    });
    try {
      const terminal = manager.openCommand({}, 'fixture');
      const relay = manager.authorizeAttach({ terminalId: terminal.id });
      manager.startCommand(terminal.id);
      manager.setAttachmentBackpressure(relay.attachmentId, true);
      expect(pause).toHaveBeenCalledOnce();
      manager.detach(relay.attachmentId);
      expect(resume).toHaveBeenCalledOnce();
      const direct = manager.authorizeAttach({ terminalId: terminal.id });
      manager.setAttachmentBackpressure(relay.attachmentId, true);
      expect(pause).toHaveBeenCalledOnce();
      await expect(
        manager.acceptFrame(direct.attachmentId, {
          type: 'input',
          terminalId: terminal.id,
          data: Buffer.from('input')
        })
      ).resolves.toBeUndefined();
    } finally {
      await manager.shutdown();
    }
  });

  it('removes a pending SCP destination temporary file when its terminal closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mar-terminal-copy-cancel-'));
    const destination = join(dir, 'destination');
    const manager = new TerminalManager({});
    try {
      await writeFile(destination, 'original');
      const terminal = manager.openCopy({
        mode: 'write',
        path: destination,
        size: 5,
        sourceMode: 0o600,
        atimeMs: 0,
        mtimeMs: 0,
        preserve: false,
        sourceBasename: 'source'
      });
      manager.startCommand(terminal.id);
      await vi.waitFor(async () => expect(await readdir(dir)).toHaveLength(2));
      await manager.close(terminal.id);
      expect(await readdir(dir)).toEqual(['destination']);
      expect(await readFile(destination, 'utf8')).toBe('original');
    } finally {
      await manager.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resets a slow readonly observer without interrupting the writer or another stream', async () => {
    let publish!: (data: Buffer) => void;
    const pause = vi.fn();
    const write = vi.fn();
    const manager = new TerminalManager({
      platform: 'linux',
      ptyFactory: () => new FakePty(),
      pipeFactory: () => ({
        kill: () => true,
        write,
        pause,
        resume: vi.fn(),
        onData: (listener) => {
          publish = listener;
        },
        onExit: () => undefined
      })
    });
    const fixture = terminalStreamFixture(manager);
    try {
      const shell = manager.open();
      const command = manager.openCommand({}, 'fixture');
      const writer = manager.authorizeAttach({ terminalId: command.id });
      manager.startCommand(command.id);
      const observer = await fixture.open(command.id, { readonly: true });
      const observed = readTerminalRecords(observer);
      expect(decodeTerminalMessage((await observed.next()).value)).toMatchObject({
        type: 'attach'
      });
      const other = await fixture.open(shell.id);
      const otherRecords = readTerminalRecords(other);
      expect(decodeTerminalMessage((await otherRecords.next()).value)).toMatchObject({
        type: 'attach'
      });
      publish(Buffer.alloc(3 * 1024 * 1024, 42));
      await observer.finished;
      await expect(observed.next()).rejects.toThrow('TERMINAL_BACKPRESSURE');
      expect(pause).not.toHaveBeenCalled();
      expect(manager.get(command.id).state).toBe('RUNNING');
      await expect(
        manager.acceptFrame(writer.attachmentId, {
          type: 'input',
          terminalId: command.id,
          data: Buffer.from('input')
        })
      ).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(Buffer.from('input'));
      await expect(
        other.write(
          writeTerminalRecord(
            encodeTerminalMessage({
              type: 'input',
              terminalId: shell.id,
              data: Buffer.from('still connected')
            })
          )
        )
      ).resolves.toBeUndefined();
    } finally {
      fixture.close();
      await manager.shutdown();
    }
  });

  it('streams binary command bytes through the same authorized terminal frames', async () => {
    const writes: Buffer[] = [];
    let output!: (data: Buffer) => void;
    let exit!: (code: number) => void;
    const manager = new TerminalManager({
      platform: 'linux',
      ptyFactory: () => {
        throw new Error('PTY_MUST_NOT_START');
      },
      pipeFactory: (_shell, args): TerminalPipe => {
        expect(args).toEqual(['-c', 'node -e "test"']);
        return {
          pid: 144,
          kill: () => true,
          write: (data) => writes.push(data),
          onData: (listener) => {
            output = listener;
          },
          onExit: (listener) => {
            exit = listener;
          }
        };
      }
    });
    const frames: unknown[] = [];
    manager.onFrame((frame) => frames.push(frame));
    const terminal = manager.openCommand({}, 'node -e "test"');
    const writer = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0 });
    manager.startCommand(terminal.id);
    output(Buffer.from([0, 255, 42]));
    expect(frames[0]).toEqual({
      type: 'output',
      terminalId: terminal.id,
      sequence: 1,
      data: Uint8Array.of(0, 255, 42)
    });
    expect(
      manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0, readonly: true }).frames
    ).toEqual([frames[0]]);
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: Uint8Array.of(0, 255, 42)
    });
    expect(writes).toEqual([Buffer.from([0, 255, 42])]);
    await expect(
      manager.acceptFrame(writer.attachmentId, {
        type: 'input',
        terminalId: terminal.id,
        data: 'invalid!'
      })
    ).rejects.toThrow('TERMINAL_FRAME_INVALID');
    exit(0);
    expect(frames.at(-1)).toEqual({ type: 'exit', terminalId: terminal.id, exitCode: 0 });
  });

  it('starts a command only after an authorized attachment and preserves its exit status', async () => {
    const manager = new TerminalManager({ platform: 'linux' });
    const frames: unknown[] = [];
    manager.onFrame((frame) => frames.push(frame));
    expect(() => manager.openCommand({}, '\0bad')).toThrow('TERMINAL_COMMAND_INVALID');
    const terminal = manager.openCommand({}, 'printf "%s" ready; exit 17');
    expect(frames).toEqual([]);
    const attachment = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0 });
    expect(attachment.frames).toEqual([]);
    manager.startCommand(terminal.id);
    await vi.waitFor(() => expect(manager.get(terminal.id).state).toBe('EXITED'));
    expect(frames).toEqual([
      {
        type: 'output',
        terminalId: terminal.id,
        sequence: 1,
        data: new TextEncoder().encode('ready')
      },
      { type: 'exit', terminalId: terminal.id, exitCode: 17 }
    ]);
    expect(manager.get(terminal.id)).toMatchObject({ state: 'EXITED', exitCode: 17 });
  });

  it('accepts command strings up to 64 KiB by UTF-8 bytes', () => {
    const manager = new TerminalManager({
      platform: 'linux',
      ptyFactory: fakeFactory({})
    });
    expect(() => manager.openCommand({}, 'a'.repeat(64 * 1024))).not.toThrow();
    expect(() => manager.openCommand({}, 'a'.repeat(64 * 1024 + 1))).toThrow(
      'TERMINAL_COMMAND_INVALID'
    );
    expect(() => manager.openCommand({}, 'é'.repeat(32 * 1024))).not.toThrow();
    expect(() => manager.openCommand({}, `${'é'.repeat(32 * 1024)}a`)).toThrow(
      'TERMINAL_COMMAND_INVALID'
    );
  });

  it('closes deferred commands without launching a process', async () => {
    const holder: { value?: FakePty } = {};
    const manager = new TerminalManager({ platform: 'linux', ptyFactory: fakeFactory(holder) });
    const terminal = manager.openCommand({}, 'echo should-not-run');
    await manager.close(terminal.id);
    manager.startCommand(terminal.id);
    expect(holder.value).toBeUndefined();
  });

  it('Windows terminal prefers pwsh, then falls back to Windows PowerShell and cmd', () => {
    const pwsh = (command: string) =>
      ({
        'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
      })[command];
    const powershell = (command: string) =>
      ({
        'pwsh.exe': undefined,
        'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
      })[command];
    const commandPrompt = (command: string) =>
      ({
        'pwsh.exe': undefined,
        'powershell.exe': undefined,
        'cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
      })[command];

    expect(defaultTerminalProfiles('win32', pwsh)[0]).toMatchObject({
      label: 'PowerShell 7',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    });
    expect(defaultTerminalProfiles('win32', powershell)[0]).toMatchObject({
      label: 'Windows PowerShell',
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    });
    expect(defaultTerminalProfiles('win32', commandPrompt)[0]).toMatchObject({
      label: 'Windows Command Prompt',
      shell: 'C:\\Windows\\System32\\cmd.exe'
    });
  });

  it('macOS uses the service account shell as a POSIX PTY', () => {
    expect(defaultTerminalProfiles('darwin')[0]).toMatchObject({
      label: 'User Shell',
      shell: process.env['SHELL']?.trim() || '/bin/bash',
      args: ['-l', '-i']
    });
  });

  it('Linux PTY fixes the profile and supports Unicode/ANSI, resize, replay gaps, and exclusive writers', async () => {
    const holder: { value?: FakePty; cwd?: string } = {};
    const terminated: number[] = [];
    const manager = new TerminalManager({
      platform: 'linux',
      ptyFactory: fakeFactory(holder),
      maxReplayBytes: 5,
      idleTimeoutMs: 60_000,
      terminate: async (child, platform) => {
        expect(platform).toBe('linux');
        terminated.push(child.pid as number);
      }
    });
    const terminal = manager.open({ rows: 30, cols: 120, cwd: '/workspace' });
    const pty = holder.value as FakePty;
    expect(terminal).toMatchObject({ state: 'RUNNING', rows: 30, cols: 120 });
    expect(terminal.workspaceId).toBeNull();
    expect(holder).toMatchObject({
      shell: process.env['SHELL']?.trim() || '/bin/bash',
      args: ['-l', '-i'],
      cwd: '/workspace'
    });

    const writer = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0 });
    expect(writer.latestSequence).toBe(0);
    const command = new TextEncoder().encode('echo 你好\n');
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: command.subarray(0, 6)
    });
    expect(pty.writes).toEqual(['echo ']);
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: command.subarray(6)
    });
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: new TextEncoder().encode('git che\t')
    });
    await manager.acceptFrame(writer.attachmentId, {
      type: 'resize',
      terminalId: terminal.id,
      rows: 40,
      cols: 100
    });
    expect(pty.writes).toEqual(['echo ', '你好\n', 'git che\t']);
    expect(pty.resizes).toEqual([{ cols: 100, rows: 40 }]);

    pty.emitData('\u001b[31mfirst');
    pty.emitData('last!');
    expect(
      manager.synchronizeAttachment({
        attachmentId: writer.attachmentId,
        terminalId: terminal.id,
        afterSequence: writer.latestSequence
      })
    ).toEqual({
      active: true,
      frames: [
        { type: 'error', terminalId: terminal.id, code: 'TERMINAL_REPLAY_GAP' },
        {
          type: 'output',
          terminalId: terminal.id,
          sequence: 2,
          data: new TextEncoder().encode('last!')
        }
      ]
    });
    const replay = manager.authorizeAttach({
      terminalId: terminal.id,
      afterSequence: 0,
      readonly: true
    });
    expect(replay.frames).toEqual([
      { type: 'error', terminalId: terminal.id, code: 'TERMINAL_REPLAY_GAP' },
      {
        type: 'output',
        terminalId: terminal.id,
        sequence: 2,
        data: new TextEncoder().encode('last!')
      }
    ]);
    expect(() => manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 2 })).toThrow(
      'TERMINAL_ATTACH_CONFLICT'
    );
    expect(() => manager.authorizeAttach({ terminalId: terminal.id, takeover: true })).toThrow(
      'TERMINAL_ATTACH_INVALID'
    );
    manager.detach(writer.attachmentId);
    const resumed = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 2 });
    expect(
      manager.synchronizeAttachment({
        attachmentId: writer.attachmentId,
        terminalId: terminal.id,
        afterSequence: writer.latestSequence
      })
    ).toEqual({ active: false, reason: 'INACTIVE', frames: [] });
    await expect(
      manager.acceptFrame(writer.attachmentId, {
        type: 'input',
        terminalId: terminal.id,
        data: new TextEncoder().encode('stale')
      })
    ).rejects.toThrow('TERMINAL_ATTACH_INVALID');
    await manager.acceptFrame(resumed.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: new TextEncoder().encode('current')
    });
    const largeOutputFrames: Uint8Array[] = [];
    const stopCapturingOutput = manager.onFrame((frame) => {
      if (frame.type === 'output') largeOutputFrames.push(frame.data);
    });
    pty.emitData(`${'a'.repeat(65_535)}😀`);
    stopCapturingOutput();
    expect(largeOutputFrames.every((frame) => frame.byteLength <= 32 * 1024)).toBe(true);
    expect(Buffer.concat(largeOutputFrames).toString()).toBe(`${'a'.repeat(65_535)}😀`);
    await manager.close(terminal.id);
    expect(pty.kills).toBe(1);
    expect(terminated).toEqual([]);
    await manager.shutdown();
  });

  it.each(['close', 'exit', 'shutdown'] as const)(
    'preserves Terminal lifecycle after Workspace removal: %s',
    async (action) => {
      const directory = await mkdtemp(join(tmpdir(), 'mar-terminal-workspace-'));
      const holder: { value?: FakePty } = {};
      const terminate = vi.fn(async () => undefined);
      const manager = new TerminalManager({
        platform: 'linux',
        ptyFactory: fakeFactory(holder),
        terminate
      });
      const database = new NodeDatabase(':memory:', 'terminal-workspace');
      const connector = new NodeConnector({
        reconnect: false,
        database,
        terminalManager: manager,
        capabilities: {
          platform: 'linux',
          architecture: 'x64',
          nodeVersion: process.version,
          codex: { available: false },
          claudeCode: { available: false }
        }
      });
      try {
        const workspace = database.saveWorkspace({
          path: directory,
          kind: 'DIRECTORY',
          gitSummary: null
        });
        const other = database.saveWorkspace({
          path: directory + '-other',
          kind: 'DIRECTORY',
          gitSummary: null
        });
        const opened = (await operation(connector, 'terminal.open', {
          workspaceId: workspace.id
        })) as { terminal: { id: string } };
        const pty = holder.value!;
        const unrelated = manager.open({ workspaceId: other.id });
        // A failed registration removal must leave the in-memory association unchanged.
        database.raw.exec(`CREATE TRIGGER fail_workspace_remove BEFORE DELETE ON workspaces
          BEGIN SELECT RAISE(ABORT,'synthetic Workspace removal failure'); END`);
        await expect(
          operation(connector, 'workspace.remove', { workspaceId: workspace.id })
        ).rejects.toThrow('synthetic Workspace removal failure');
        expect(manager.get(opened.terminal.id).workspaceId).toBe(workspace.id);
        database.raw.exec('DROP TRIGGER fail_workspace_remove');
        await operation(connector, 'workspace.remove', { workspaceId: workspace.id });
        expect(database.getTerminalSession(opened.terminal.id)?.workspaceId).toBeNull();
        if (action === 'close') await manager.close(opened.terminal.id);
        else if (action === 'exit') pty.emitExit(7);
        else await manager.shutdown();
        expect(manager.get(opened.terminal.id)).toMatchObject({
          workspaceId: null,
          state: action === 'exit' ? 'EXITED' : 'CLOSED'
        });
        expect(database.getTerminalSession(opened.terminal.id)).toMatchObject({
          workspaceId: null,
          state: action === 'exit' ? 'EXITED' : 'CLOSED'
        });
        expect(manager.get(unrelated.id).workspaceId).toBe(other.id);
        expect(terminate).not.toHaveBeenCalled();
        expect(pty.kills).toBe(action === 'exit' ? 0 : 1);
        expect(holder.value!.kills).toBe(action === 'shutdown' ? 1 : 0);
      } finally {
        await manager.shutdown();
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('Windows ConPTY writes lifecycle metadata but never writes terminal body', async () => {
    const holder: { value?: FakePty; cwd?: string } = {};
    const manager = new TerminalManager({
      platform: 'win32',
      ptyFactory: fakeFactory(holder),
      terminate: async (_child, platform) => expect(platform).toBe('win32')
    });
    const database = new NodeDatabase(':memory:', 'node-terminal');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      terminalManager: manager,
      capabilities: {
        platform: 'windows',
        architecture: 'x64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false }
      }
    });
    const workspace = database.saveWorkspace({
      path: 'C:\\workspace',
      kind: 'DIRECTORY',
      gitSummary: null
    });
    for (const extra of [{ binary: false }, { unexpected: true }])
      await expect(
        operation(connector, 'terminal.open', { rows: 20, cols: 90, ...extra })
      ).rejects.toThrow('TERMINAL_OPEN_INVALID');
    const opened = (await operation(connector, 'terminal.open', {
      rows: 20,
      cols: 90,
      workspaceId: workspace.id
    })) as {
      terminal: { id: string };
    };
    expect(holder.cwd).toBe('C:\\workspace');
    (holder.value as FakePty).emitData('secret terminal output');
    expect(database.getTerminalSession(opened.terminal.id)).toMatchObject({
      state: 'RUNNING',
      workspaceId: workspace.id,
      rows: 20,
      cols: 90
    });
    const manifest = (await operation(connector, 'node.workbench.capabilities', {})) as {
      manifest: {
        terminal: {
          available: boolean;
          supportsConPty: boolean;
          supportsPty: boolean;
          supportsTakeover: boolean;
        };
      };
    };
    expect(manifest.manifest.terminal).toEqual(
      expect.objectContaining({
        available: true,
        supportsConPty: true,
        supportsPty: false,
        supportsTakeover: false
      })
    );
    await operation(connector, 'terminal.close', { terminalId: opened.terminal.id });
    expect(database.getTerminalSession(opened.terminal.id)).toMatchObject({ state: 'CLOSED' });
    expect(
      database.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'terminal_sessions'").get()
    ).not.toMatchObject({
      sql: expect.stringMatching(/data|content|output|input/i)
    });
    connector.stop();
  });

  it('macOS declares a POSIX PTY instead of ConPTY', async () => {
    const manager = new TerminalManager({
      platform: 'darwin',
      ptyFactory: fakeFactory({}),
      terminate: async (_child, platform) => expect(platform).toBe('darwin')
    });
    const database = new NodeDatabase(':memory:', 'node-terminal-macos');
    const connector = new NodeConnector({
      reconnect: false,
      database,
      terminalManager: manager,
      capabilities: {
        platform: 'macos',
        architecture: 'arm64',
        nodeVersion: process.version,
        codex: { available: false },
        claudeCode: { available: false }
      }
    });

    const manifest = (await operation(connector, 'node.workbench.capabilities', {})) as {
      manifest: { terminal: { available: boolean; supportsConPty: boolean; supportsPty: boolean } };
    };
    expect(manifest.manifest.terminal).toEqual(
      expect.objectContaining({ available: true, supportsConPty: false, supportsPty: true })
    );
    connector.stop();
    await manager.shutdown();
  });

  it('keeps an attached long-running command alive and closes it 60 minutes after detachment', async () => {
    vi.useFakeTimers();
    let timestamp = 0;
    const manager = new TerminalManager({
      ptyFactory: fakeFactory({}),
      maxTerminals: 10,
      maxTerminalsPerWorkspace: 5,
      idleTimeoutMs: 60 * 60_000,
      now: () => timestamp,
      terminate: async () => undefined
    });
    const workspace = Array.from({ length: 5 }, () => {
      timestamp += 1;
      return manager.open({ workspaceId: 'workspace-a' });
    });
    timestamp += 1;
    const replacement = manager.open({ workspaceId: 'workspace-a' });
    expect(manager.get(workspace[0]!.id).state).toBe('CLOSED');
    expect(manager.get(replacement.id).state).toBe('RUNNING');

    const attachment = manager.authorizeAttach({ terminalId: replacement.id });
    const longCommand = manager.openCommand({}, 'sleep 86400');
    const commandAttachment = manager.authorizeAttach({ terminalId: longCommand.id });
    manager.startCommand(longCommand.id);
    timestamp += 3 * 60 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.get(replacement.id).state).toBe('RUNNING');
    expect(manager.get(longCommand.id).state).toBe('RUNNING');
    manager.detach(attachment.attachmentId);
    timestamp += 60 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.get(replacement.id).state).toBe('CLOSED');
    expect(manager.get(longCommand.id).state).toBe('RUNNING');
    manager.detach(commandAttachment.attachmentId);
    await manager.shutdown();
    vi.useRealTimers();
  });

  it('never evicts an attached terminal to make room for another browser page', async () => {
    const manager = new TerminalManager({
      ptyFactory: fakeFactory({}),
      maxTerminals: 1,
      maxTerminalsPerWorkspace: 1,
      terminate: async () => undefined
    });
    const terminal = manager.open({ workspaceId: 'workspace-a' });
    const writer = manager.authorizeAttach({ terminalId: terminal.id });
    expect(() => manager.open({ workspaceId: 'workspace-a' })).toThrow('TERMINAL_LIMIT_REACHED');
    expect(manager.get(terminal.id).state).toBe('RUNNING');
    manager.detach(writer.attachmentId);
    const next = manager.open({ workspaceId: 'workspace-a' });
    expect(next.id).not.toBe(terminal.id);
    expect(manager.get(terminal.id).state).toBe('CLOSED');
    await manager.shutdown();
  });
});

function operation(connector: NodeConnector, name: string, data: unknown): Promise<unknown> {
  return (
    connector as unknown as {
      executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    }
  ).executeNodeOperation(name, data);
}
