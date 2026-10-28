import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  DirectFallbackError,
  DirectRejectedError,
  DirectUnsafeError
} from '../../src/direct-errors.mjs';
import { runTerminalSession } from '../../src/terminal.mjs';
import { splitInput } from '../../src/terminal-interaction.mjs';
import { TerminalRelaySender } from '../../src/terminal-relay-sender.mjs';

test('waits for the actual socket write before resolving or sending the next frame', async () => {
  const sent = [];
  const callbacks = [];
  const sender = new TerminalRelaySender({
    readyState: 1,
    send(value, callback) {
      sent.push(value);
      callbacks.push(callback);
    }
  });
  let completed = false;
  const first = sender.send('first').then(() => {
    completed = true;
  });
  const second = sender.send('second');
  first.catch(() => {});
  second.catch(() => {});
  try {
    await Promise.resolve();
    assert.equal(completed, false);
    assert.deepEqual(sent, ['first']);
    callbacks.shift()();
    await first;
    assert.deepEqual(sent, ['first']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ['first', 'second']);
    callbacks.shift()();
    await second;
  } finally {
    sender.close();
  }
});

test('yields between serial relay writes without a throughput timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const pending = [];
  const sender = new TerminalRelaySender(
    {
      readyState: 1,
      send(value, callback) {
        sent.push(value);
        callback();
      }
    },
    { onPendingChange: (keys) => pending.push([...keys]) }
  );
  const frame = '中'.repeat(16 * 1024);
  const first = sender.send(frame, 'first');
  const second = sender.send(frame, 'second');
  assert.equal(sent.length, 1);
  assert.deepEqual(pending.at(-1), ['second']);
  await Promise.all([first, second]);
  assert.equal(sent.length, 2);
  assert.deepEqual(pending.at(-1), []);
  let sentAtOtherOperation;
  setImmediate(() => {
    sentAtOtherOperation = sent.length;
  });
  for (let index = 0; index < 100; index++) await sender.send(frame);
  assert.ok(sentAtOtherOperation >= 2 && sentAtOtherOperation < 102);
  assert.equal(sent.length, 102);
  sender.close();
});

test('bounds congested relay queues and cancels pending sends on close or detach', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 300 * 1024,
    send(value, callback) {
      sent.push(value);
      callback();
    }
  };
  const sender = new TerminalRelaySender(socket);
  const cancelled = assert.rejects(sender.send('stale', 'stale'), /TERMINAL_ATTACH_INVALID/);
  sender.cancel('stale');
  await cancelled;
  const queued = sender.send('x'.repeat(2 * 1024 * 1024), 'active');
  await assert.rejects(sender.send('overflow'), /TERMINAL_RELAY_BUFFER_EXCEEDED/);
  assert.equal(sent.length, 0);
  const closed = assert.rejects(queued, /TERMINAL_CONNECTION_LOST/);
  sender.close();
  await closed;
  socket.bufferedAmount = 0;
  t.mock.timers.tick(60_000);
  assert.equal(sent.length, 0);
  await assert.rejects(sender.send('late'), /TERMINAL_CONNECTION_LOST/);
});

test('resumes a congested relay and propagates socket send failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 240 * 1024,
    send(value, callback) {
      sent.push(value);
      callback();
    }
  };
  const sender = new TerminalRelaySender(socket);
  const first = sender.send('a'.repeat(64 * 1024));
  const second = sender.send('b'.repeat(64 * 1024));
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 0);
  socket.bufferedAmount = 0;
  t.mock.timers.tick(20);
  await first;
  assert.equal(sent.length, 1);
  await second;
  assert.equal(sent.length, 2);
  socket.send = () => {
    throw new Error('socket send failed');
  };
  const failure = assert.rejects(sender.send('failure'), /socket send failed/);
  const tail = assert.rejects(sender.send('tail'), /socket send failed/);
  await Promise.all([failure, tail]);
  sender.close();
});

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }

  send(value, callback) {
    this.sent.push(JSON.parse(value));
    callback?.();
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.rawModes = [];
    this.paused = false;
  }

  setRawMode(value) {
    this.rawModes.push(value);
  }

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.rows = 24;
    this.columns = 80;
    this.output = '';
  }

  write(value) {
    this.output += value;
  }
}

test('handles rejected asynchronous resize and close writes without leaking a terminal', async () => {
  const transport = new EventEmitter();
  const sent = [];
  let deleted = 0;
  transport.send = (raw) => {
    sent.push(JSON.parse(raw).type);
    return Promise.reject(new Error('TERMINAL_CONNECTION_LOST'));
  };
  transport.close = () => {};
  await assert.rejects(
    runTerminalSession({
      client: {
        async createTerminal() {
          return 'terminal-1';
        },
        async deleteTerminal() {
          deleted += 1;
        }
      },
      nodeId: 'node-1',
      command: 'cat',
      stdin: new FakeStdin(),
      stdout: new FakeStdout(),
      signal: new AbortController().signal,
      openDirectTerminal: async () => transport
    }),
    /terminal resize|终端尺寸/
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['resize', 'close']);
  assert.equal(deleted, 1);
});

test('bounds UTF-8 input frames and preserves terminal lifecycle', async () => {
  const sockets = [];
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const signals = new AbortController();
  const deleted = [];
  const client = {
    async createTerminal(input) {
      assert.deepEqual(input, { nodeId: 'node-1', rows: 24, cols: 80 });
      return 'terminal-1';
    },
    async createAttachTicket(input) {
      assert.deepEqual(input, { nodeId: 'node-1', terminalId: 'terminal-1' });
      return 'ticket-1';
    },
    openTerminalWebSocket(SocketClass) {
      const socket = new SocketClass();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    stdin,
    stdout,
    signal: signals.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit('data', 'hello');
  stdin.emit('data', '\u0003');
  await new Promise((resolve) => setImmediate(resolve));
  stdout.emit('resize');
  sockets[0].emit(
    'message',
    JSON.stringify({ type: 'output', terminalId: 'terminal-1', sequence: 1, data: 'world' }),
    false
  );
  sockets[0].emit(
    'message',
    JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 7 }),
    false
  );

  assert.equal(await session, 7);
  assert.equal(stdout.output, 'world');
  assert.deepEqual(sockets[0].sent, [
    { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
    { type: 'input', terminalId: 'terminal-1', data: 'hello' },
    { type: 'input', terminalId: 'terminal-1', data: '\u0003' },
    { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
    { type: 'close', terminalId: 'terminal-1' }
  ]);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.equal(stdin.paused, true);
});

test('relay readiness wins without allowing direct to attach a second writer', async () => {
  const socket = new FakeSocket();
  const stdout = new FakeStdout();
  const directAttached = false;
  let created = 0;
  const client = {
    async createTerminal() {
      created += 1;
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket(_Socket, options) {
      assert.equal(options.deferred, true);
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    if (frame.type === 'activate')
      queueMicrotask(() => {
        socket.emit(
          'message',
          JSON.stringify({
            type: 'attach',
            terminalId: 'terminal-1',
            afterSequence: 0
          })
        );
        socket.emit(
          'message',
          JSON.stringify({
            type: 'exit',
            terminalId: 'terminal-1',
            exitCode: 4
          })
        );
      });
  };
  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'test',
    stdin: new FakeStdin(),
    stdout,
    signal: new AbortController().signal,
    raceConnections: true,
    openDirectTerminal: async ({ signal, onPrepared, onIceConnected }) => {
      await onPrepared();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            assert.equal(typeof onIceConnected, 'function');
            reject(new DirectFallbackError('DIRECT_RACE_CANCELLED'));
          },
          { once: true }
        );
      });
    }
  });
  assert.equal(result, 4);
  assert.equal(created, 1);
  assert.equal(directAttached, false);
  assert.equal(socket.sent.filter((frame) => frame.type === 'activate').length, 1);
});

test('waits for relay stdin writes while resize and interruption remain responsive', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const callbacks = [];
  const socket = new FakeSocket();
  const originalSend = socket.send.bind(socket);
  socket.send = (value, callback) => {
    originalSend(value);
    if (JSON.parse(value).type === 'input') callbacks.push(callback);
    else callback?.();
  };
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  const signals = new AbortController();
  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'cat',
    stdin,
    stdout,
    signal: signals.signal
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit('data', 'x'.repeat(128 * 1024));
    stdout.emit('resize');
    assert.equal(callbacks.length, 1);
    assert.equal(stdin.paused, true);
    assert.equal(socket.sent.at(-1).type, 'resize');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.filter((frame) => frame.type === 'input').length, 1);
    callbacks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.filter((frame) => frame.type === 'input').length, 2);
    callbacks.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(stdin.paused, false);
    stdin.emit('data', 'pending');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdin.paused, true);
    signals.abort('SIGINT');
    assert.equal(await session, 130);
    callbacks.shift()();
    await Promise.resolve();
    assert.equal(stdin.paused, true);
  } finally {
    signals.abort('SIGTERM');
    await session;
  }
});

test('direct transport wins and closes the unactivated relay', async () => {
  const socket = new FakeSocket();
  const stdout = new FakeStdout();
  let created = 0;
  let directAttach = 0;
  const client = {
    async createTerminal() {
      created += 1;
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket(_Socket, options) {
      assert.equal(options.deferred, true);
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  const transport = new EventEmitter();
  transport.readyState = 1;
  transport.send = () => {};
  transport.close = () => {};
  transport.activate = () => {
    queueMicrotask(() =>
      transport.emit(
        'message',
        JSON.stringify({
          type: 'exit',
          terminalId: 'terminal-1',
          exitCode: 6
        })
      )
    );
  };
  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'test',
    stdin: new FakeStdin(),
    stdout,
    signal: new AbortController().signal,
    raceConnections: true,
    openDirectTerminal: async ({ onPrepared, onIceConnected }) => {
      await onPrepared();
      onIceConnected();
      directAttach += 1;
      return transport;
    }
  });
  assert.equal(result, 6);
  assert.equal(created, 1);
  assert.equal(directAttach, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    socket.readyState === FakeSocket.CLOSED || socket.readyState === 0,
    'unused relay must be closed or never opened'
  );
  assert.equal(
    socket.sent.some((frame) => frame.type === 'activate'),
    false
  );
});

for (const blocked of ['direct', 'relay']) {
  test(`waits for ${blocked} preparation before either connection starts`, async () => {
    const socket = new FakeSocket();
    const manifest = { deferredRelay: true };
    let manifestQueries = 0;
    let relayStarted = false;
    let iceStarted = false;
    let release;
    let preparing;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const preparation = new Promise((resolve) => {
      preparing = resolve;
    });
    const client = {
      async createTerminal() {
        return 'terminal-1';
      },
      async getTerminalManifest() {
        manifestQueries += 1;
        return manifest;
      },
      async createAttachTicket() {
        if (blocked === 'relay') {
          preparing();
          await gate;
        }
        return 'ticket-1';
      },
      openTerminalWebSocket() {
        relayStarted = true;
        queueMicrotask(() => {
          socket.readyState = FakeSocket.OPEN;
          socket.emit('open');
          socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
        });
        return socket;
      },
      async deleteTerminal() {}
    };
    const pending = runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      raceConnections: true,
      attached: async () => 0,
      openDirectTerminal: async (options) => {
        assert.equal(options.manifest, manifest);
        if (blocked === 'direct') {
          preparing();
          await gate;
        }
        await options.onPrepared();
        iceStarted = true;
        options.onIceConnected();
        return { close() {} };
      }
    });
    await preparation;
    assert.equal(relayStarted, false);
    assert.equal(iceStarted, false);
    release();
    assert.equal(await pending, 0);
    assert.equal(manifestQueries, 1);
    assert.equal(iceStarted, true);
    assert.equal(
      socket.sent.some((frame) => frame.type === 'activate'),
      false
    );
  });
}

test('releases direct preparation when relay ticket creation fails', async () => {
  let iceStarted = false;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      throw new Error('TICKET_UNAVAILABLE');
    },
    openTerminalWebSocket() {
      assert.fail('A failed ticket must not open a relay.');
    },
    async deleteTerminal() {}
  };
  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    raceConnections: true,
    attached: async () => 0,
    openDirectTerminal: async ({ onPrepared, onIceConnected }) => {
      await onPrepared();
      iceStarted = true;
      onIceConnected();
      return { close() {} };
    }
  });
  assert.equal(result, 0);
  assert.equal(iceStarted, true);
});

test('a ready direct transport without an ICE victory cannot open a writer', async () => {
  const socket = new FakeSocket();
  let directOpened = false;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    if (frame.type === 'activate')
      queueMicrotask(() =>
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
        )
      );
  };
  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    raceConnections: true,
    attached: async ({ transport }) => {
      assert.equal(transport.constructor.name, 'BufferedRelayTransport');
      return 0;
    },
    openDirectTerminal: async ({ onPrepared, onTransportReady }) => {
      await onPrepared();
      if (onTransportReady) await onTransportReady();
      directOpened = true;
      return { close() {} };
    }
  });
  assert.equal(result, 0);
  assert.equal(directOpened, false);
  assert.equal(socket.sent.filter((frame) => frame.type === 'activate').length, 1);
});

for (const unsafe of [false, true]) {
  test(`an ICE winner ${unsafe ? 'does not fall back after OPEN' : 'can fall back before OPEN'}`, async () => {
    const relay = new FakeSocket();
    let created = 0;
    let tickets = 0;
    const client = {
      async createTerminal() {
        created += 1;
        return 'terminal-1';
      },
      async getTerminalManifest() {
        return { deferredRelay: true };
      },
      async createAttachTicket() {
        tickets += 1;
        return `ticket-${tickets}`;
      },
      openTerminalWebSocket(_Socket, options) {
        if (options.deferred) return new FakeSocket();
        queueMicrotask(() => {
          relay.readyState = FakeSocket.OPEN;
          relay.emit('open');
          relay.emit(
            'message',
            JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
          );
        });
        return relay;
      },
      async deleteTerminal() {}
    };
    const pending = runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      raceConnections: true,
      attached: async () => 0,
      openDirectTerminal: async ({ onPrepared, onIceConnected }) => {
        await onPrepared();
        onIceConnected();
        if (unsafe) throw new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED');
        throw new DirectFallbackError('DIRECT_SETUP_TIMEOUT');
      }
    });
    if (unsafe) await assert.rejects(pending);
    else assert.equal(await pending, 0);
    assert.equal(created, 1);
    assert.equal(tickets, unsafe ? 1 : 2);
  });
}

test('shares one binary manifest across validation and both race paths', async () => {
  let queries = 0;
  const manifest = { deferredRelay: true, binaryTerminal: true };
  const client = {
    async getTerminalManifest() {
      queries += 1;
      return manifest;
    },
    async createTerminal() {
      return { terminalId: 'terminal-1', binary: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      return new FakeSocket();
    },
    async deleteTerminal() {}
  };
  assert.equal(
    await runTerminalSession({
      client,
      nodeId: 'node-1',
      command: 'binary-worker',
      binary: true,
      raceConnections: true,
      attached: async () => 0,
      openDirectTerminal: async (options) => {
        assert.equal(options.manifest, manifest);
        await options.onPrepared();
        options.onIceConnected();
        return { close() {} };
      }
    }),
    0
  );
  assert.equal(queries, 1);
});

test('settles both failed preparation paths without leaving a pending barrier', async () => {
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      throw new Error('TICKET_UNAVAILABLE');
    },
    async deleteTerminal() {}
  };
  await assert.rejects(
    runTerminalSession({
      client,
      nodeId: 'node-1',
      raceConnections: true,
      openDirectTerminal: async () => {
        throw new DirectFallbackError('DIRECT_UNSUPPORTED');
      }
    })
  );
});

test('releases the relay when direct preparation fails before the barrier', async () => {
  const socket = new FakeSocket();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    if (frame.type === 'activate')
      queueMicrotask(() =>
        socket.emit(
          'message',
          JSON.stringify({
            type: 'attach',
            terminalId: 'terminal-1',
            afterSequence: 0
          })
        )
      );
  };
  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    raceConnections: true,
    attached: async ({ transport }) => {
      assert.equal(transport.constructor.name, 'BufferedRelayTransport');
      return 0;
    },
    openDirectTerminal: async () => {
      throw new DirectFallbackError('DIRECT_UNSUPPORTED');
    }
  });
  assert.equal(result, 0);
  assert.equal(socket.sent.filter((frame) => frame.type === 'activate').length, 1);
});

test('older server without deferred relay capability keeps sequential fallback', async () => {
  const socket = new FakeSocket();
  let directAttempts = 0;
  let terminalCount = 0;
  const client = {
    async createTerminal() {
      terminalCount += 1;
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { nodeGeneration: 'generation-1' };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket(_Socket, options) {
      assert.equal(options.deferred, undefined);
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({
            type: 'attach',
            terminalId: 'terminal-1',
            afterSequence: 0
          })
        );
        socket.emit(
          'message',
          JSON.stringify({
            type: 'exit',
            terminalId: 'terminal-1',
            exitCode: 3
          })
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };
  const exit = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'test',
    stdin: new FakeStdin(),
    stdout: new FakeStdout(),
    signal: new AbortController().signal,
    raceConnections: true,
    openDirectTerminal: async () => {
      directAttempts += 1;
      throw new DirectFallbackError('DIRECT_UNAVAILABLE');
    }
  });
  assert.equal(exit, 3);
  assert.equal(terminalCount, 1);
  assert.equal(directAttempts, 1);
});

test('delivers relay output and exit frames emitted in the ATTACHED handoff tick', async () => {
  const socket = new FakeSocket();
  const stdout = new FakeStdout();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
        socket.emit(
          'message',
          JSON.stringify({
            type: 'output',
            terminalId: 'terminal-1',
            sequence: 1,
            data: 'relay output\n'
          }),
          false
        );
        socket.emit(
          'message',
          JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 19 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };

  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'printf relay',
    stdin: new EventEmitter(),
    stdout,
    signal: new AbortController().signal
  });

  assert.equal(result, 19);
  assert.equal(stdout.output, 'relay output\n');
});

test('runs one-shot commands without raw stdin and has no post-attach idle timeout', async () => {
  const stdin = new EventEmitter();
  stdin.paused = false;
  stdin.resume = () => {};
  stdin.pause = () => {
    stdin.paused = true;
  };
  const stdout = new FakeStdout();
  const signals = new AbortController();
  const socket = new FakeSocket();
  const deleted = [];
  const client = {
    async createTerminal(input) {
      assert.deepEqual(input, {
        nodeId: 'node-1',
        rows: 24,
        cols: 80,
        command: 'echo hello && date'
      });
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'echo hello && date',
    stdin,
    stdout,
    signal: signals.signal,
    connectionTimeoutMs: 10
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
  let settled = false;
  session.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  stdin.emit('data', 'input');
  socket.emit(
    'message',
    JSON.stringify({ type: 'output', terminalId: 'terminal-1', sequence: 1, data: 'done\n' }),
    false
  );
  socket.emit(
    'message',
    JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 23 }),
    false
  );

  assert.equal(await session, 23);
  assert.equal(stdout.output, 'done\n');
  assert.deepEqual(socket.sent, [
    { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
    { type: 'input', terminalId: 'terminal-1', data: 'input' },
    { type: 'close', terminalId: 'terminal-1' }
  ]);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  assert.equal(stdin.paused, true);
});

test('maps a null remote exit code to a non-success CLI status', async () => {
  const socket = new FakeSocket();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'unknown-status-command',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: new AbortController().signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    'message',
    JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: null }),
    false
  );
  assert.equal(await session, 1);
});

test('preserves a received exit code when terminal cleanup fails', async () => {
  const socket = new FakeSocket();
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal() {
      throw new Error('cleanup unavailable');
    }
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'exit 23',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: new AbortController().signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    'message',
    JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 23 }),
    false
  );
  assert.equal(await session, 23);
});

for (const [signalName, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
]) {
  test(`closes the remote command once on ${signalName}`, async () => {
    const stdin = new EventEmitter();
    stdin.resume = () => {};
    stdin.pause = () => {};
    const stdout = new FakeStdout();
    const signals = new AbortController();
    const socket = new FakeSocket();
    const deleted = [];
    const client = {
      async createTerminal() {
        return 'terminal-1';
      },
      async createAttachTicket() {
        return 'ticket-1';
      },
      openTerminalWebSocket() {
        queueMicrotask(() => {
          socket.readyState = FakeSocket.OPEN;
          socket.emit('open');
          socket.emit(
            'message',
            JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
            false
          );
        });
        return socket;
      },
      async deleteTerminal(input) {
        deleted.push(input);
      }
    };

    const session = runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      command: 'long-running-command',
      stdin,
      stdout,
      signal: signals.signal
    });
    await new Promise((resolve) => setImmediate(resolve));
    signals.abort(signalName);
    assert.equal(await session, exitCode);
    assert.deepEqual(socket.sent, [
      { type: 'resize', terminalId: 'terminal-1', rows: 24, cols: 80 },
      { type: 'close', terminalId: 'terminal-1' }
    ]);
    assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
  });
}

test('does not recreate or re-run a command after relay disconnect', async () => {
  const socket = new FakeSocket();
  const signals = new AbortController();
  const deleted = [];
  let createCalls = 0;
  const client = {
    async createTerminal() {
      createCalls += 1;
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'long-running-command',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: signals.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('close');
  await assert.rejects(session, /terminal connection was lost/);
  assert.equal(createCalls, 1);
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
});

test('falls back to relay without recreating the command terminal', async () => {
  const socket = new FakeSocket();
  const signals = new AbortController();
  let createCalls = 0;
  let attachCalls = 0;
  const client = {
    async createTerminal() {
      createCalls += 1;
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { nodeGeneration: 'generation-1', terminalDirect: { apiVersion: 1, transport: true } };
    },
    async createAttachTicket(input) {
      attachCalls += 1;
      assert.deepEqual(input, { nodeId: 'node-1', terminalId: 'terminal-1' });
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = FakeSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 }),
          false
        );
      });
      return socket;
    },
    async deleteTerminal() {}
  };

  const session = runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'uname -a',
    stdin: new EventEmitter(),
    stdout: new FakeStdout(),
    signal: signals.signal,
    openDirectTerminal: async () => {
      throw new DirectFallbackError('DIRECT_SETUP_TIMEOUT');
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit(
    'message',
    JSON.stringify({ type: 'exit', terminalId: 'terminal-1', exitCode: 0 }),
    false
  );

  assert.equal(await session, 0);
  assert.equal(createCalls, 1);
  assert.equal(attachCalls, 1);
});

test('a direct authorization rejection prevents a competing relay from attaching', async () => {
  let attached = 0;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      const socket = new FakeSocket();
      socket.send = (value) => {
        if (JSON.parse(value).type === 'activate') attached += 1;
      };
      return socket;
    },
    async deleteTerminal() {}
  };
  await assert.rejects(
    runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      command: 'true',
      stdout: new FakeStdout(),
      raceConnections: true,
      openDirectTerminal: async () => {
        throw new DirectRejectedError('TERMINAL_NOT_AUTHORIZED');
      }
    }),
    (error) => error.code === 'TERMINAL_NOT_AUTHORIZED'
  );
  assert.equal(attached, 0);
});

test('a known direct rejection blocks relay activation while direct cleanup is pending', async () => {
  const socket = new FakeSocket();
  let releaseCleanup;
  let reported;
  const failure = new Promise((resolve) => {
    reported = resolve;
  });
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit('open');
        socket.emit('message', JSON.stringify({ type: 'ready', terminalId: 'terminal-1' }));
      });
      return socket;
    }
  };
  const pending = runTerminalSession({
    client,
    nodeId: 'node-1',
    raceConnections: true,
    openDirectTerminal: async ({ onPrepared, onRejected }) => {
      await onPrepared();
      const error = new DirectRejectedError('DIRECT_TRANSFER_NOT_AUTHORIZED');
      onRejected(error);
      reported();
      await new Promise((resolve) => {
        releaseCleanup = resolve;
      });
      throw error;
    }
  });
  await failure;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    socket.sent.some((frame) => frame.type === 'activate'),
    false
  );
  releaseCleanup();
  await assert.rejects(pending, (error) => error.code === 'DIRECT_TRANSFER_NOT_AUTHORIZED');
});

test('cancellation during binary manifest lookup prevents terminal creation', async () => {
  const controller = new AbortController();
  let createCalls = 0;
  let deleteCalls = 0;
  const client = {
    async getTerminalManifest() {
      controller.abort('SIGINT');
      return { binaryTerminal: true };
    },
    async createTerminal() {
      createCalls += 1;
      return { terminalId: 'terminal-1', binary: true };
    },
    async deleteTerminal() {
      deleteCalls += 1;
    }
  };

  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    command: 'copy-worker',
    binary: true,
    signal: controller.signal
  });

  assert.equal(result, 130);
  assert.equal(createCalls, 0);
  assert.equal(deleteCalls, 0);
});

test('cancellation during direct setup never falls back to relay', async () => {
  const controller = new AbortController();
  let tickets = 0;
  let receivedSignal;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async createAttachTicket() {
      tickets++;
      throw new Error('must not fallback');
    }
  };
  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    openDirectTerminal: async ({ signal }) => {
      receivedSignal = signal;
      controller.abort('SIGTERM');
      throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
    }
  });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(result, 143);
  assert.equal(tickets, 0);
});

test('cancellation during relay ticket creation prevents a late attachment', async () => {
  const controller = new AbortController();
  let openCount = 0;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async createAttachTicket() {
      controller.abort('SIGINT');
      return 'ticket';
    },
    openTerminalWebSocket() {
      openCount++;
      throw new Error('must not attach');
    }
  };
  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    openDirectTerminal: async () => {
      throw new DirectFallbackError('DIRECT_UNAVAILABLE');
    }
  });
  assert.equal(result, 130);
  assert.equal(openCount, 0);
});

test('cancellation at relay attachment prevents a late attached callback', async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  let attached = false;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async createAttachTicket() {
      return 'ticket';
    },
    openTerminalWebSocket() {
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit('open');
        socket.emit(
          'message',
          JSON.stringify({ type: 'attach', terminalId: 'terminal-1', afterSequence: 0 })
        );
        controller.abort('SIGINT');
      });
      return socket;
    }
  };
  const result = await runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    openDirectTerminal: async () => {
      throw new DirectFallbackError('DIRECT_UNAVAILABLE');
    },
    attached: async () => {
      attached = true;
      return 0;
    }
  });
  assert.equal(result, 130);
  assert.equal(attached, false);
});

test('cancellation releases a connection race without granting a late writer', async () => {
  const controller = new AbortController();
  let releaseTicket;
  let started;
  const preparing = new Promise((resolve) => {
    started = resolve;
  });
  let opened = 0;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      started();
      return new Promise((resolve) => {
        releaseTicket = resolve;
      });
    },
    openTerminalWebSocket() {
      opened++;
      throw new Error('late relay');
    }
  };
  const pending = runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    raceConnections: true,
    openDirectTerminal: async ({ onPrepared, signal }) => {
      await onPrepared();
      if (signal.aborted) throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
      opened++;
      throw new Error('late direct');
    }
  });
  await preparing;
  controller.abort('SIGINT');
  assert.equal(await pending, 130);
  releaseTicket('ticket');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 0);
});

test('cancellation after a direct candidate wins reaches the pending direct handoff', async () => {
  const controller = new AbortController();
  let selected;
  const won = new Promise((resolve) => {
    selected = resolve;
  });
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {},
    async getTerminalManifest() {
      return { deferredRelay: true };
    },
    async createAttachTicket() {
      return 'ticket';
    },
    openTerminalWebSocket() {
      return new FakeSocket();
    }
  };
  const pending = runTerminalSession({
    client,
    nodeId: 'node-1',
    signal: controller.signal,
    raceConnections: true,
    openDirectTerminal: async ({ onPrepared, onIceConnected, signal }) => {
      await onPrepared();
      onIceConnected();
      selected();
      await new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DirectFallbackError('DIRECT_RACE_CANCELLED')),
          { once: true }
        )
      );
    }
  });
  await won;
  controller.abort('SIGTERM');
  assert.equal(await pending, 143);
});

test('does not fall back after direct OPEN has made execution unsafe', async () => {
  let attachCalls = 0;
  let deleted = 0;
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      attachCalls += 1;
      return 'ticket-1';
    },
    async deleteTerminal() {
      deleted += 1;
    }
  };

  await assert.rejects(
    runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      command: 'uname -a',
      stdin: new EventEmitter(),
      stdout: new FakeStdout(),
      signal: new AbortController().signal,
      openDirectTerminal: async () => {
        throw new DirectUnsafeError('DIRECT_OPEN_CANCEL_UNCONFIRMED');
      }
    }),
    /Direct terminal setup could not be safely canceled/
  );
  assert.equal(attachCalls, 0);
  assert.equal(deleted, 1);
});

test('bounds connection setup without applying a runtime timeout', async () => {
  const socket = new FakeSocket();
  const deleted = [];
  const client = {
    async createTerminal() {
      return 'terminal-1';
    },
    async createAttachTicket() {
      return 'ticket-1';
    },
    openTerminalWebSocket() {
      return socket;
    },
    async deleteTerminal(input) {
      deleted.push(input);
    }
  };

  await assert.rejects(
    runTerminalSession({
      client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      stdin: new EventEmitter(),
      stdout: new FakeStdout(),
      signal: new AbortController().signal,
      connectionTimeoutMs: 5
    }),
    /could not be opened/
  );
  assert.deepEqual(deleted, [{ nodeId: 'node-1', terminalId: 'terminal-1' }]);
});

test('splits input at the 65536-byte protocol limit without splitting code points', () => {
  const chunks = splitInput('界'.repeat(40_000));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 65536));
  assert.equal(chunks.join(''), '界'.repeat(40_000));
});
