import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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
import { NodeTerminalChannel } from '../../src/service/node-terminal-channel.js';

class FakePty implements TerminalPty {
  paused = false;
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

describe('Node Admin Terminal', () => {
  it.each(['close', 'shutdown'] as const)(
    'releases a Windows PTY through %s exactly once',
    async (operation) => {
      const pty = new FakePty();
      const kill = vi.spyOn(pty, 'kill').mockImplementation(() => {
        pty.emitExit(0);
        return true;
      });
      const terminate = vi.fn(async () => undefined);
      const manager = new TerminalManager({ platform: 'win32', ptyFactory: () => pty, terminate });
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
    }
  );

  it('falls back to process-tree termination when Windows native PTY kill throws', async () => {
    const pty = new FakePty();
    vi.spyOn(pty, 'kill').mockImplementation(() => {
      throw new Error('Native console cleanup failed.');
    });
    const terminate = vi.fn(async () => undefined);
    const manager = new TerminalManager({ platform: 'win32', ptyFactory: () => pty, terminate });
    const terminal = manager.open();
    await manager.close(terminal.id);
    expect(terminate).toHaveBeenCalledExactlyOnceWith(pty, 'win32');
    await manager.shutdown();
  });

  it('serializes relay writes, pauses producers and delivers exit after output', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'] });
    const holders = [{}, {}] as { value?: FakePty }[];
    let nextPty = 0;
    const manager = new TerminalManager({
      platform: 'linux',
      pipeFactory: (shell, args, options) => {
        const pty = fakeFactory(holders[nextPty++]!)(shell, args, options) as FakePty;
        return {
          pid: pty.pid,
          kill: () => pty.kill(),
          pause: () => pty.pause(),
          resume: () => pty.resume(),
          write: (bytes) => pty.write(bytes.toString()),
          onData: (listener) => {
            pty.onData((data) => listener(Buffer.from(data)));
          },
          onExit: (listener) => {
            pty.onExit((event) => listener(event.exitCode));
          }
        };
      },
      terminate: async () => undefined
    });
    const sent: { type: string; ticket?: string; frame?: { type: string; data?: string } }[] = [];
    const callbacks: (() => void)[] = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string, callback?: () => void) {
        const message = JSON.parse(raw);
        sent.push(message);
        if (message.type === 'frame' && callback !== undefined) callbacks.push(callback);
        else callback?.();
      },
      close: vi.fn()
    };
    const channel = new NodeTerminalChannel({
      config: () => undefined,
      controlConnected: () => true,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      manager
    });
    const access = channel as unknown as { socket: typeof socket; handle(raw: string): void };
    access.socket = socket;
    try {
      const terminals = [
        manager.openCommand({}, 'fixture', true),
        manager.openCommand({}, 'fixture', true)
      ];
      for (const [index, terminal] of terminals.entries()) {
        const attachment = manager.authorizeAttach({ terminalId: terminal.id });
        access.handle(
          JSON.stringify({
            type: 'attach',
            ticket: `ticket-${index}`,
            terminalId: terminal.id,
            attachmentId: attachment.attachmentId,
            latestSequence: attachment.latestSequence
          })
        );
      }
      holders[0]!.value!.emitData('a'.repeat(32_768));
      holders[1]!.value!.emitData('b'.repeat(32_768));
      expect(holders[1]!.value!.paused).toBe(true);
      holders[1]!.value!.emitExit(0);
      expect(sent.filter((item) => item.type === 'frame')).toHaveLength(1);
      expect(holders[1]!.value!.paused).toBe(false);
      expect(manager.get(terminals[0]!.id).state).toBe('RUNNING');
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.filter((item) => item.type === 'frame')).toHaveLength(2);
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(1);
      callbacks.shift()!();
      expect(sent.filter((item) => item.type === 'frame').map((item) => item.frame!.type)).toEqual([
        'output',
        'output',
        'exit'
      ]);
      expect(holders[1]!.value!.paused).toBe(false);

      socket.bufferedAmount = 300 * 1024;
      holders[0]!.value!.emitData('pending');
      expect(holders[0]!.value!.paused).toBe(true);
      access.handle(JSON.stringify({ type: 'detach', ticket: 'ticket-0' }));
      expect(holders[0]!.value!.paused).toBe(false);
      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.some((item) => item.frame?.data === 'pending')).toBe(false);

      const resumed = manager.authorizeAttach({ terminalId: terminals[0]!.id });
      access.handle(
        JSON.stringify({
          type: 'attach',
          ticket: 'ticket-resumed',
          terminalId: terminals[0]!.id,
          attachmentId: resumed.attachmentId,
          latestSequence: resumed.latestSequence
        })
      );
      socket.bufferedAmount = 300 * 1024;
      holders[0]!.value!.emitData('disconnect-pending');
      expect(holders[0]!.value!.paused).toBe(true);
      channel.disconnect();
      expect(holders[0]!.value!.paused).toBe(false);
      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.some((item) => item.frame?.data === 'disconnect-pending')).toBe(false);
    } finally {
      channel.stop();
      await manager.shutdown();
      vi.useRealTimers();
    }
  });
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
    const frames: { type: string; data?: string; exitCode?: number | null }[] = [];
    try {
      manager.onFrame((frame) => frames.push(frame));
      const command = `${JSON.stringify(process.execPath)} -e 'process.stdin.once("data", bytes => { process.stdout.write(bytes); process.stdin.destroy(); })'`;
      const terminal = manager.openCommand({}, command, true);
      const writer = manager.authorizeAttach({ terminalId: terminal.id });
      manager.startCommand(terminal.id);
      const bytes = Buffer.from([0, 255, 42, 10, 128]);
      await manager.acceptFrame(writer.attachmentId, {
        type: 'input',
        terminalId: terminal.id,
        data: bytes.toString('base64')
      });
      await vi.waitFor(() => expect(manager.get(terminal.id).state).toBe('EXITED'), {
        timeout: 5_000
      });
      expect(
        Buffer.concat(
          frames
            .filter((frame) => frame.type === 'output')
            .map((frame) => Buffer.from(frame.data!, 'base64'))
        )
      ).toEqual(bytes);
      expect(frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
    } finally {
      await manager.shutdown();
    }
  });

  it('drains real binary pipe output through delayed relay writes without blocking Node operations', async () => {
    const manager = new TerminalManager({
      platform: 'linux',
      profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
    });
    const frames: { type: string; data?: string; exitCode?: number | null }[] = [];
    const database = new NodeDatabase(':memory:', 'node-terminal-responsive');
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
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string, callback?: () => void) {
        const message = JSON.parse(raw);
        if (message.type !== 'frame') {
          callback?.();
          return;
        }
        frames.push(message.frame);
        if (callback !== undefined) setTimeout(callback, 20);
      },
      close: vi.fn()
    };
    const channel = new NodeTerminalChannel({
      config: () => undefined,
      controlConnected: () => true,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      manager
    });
    const access = channel as unknown as { socket: typeof socket; handle(raw: string): void };
    access.socket = socket;
    try {
      const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(262144, 42))'`;
      const terminal = manager.openCommand({}, command, true);
      const attachment = manager.authorizeAttach({ terminalId: terminal.id });
      access.handle(
        JSON.stringify({
          type: 'attach',
          ticket: 'pipe-ticket',
          terminalId: terminal.id,
          attachmentId: attachment.attachmentId,
          latestSequence: attachment.latestSequence
        })
      );
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      expect(frames.at(-1)?.type).not.toBe('exit');
      // A fixed-operation request remains usable while the bulk relay is pending.
      const capabilities = await operation(connector, 'node.workbench.capabilities', {});
      expect(capabilities).toMatchObject({ manifest: { terminal: { available: true } } });
      const opened = (await operation(connector, 'terminal.open', {})) as {
        terminal: { id: string };
      };
      expect(manager.get(opened.terminal.id).state).toBe('RUNNING');
      await operation(connector, 'terminal.close', { terminalId: opened.terminal.id });
      await vi.waitFor(() => expect(frames.at(-1)?.type).toBe('exit'), { timeout: 5_000 });
      expect(
        Buffer.concat(
          frames
            .filter((frame) => frame.type === 'output')
            .map((frame) => Buffer.from(frame.data!, 'base64'))
        )
      ).toEqual(Buffer.alloc(262144, 42));
      expect(frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      channel.stop();
      await connector.stop();
    }
  });

  it.runIf(process.platform === 'linux')(
    'preserves real PTY tail output when a relay write takes longer than PTY exit cleanup',
    async () => {
      const manager = new TerminalManager({
        profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
      });
      const frames: { type: string; data?: string; exitCode?: number | null }[] = [];
      const socket = {
        readyState: 1,
        OPEN: 1,
        bufferedAmount: 0,
        send(raw: string, callback?: () => void) {
          const message = JSON.parse(raw);
          if (message.type === 'frame') {
            frames.push(message.frame);
            if (callback) setTimeout(callback, 350);
          } else callback?.();
        },
        close: vi.fn()
      };
      const channel = new NodeTerminalChannel({
        config: () => undefined,
        controlConnected: () => true,
        stopped: () => false,
        reconnect: false,
        reconnectDelay: () => 0,
        manager
      });
      const access = channel as unknown as { socket: typeof socket; handle(raw: string): void };
      access.socket = socket;
      try {
        const terminal = manager.openCommand(
          {},
          `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(24576))'`
        );
        const attachment = manager.authorizeAttach({ terminalId: terminal.id });
        access.handle(
          JSON.stringify({
            type: 'attach',
            ticket: 'pty-tail',
            terminalId: terminal.id,
            attachmentId: attachment.attachmentId,
            latestSequence: attachment.latestSequence
          })
        );
        await vi.waitFor(() => expect(frames.at(-1)?.type).toBe('exit'), { timeout: 10_000 });
        const output = frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.data)
          .join('');
        expect(output.length).toBe(24576);
        expect(output.replaceAll('x', '')).toBe('');
        expect(frames.at(-1)).toMatchObject({ type: 'exit', exitCode: 0 });
        expect(socket.close).not.toHaveBeenCalled();
      } finally {
        channel.stop();
        await manager.shutdown();
      }
    }
  );

  it('does not pause a direct binary writer for a congested readonly relay observer', async () => {
    let output!: (bytes: Buffer) => void;
    const pause = vi.fn();
    const manager = new TerminalManager({
      platform: 'linux',
      terminate: async () => undefined,
      pipeFactory: () => ({
        pid: 4242,
        kill: () => true,
        write: vi.fn(),
        pause,
        resume: vi.fn(),
        onData: (listener) => {
          output = listener;
        },
        onExit: () => undefined
      })
    });
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 300 * 1024,
      send: vi.fn(),
      close: vi.fn()
    };
    const channel = new NodeTerminalChannel({
      config: () => undefined,
      controlConnected: () => true,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      manager
    });
    const access = channel as unknown as { socket: typeof socket; handle(raw: string): void };
    access.socket = socket;
    try {
      const terminal = manager.openCommand({}, 'fixture', true);
      const writer = manager.authorizeAttach({ terminalId: terminal.id });
      manager.startCommand(terminal.id);
      const observer = manager.authorizeAttach({ terminalId: terminal.id, readonly: true });
      access.handle(
        JSON.stringify({
          type: 'attach',
          ticket: 'readonly-observer',
          terminalId: terminal.id,
          attachmentId: observer.attachmentId,
          latestSequence: observer.latestSequence
        })
      );
      output(Buffer.from('direct output'));
      expect(pause).not.toHaveBeenCalled();
      await expect(
        manager.acceptFrame(writer.attachmentId, {
          type: 'input',
          terminalId: terminal.id,
          data: Buffer.from('input').toString('base64')
        })
      ).resolves.toBeUndefined();
    } finally {
      channel.stop();
      await manager.shutdown();
    }
  });

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
      const terminal = manager.openCommand({}, 'fixture', true);
      const relay = manager.authorizeAttach({ terminalId: terminal.id });
      manager.startCommand(terminal.id);
      manager.setOutputBackpressure(terminal.id, new Set([relay.attachmentId]));
      expect(pause).toHaveBeenCalledOnce();
      manager.detach(relay.attachmentId);
      expect(resume).toHaveBeenCalledOnce();
      const direct = manager.authorizeAttach({ terminalId: terminal.id });
      manager.setOutputBackpressure(terminal.id, new Set([relay.attachmentId]));
      expect(pause).toHaveBeenCalledOnce();
      await expect(
        manager.acceptFrame(direct.attachmentId, {
          type: 'input',
          terminalId: terminal.id,
          data: Buffer.from('input').toString('base64')
        })
      ).resolves.toBeUndefined();
    } finally {
      await manager.shutdown();
    }
  });

  it.runIf(process.platform === 'linux')(
    'copies through CLI, real Server relay and Node pipe channels while source operations remain responsive',
    async () => {
      const { TerminalRelayService } =
        await import('../../../packages/server-core/src/terminal-relay-service.js');
      const { runScp } = await import(new URL('../../../marctl/src/scp.mjs', import.meta.url).href);
      const { createTranslator } = await import(
        new URL('../../../marctl/src/i18n/index.mjs', import.meta.url).href
      );
      const directory = await mkdtemp(join(tmpdir(), 'mar-node-relay-chain-'));
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      const nodes = new Map<string, { manager: TerminalManager; channel: NodeTerminalChannel }>();
      const user = { userId: 1, sessionHash: 'relay-chain-user' };
      const relay = new TerminalRelayService({
        database: {
          authenticateNode: (id, credential) =>
            nodes.has(id) && credential === 'fixture-credential'
              ? { id, disabled: false }
              : undefined,
          userOwnsNode: (userId, id) => userId === user.userId && nodes.has(id)
        },
        requestNode: async (id, operation, data) => {
          expect(operation).toBe('terminal.attach.authorize');
          return {
            attachment: nodes
              .get(id)!
              .manager.authorizeAttach(data as Parameters<TerminalManager['authorizeAttach']>[0])
          };
        }
      });
      let connector: NodeConnector | undefined;
      let copying: Promise<unknown> | undefined;
      const closes: { side: string; code: number; reason: string }[] = [];
      try {
        await once(server, 'listening');
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('TEST_SERVER_ADDRESS_INVALID');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        server.on('connection', (socket, request) => {
          const url = new URL(request.url!, serverUrl);
          socket.on('close', (code, reason) =>
            closes.push({ side: url.pathname, code, reason: reason.toString() })
          );
          if (url.pathname === '/cli')
            relay.attachBrowser(socket, url.searchParams.get('ticket')!, user);
          else relay.attachNode(socket);
        });
        for (const id of ['source', 'target']) {
          const manager = new TerminalManager({
            cwd: directory,
            platform: 'linux',
            profiles: [{ id: 'default', label: 'sh', shell: '/bin/sh', args: [], isDefault: true }]
          });
          const channel = new NodeTerminalChannel({
            config: () => ({
              serverUrl,
              nodeId: id,
              credential: 'fixture-credential',
              allowedRoots: [directory]
            }),
            manager,
            controlConnected: () => true,
            stopped: () => false,
            reconnect: false,
            reconnectDelay: () => 0
          });
          nodes.set(id, { manager, channel });
          channel.connect();
        }
        await vi.waitFor(() =>
          expect((relay as unknown as { sockets: Map<string, WebSocket> }).sockets.size).toBe(2)
        );
        connector = new NodeConnector({
          reconnect: false,
          database: new NodeDatabase(':memory:', 'relay-chain'),
          terminalManager: nodes.get('source')!.manager,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        });
        const client = {
          getTerminalManifest: async () => ({ binaryTerminal: true }),
          createTerminal: async (input: { nodeId: string; command: string; binary: boolean }) => ({
            terminalId: nodes
              .get(input.nodeId)!
              .manager.openCommand({}, input.command, input.binary).id,
            binary: input.binary
          }),
          createAttachTicket: async (input: { nodeId: string; terminalId: string }) =>
            relay.createTicket({ ...input, user }).ticket,
          openTerminalWebSocket: (_Socket: unknown, input: { ticket: string }) => {
            const socket = new WebSocket(
              `${serverUrl.replace('http:', 'ws:')}/cli?ticket=${encodeURIComponent(input.ticket)}`
            );
            socket.on('close', (code, reason) =>
              closes.push({ side: 'CLI', code, reason: reason.toString() })
            );
            const send = socket.send.bind(socket);
            socket.send = (data, callback) =>
              send(data, (error) => {
                if (typeof callback === 'function') setTimeout(() => callback(error), 5);
              });
            return socket;
          },
          deleteTerminal: async (input: { nodeId: string; terminalId: string }) => {
            await nodes.get(input.nodeId)!.manager.close(input.terminalId);
          }
        };
        const source = join(directory, 'source.bin');
        const target = join(directory, 'target.bin');
        const bytes = Buffer.alloc(512 * 1024);
        for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
        await writeFile(source, bytes);
        copying = runScp({
          source: `source://${source}`,
          destination: `target://${target}`,
          client,
          WebSocketClass: WebSocket,
          resolveNodeId: async (id: string) => id,
          translate: createTranslator()
        });
        copying!.catch(() => undefined);
        await vi.waitFor(() => expect(relay.countSession(user.sessionHash)).toBe(2));
        const capabilities = await operation(connector, 'node.workbench.capabilities', {});
        expect(capabilities).toMatchObject({ manifest: { terminal: { available: true } } });
        try {
          expect(await copying).toBe(0);
        } catch (error) {
          console.error('Relay chain close diagnostics:', closes);
          throw error;
        }
        const { readFile } = await import('node:fs/promises');
        expect(await readFile(target)).toEqual(bytes);
        await vi.waitFor(() => expect(relay.countSession(user.sessionHash)).toBe(0));
      } finally {
        for (const node of nodes.values()) node.channel.stop();
        relay.close();
        for (const socket of server.clients) socket.terminate();
        await copying?.catch(() => undefined);
        await connector?.stop();
        await Promise.all([...nodes.values()].map((node) => node.manager.shutdown()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('rejects only the overflowing relay and preserves another terminal on the shared data socket', async () => {
    const holders = [{}, {}] as { value?: FakePty }[];
    let next = 0;
    const manager = new TerminalManager({
      platform: 'linux',
      terminate: async () => undefined,
      ptyFactory: (...args) => fakeFactory(holders[next++]!)(...args)
    });
    const sent: { ticket?: string; frame?: { type: string; data?: string; code?: string } }[] = [];
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 300 * 1024,
      send(raw: string, callback?: () => void) {
        sent.push(JSON.parse(raw));
        callback?.();
      },
      close: vi.fn()
    };
    const channel = new NodeTerminalChannel({
      config: () => undefined,
      controlConnected: () => true,
      stopped: () => false,
      reconnect: false,
      reconnectDelay: () => 0,
      manager
    });
    const access = channel as unknown as { socket: typeof socket; handle(raw: string): void };
    access.socket = socket;
    try {
      const terminals = [manager.open(), manager.open()];
      const attachments = terminals.map((terminal) =>
        manager.authorizeAttach({ terminalId: terminal.id })
      );
      for (const [index, terminal] of terminals.entries())
        access.handle(
          JSON.stringify({
            type: 'attach',
            ticket: `overflow-${index}`,
            terminalId: terminal.id,
            attachmentId: attachments[index]!.attachmentId,
            latestSequence: attachments[index]!.latestSequence
          })
        );
      holders[1]!.value!.emitData('preserved');
      holders[0]!.value!.emitData('x'.repeat(3 * 1024 * 1024));
      await Promise.resolve();
      expect(socket.close).not.toHaveBeenCalled();
      expect(sent).toContainEqual({
        type: 'frame',
        ticket: 'overflow-0',
        frame: {
          type: 'error',
          terminalId: terminals[0]!.id,
          code: 'TERMINAL_BACKPRESSURE'
        }
      });
      socket.bufferedAmount = 0;
      await vi.waitFor(() =>
        expect(
          sent.some(
            (message) => message.ticket === 'overflow-1' && message.frame?.data === 'preserved'
          )
        ).toBe(true)
      );
      await manager.acceptFrame(attachments[1]!.attachmentId, {
        type: 'input',
        terminalId: terminals[1]!.id,
        data: 'echo'
      });
      expect(holders[1]!.value!.writes).toEqual(['echo']);
      expect(() => manager.authorizeAttach({ terminalId: terminals[0]!.id })).not.toThrow();
    } finally {
      channel.stop();
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
    const terminal = manager.openCommand({}, 'node -e "test"', true);
    const writer = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0 });
    manager.startCommand(terminal.id);
    output(Buffer.from([0, 255, 42]));
    expect(frames[0]).toEqual({
      type: 'output',
      terminalId: terminal.id,
      sequence: 1,
      data: 'AP8q'
    });
    expect(
      manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0, readonly: true }).frames
    ).toEqual([frames[0]]);
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: 'AP8q'
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

  it('starts a command only after an authorized attachment and preserves its exit status', () => {
    const holder: { value?: FakePty; shell?: string; args?: readonly string[] } = {};
    const manager = new TerminalManager({ platform: 'linux', ptyFactory: fakeFactory(holder) });
    const frames: unknown[] = [];
    manager.onFrame((frame) => frames.push(frame));
    expect(() => manager.openCommand({}, '\0bad')).toThrow('TERMINAL_COMMAND_INVALID');
    const terminal = manager.openCommand({}, 'printf "%s" ready; exit 17');
    expect(holder.value).toBeUndefined();
    const attachment = manager.authorizeAttach({ terminalId: terminal.id, afterSequence: 0 });
    expect(attachment.frames).toEqual([]);
    manager.startCommand(terminal.id);
    expect(holder.args).toEqual(['-c', 'printf "%s" ready; exit 17']);
    holder.value!.emitData('ready');
    holder.value!.emitExit(17);
    expect(frames).toEqual([
      { type: 'output', terminalId: terminal.id, sequence: 1, data: 'ready' },
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
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: 'echo 你好\n'
    });
    await manager.acceptFrame(writer.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: 'git che\t'
    });
    await manager.acceptFrame(writer.attachmentId, {
      type: 'resize',
      terminalId: terminal.id,
      rows: 40,
      cols: 100
    });
    expect(pty.writes).toEqual(['echo 你好\n', 'git che\t']);
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
        { type: 'output', terminalId: terminal.id, sequence: 2, data: 'last!' }
      ]
    });
    const replay = manager.authorizeAttach({
      terminalId: terminal.id,
      afterSequence: 0,
      readonly: true
    });
    expect(replay.frames).toEqual([
      { type: 'error', terminalId: terminal.id, code: 'TERMINAL_REPLAY_GAP' },
      { type: 'output', terminalId: terminal.id, sequence: 2, data: 'last!' }
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
        data: 'stale'
      })
    ).rejects.toThrow('TERMINAL_ATTACH_INVALID');
    await manager.acceptFrame(resumed.attachmentId, {
      type: 'input',
      terminalId: terminal.id,
      data: 'current'
    });
    const largeOutputFrames: string[] = [];
    const stopCapturingOutput = manager.onFrame((frame) => {
      if (frame.type === 'output') largeOutputFrames.push(frame.data);
    });
    pty.emitData(`${'a'.repeat(65_535)}😀`);
    stopCapturingOutput();
    expect(largeOutputFrames).toHaveLength(2);
    expect(largeOutputFrames[0]!.endsWith('\ud83d')).toBe(false);
    expect(largeOutputFrames[0]).toHaveLength(65_535);
    expect(largeOutputFrames[1]).toBe('😀');
    await manager.close(terminal.id);
    expect(terminated).toEqual([4242]);
    await manager.shutdown();

    {
      const channelHolder: { value?: FakePty } = {};
      const channelManager = new TerminalManager({
        platform: 'linux',
        ptyFactory: fakeFactory(channelHolder),
        idleTimeoutMs: 60_000,
        terminate: async () => undefined
      });
      const sent: unknown[] = [];
      const socket = {
        readyState: 1,
        OPEN: 1,
        send(raw: string, callback?: () => void) {
          sent.push(JSON.parse(raw));
          callback?.();
        },
        close() {}
      };
      const channel = new NodeTerminalChannel({
        config: () => undefined,
        controlConnected: () => true,
        stopped: () => false,
        reconnect: false,
        reconnectDelay: () => 0,
        manager: channelManager
      });
      (
        channel as unknown as {
          socket: typeof socket;
          handle(raw: string): void;
        }
      ).socket = socket;

      const channelTerminal = channelManager.open();
      const channelPty = channelHolder.value as FakePty;
      const attachment = channelManager.authorizeAttach({ terminalId: channelTerminal.id });
      channelPty.emitData('authorized-before-channel');
      (
        channel as unknown as {
          handle(raw: string): void;
        }
      ).handle(
        JSON.stringify({
          type: 'attach',
          ticket: 'ticket-active',
          terminalId: channelTerminal.id,
          attachmentId: attachment.attachmentId,
          latestSequence: attachment.latestSequence
        })
      );
      expect(sent).toEqual([
        {
          type: 'attached',
          ticket: 'ticket-active',
          terminalId: channelTerminal.id
        },
        {
          type: 'frame',
          ticket: 'ticket-active',
          frame: {
            type: 'output',
            terminalId: channelTerminal.id,
            sequence: 1,
            data: 'authorized-before-channel'
          }
        }
      ]);

      channelPty.emitData('live-after-channel');
      await vi.waitFor(() => expect(sent).toHaveLength(3));
      expect(sent.at(-1)).toEqual({
        type: 'frame',
        ticket: 'ticket-active',
        frame: {
          type: 'output',
          terminalId: channelTerminal.id,
          sequence: 2,
          data: 'live-after-channel'
        }
      });

      channelManager.detach(attachment.attachmentId);
      (
        channel as unknown as {
          handle(raw: string): void;
        }
      ).handle(
        JSON.stringify({
          type: 'attach',
          ticket: 'ticket-stale',
          terminalId: channelTerminal.id,
          attachmentId: attachment.attachmentId,
          latestSequence: attachment.latestSequence
        })
      );
      expect(sent.at(-1)).toEqual({
        type: 'detach',
        ticket: 'ticket-stale',
        reason: 'TERMINAL_ATTACH_FAILED'
      });

      channel.stop();
      await channelManager.shutdown();
    }
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
        expect(terminate).toHaveBeenCalledTimes(
          action === 'exit' ? 0 : action === 'shutdown' ? 2 : 1
        );
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
