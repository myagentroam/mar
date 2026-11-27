import { decodeTerminalMessage, encodeTerminalMessage } from '@myagentroam/protocol/byte-frame';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { openDirectConnection } from '../../src/direct.mjs';
import { LiveControl } from '../../src/direct-control.mjs';
import { DirectFallbackError } from '../../src/direct-errors.mjs';
import { NodeStreamMux } from '@myagentroam/protocol/node-stream-mux';
import { decodeNodeStreamFrame } from '@myagentroam/protocol/node-stream-wire';
import { NODE_STREAM_CHANNEL_LABEL } from '@myagentroam/protocol/node-stream-path';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import { NodeConnection } from '@myagentroam/protocol/node-connection';

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => 'AA').join(':')}`;
const HOST_CANDIDATE = 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host';
const SRFLX_CANDIDATE = 'candidate:2 1 UDP 1 198.51.100.1 5001 typ srflx';
const SDP = (candidate = HOST_CANDIDATE) =>
  `v=0\r\na=fingerprint:${FINGERPRINT}\r\na=candidate:${candidate.replace(/^candidate:/u, '')}\r\n`;

test('closing an in-flight control upgrade handles its asynchronous socket error', async () => {
  const socket = new EventEmitter();
  socket.readyState = 0;
  socket.close = () =>
    queueMicrotask(() => {
      socket.emit('error', new Error('Upgrade cancelled'));
      socket.emit('close');
    });
  const control = new LiveControl(socket, 100);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  control.close();
  await closed;
});

class FakeSocket extends EventEmitter {
  constructor(onSend) {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.onSend = onSend;
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(value) {
    const message = JSON.parse(value);
    this.sent.push(message);
    this.onSend(message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeChannel {
  constructor(label, { attachOnOpen = false, handoffFrames = [] } = {}) {
    this.label = label;
    this.sent = [];
    this.open = true;
    this.closed = false;
    this.onOpenCallback = undefined;
    this.onMessageCallback = undefined;
    this.onClosedCallback = undefined;
    this.inputs = [];
    if (label === NODE_STREAM_CHANNEL_LABEL && attachOnOpen) {
      this.mux = new NodeStreamMux({
        maxStreams: 10,
        send: async (bytes) => this.onMessageCallback?.(bytes),
        accept: async () => async (stream) => {
          for (const frame of [{ type: 'attach', afterSequence: 0 }, ...handoffFrames]) {
            await stream.write(
              writeTerminalRecord(encodeTerminalMessage({ terminalId: 'terminal-1', ...frame }))
            );
          }
          if (handoffFrames.some(({ type }) => type === 'exit')) await stream.endWrite();
          for await (const bytes of readTerminalRecords(stream))
            this.inputs.push(decodeTerminalMessage(bytes));
        }
      });
    }
  }

  onOpen(callback) {
    this.onOpenCallback = callback;
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onClosed(callback) {
    this.onClosedCallback = callback;
  }

  onError() {}

  isOpen() {
    return this.open;
  }

  sendMessageBinary(value) {
    if (!this.open) return false;
    const message = decodeNodeStreamFrame(value);
    this.sent.push(message);
    this.mux?.receive(value);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.mux?.disconnect();
    this.onClosedCallback?.();
  }
}

class FakePeer {
  constructor() {
    this.attachTerminal = true;
    this.handoffFrames = [];
    this.channels = [];
    this.closed = false;
    this.localDescriptionCallback = undefined;
    this.localCandidateCallback = undefined;
    this.stateCallback = undefined;
    this.remoteDescriptionValue = undefined;
    this.remoteCandidates = [];
  }

  createDataChannel(label) {
    const channel = new FakeChannel(label, {
      attachOnOpen: this.attachTerminal && label === NODE_STREAM_CHANNEL_LABEL,
      handoffFrames: this.handoffFrames
    });
    this.channels.push(channel);
    return channel;
  }

  onLocalDescription(callback) {
    this.localDescriptionCallback = callback;
  }

  onLocalCandidate(callback) {
    this.localCandidateCallback = callback;
  }

  onStateChange(callback) {
    this.stateCallback = callback;
  }

  onIceStateChange(callback) {
    this.iceStateCallback = callback;
  }

  setLocalDescription(type) {
    assert.equal(type, 'Offer');
    this.localDescriptionCallback?.(
      SDP(`${HOST_CANDIDATE}\r\na=candidate:${SRFLX_CANDIDATE.replace(/^candidate:/u, '')}`),
      'Offer'
    );
    this.localCandidateCallback?.(HOST_CANDIDATE, '0');
    this.localCandidateCallback?.(SRFLX_CANDIDATE, '0');
    this.localCandidateCallback?.('', '0');
  }

  setRemoteDescription(sdp, type) {
    assert.equal(type, 'Answer');
    this.remoteDescriptionValue = sdp;
    this.iceStateCallback?.('connected');
    this.stateCallback?.('connected');
  }

  addRemoteCandidate(candidate, mid) {
    this.remoteCandidates.push({ candidate, mid });
  }

  close() {
    this.closed = true;
  }
}

function createDirectFixture({
  attach = true,
  answerFingerprint = FINGERPRINT,
  handoffFrames = [],
  terminalError,
  transportError,
  unrelatedTransportError = false,
  peer = new FakePeer()
} = {}) {
  peer.attachTerminal = attach;
  peer.handoffFrames = handoffFrames;
  const control = new FakeSocket((message) => {
    if (message.type === 'resume') {
      queueMicrotask(() =>
        control.emit(
          'message',
          JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'workbench-1' }),
          false
        )
      );
    } else if (message.type === 'direct.prepare') {
      if (unrelatedTransportError) {
        queueMicrotask(() =>
          control.emit(
            'message',
            JSON.stringify({
              type: 'direct.error',
              requestId: 'another-request',
              code: 'DIRECT_TRANSFER_NOT_AUTHORIZED'
            }),
            false
          )
        );
      }
      if (transportError) {
        queueMicrotask(() =>
          control.emit(
            'message',
            JSON.stringify({
              type: 'direct.error',
              requestId: message.requestId,
              code: transportError
            }),
            false
          )
        );
        return;
      }
      queueMicrotask(() =>
        control.emit(
          'message',
          JSON.stringify({
            type: 'direct.prepared',
            requestId: message.requestId,
            directSessionId: 'transport-1',
            purpose: 'TRANSPORT'
          }),
          false
        )
      );
    } else if (message.type === 'direct.signal' && message.signal.kind === 'OFFER') {
      queueMicrotask(() => {
        control.emit(
          'message',
          JSON.stringify({
            type: 'direct.signal',
            directSessionId: 'transport-1',
            signal: {
              kind: 'ANSWER',
              sdp: SDP(HOST_CANDIDATE),
              fingerprint: answerFingerprint
            }
          }),
          false
        );
      });
    } else if (message.type === 'direct.connected') {
      queueMicrotask(() =>
        control.emit(
          'message',
          JSON.stringify({ type: 'direct.opened', directSessionId: 'transport-1', offset: 0 }),
          false
        )
      );
    } else if (message.type === 'terminal.direct.prepare') {
      queueMicrotask(() => {
        if (terminalError) {
          control.emit(
            'message',
            JSON.stringify({
              type: 'terminal.direct.error',
              requestId: message.requestId,
              code: terminalError,
              message: 'Terminal request failed.'
            }),
            false
          );
          return;
        }
        control.emit(
          'message',
          JSON.stringify({
            type: 'terminal.direct.prepared',
            requestId: message.requestId,
            directSessionId: 'terminal-direct-1',
            grant: 'g'.repeat(64),
            openExpiresAt: Date.now() + 1000,
            expiresAt: Date.now() + 2000
          }),
          false
        );
      });
    } else if (message.type === 'terminal.direct.cancel') {
      queueMicrotask(() =>
        control.emit(
          'message',
          JSON.stringify({
            type: 'terminal.direct.closed',
            directSessionId: message.directSessionId,
            code: 'TERMINAL_DIRECT_CANCELLED'
          }),
          false
        )
      );
    } else if (message.type === 'direct.cancel') {
      queueMicrotask(() =>
        control.emit(
          'message',
          JSON.stringify({
            type: 'direct.closed',
            directSessionId: message.directSessionId,
            code: 'DIRECT_TRANSFER_CANCELLED'
          }),
          false
        )
      );
    }
  });
  return {
    peer,
    control,
    client: {
      async getTerminalManifest() {
        return {
          nodeGeneration: 'generation-1',
          terminalDirect: { apiVersion: 1, transport: true }
        };
      },
      openWorkbenchWebSocket() {
        return control;
      }
    }
  };
}

for (const [timing, code, errorName] of [
  ['before-prepared', 'DIRECT_SESSION_LIMIT_REACHED', 'DirectRejectedError'],
  ['after-prepared', 'DIRECT_NODE_GENERATION_MISMATCH', 'DirectRejectedError'],
  ['peer-created', 'DIRECT_TRANSFER_SESSION_CONFLICT', 'DirectRejectedError'],
  ['peer-created-then-fails', 'DIRECT_TRANSFER_SESSION_CONFLICT', 'DirectRejectedError'],
  ['before-prepared', 'DIRECT_TRANSFER_UNAVAILABLE', 'DirectFallbackError'],
  ['unrelated', undefined, undefined]
]) {
  test(`classifies early Node transport failure: ${timing} ${code ?? 'other session'}`, async () => {
    const fixture = createDirectFixture();
    const emit = (message) => fixture.control.emit('message', JSON.stringify(message), false);
    const fail = () => emit({ type: 'direct.error', directSessionId: 'transport-1', code });
    const send = fixture.control.onSend;
    fixture.control.onSend = (message) => {
      if (message.type !== 'direct.prepare') return send(message);
      queueMicrotask(() => {
        emit({
          type: 'direct.error',
          directSessionId: 'other-session',
          code: 'DIRECT_SESSION_LIMIT_REACHED'
        });
        if (timing === 'before-prepared') fail();
        emit({
          type: 'direct.prepared',
          requestId: message.requestId,
          directSessionId: 'transport-1',
          purpose: 'TRANSPORT'
        });
        if (timing === 'after-prepared') fail();
      });
    };
    let prepared = false;
    let rejected;
    const pending = openDirectConnection({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => {
        if (timing.startsWith('peer-created')) fail();
        if (timing === 'peer-created-then-fails') throw new Error('Native initialization failed.');
        return fixture.peer;
      },
      onRejected: (error) => {
        rejected = error;
      },
      onPrepared: () => {
        prepared = true;
      },
      timeoutMs: 150
    });
    if (timing === 'unrelated') {
      (await pending).close();
      return;
    }
    await assert.rejects(pending, (error) => error.code === code && error.name === errorName);
    assert.equal(rejected?.code, errorName === 'DirectRejectedError' ? code : undefined);
    assert.equal(
      prepared,
      false,
      'a known rejection must not release the relay preparation barrier'
    );
    assert.equal(fixture.peer.channels.length, 0);
    assert.equal(fixture.control.closed, true);
  });
}

test('matches transport prepare rejection by request ID without waiting for timeout', async () => {
  const fixture = createDirectFixture({ transportError: 'DIRECT_TRANSFER_NOT_AUTHORIZED' });
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => fixture.peer,
      timeoutMs: 150
    }),
    (error) =>
      error.code === 'DIRECT_TRANSFER_NOT_AUTHORIZED' && error.name === 'DirectRejectedError'
  );
});

test('a transport error for a different request does not reject the connection', async () => {
  const fixture = createDirectFixture({ unrelatedTransportError: true });
  const transport = await openDirectConnection({
    client: fixture.client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    peerConnectionFactory: () => fixture.peer,
    timeoutMs: 500
  });
  transport.close();
});

test('a transient transport prepare error remains eligible for fallback', async () => {
  const fixture = createDirectFixture({ transportError: 'DIRECT_TRANSFER_UNAVAILABLE' });
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => fixture.peer,
      timeoutMs: 500
    }),
    (error) => error instanceof DirectFallbackError && error.code === 'DIRECT_TRANSFER_UNAVAILABLE'
  );
});

test('preserves a transport rejection received during the preparation barrier', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => fixture.peer,
      timeoutMs: 150,
      onPrepared: async () => {
        fixture.control.emit(
          'message',
          JSON.stringify({
            type: 'direct.error',
            directSessionId: 'transport-1',
            code: 'DIRECT_TRANSFER_NOT_AUTHORIZED'
          }),
          false
        );
        await new Promise(() => {});
      }
    }),
    (error) =>
      error.code === 'DIRECT_TRANSFER_NOT_AUTHORIZED' && error.name === 'DirectRejectedError'
  );
  assert.equal(fixture.peer.channels.length, 0);
});

for (const code of [
  'TERMINAL_NOT_AUTHORIZED',
  'TERMINAL_DIRECT_LEASE_EXPIRED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_CLOSED',
  'TERMINAL_ATTACH_CONFLICT'
]) {
  test(`rejects ${code} from direct prepare without relay fallback`, async () => {
    const fixture = createDirectFixture({ terminalError: code });
    const relay = {
      closed: false,
      close() {},
      openStream: async () => assert.fail('An authorization rejection must not fall back')
    };
    const lifetime = new AbortController();
    const path = await openFixturePath(fixture, lifetime.signal);
    const connection = new NodeConnection({ direct: async () => path, relay: async () => relay });
    try {
      await connection.ready({ signal: lifetime.signal });
      await assert.rejects(connection.openStream(request(), { signal: lifetime.signal }), { code });
    } finally {
      connection.close();
    }
  });
}

function request(options = {}) {
  return { terminalId: 'terminal-1', onFrame() {}, onEnd() {}, ...options };
}

async function openFixturePath(fixture, signal, options = {}) {
  const connection = await openDirectConnection({
    client: fixture.client,
    nodeId: 'node-1',
    timeoutMs: 100,
    peerConnectionFactory: () => fixture.peer,
    ...options
  });
  try {
    return await connection.openStreams(signal);
  } catch (error) {
    connection.close();
    throw error;
  }
}

test('cleans up the native peer exactly once when the common path closes', async () => {
  let cleaned = 0;
  const path = await openFixturePath(createDirectFixture(), new AbortController().signal, {
    cleanupNative() {
      cleaned++;
    }
  });
  path.close();
  path.close();
  assert.equal(cleaned, 1);
});

test('opens a direct terminal with host-only signaling, fingerprint validation, and heartbeats', async () => {
  const fixture = createDirectFixture();
  const signal = new AbortController().signal;
  const transport = await openFixturePath(fixture, signal, { heartbeatMs: 5 });
  const stream = await transport.openStream(request(), signal);
  assert.ok(stream);

  const offer = fixture.control.sent.find(
    (message) => message.type === 'direct.signal' && message.signal.kind === 'OFFER'
  );
  assert.ok(offer);
  assert.match(offer.signal.sdp, /typ host/u);
  assert.doesNotMatch(offer.signal.sdp, /typ srflx/u);
  assert.equal(offer.signal.fingerprint, FINGERPRINT);
  assert.equal(
    fixture.control.sent.filter(
      (message) => message.type === 'direct.signal' && message.signal.kind === 'CANDIDATE'
    ).length,
    1
  );
  assert.ok(fixture.peer.remoteCandidates.length === 0);
  assert.ok(fixture.peer.channels.some((channel) => channel.label === NODE_STREAM_CHANNEL_LABEL));
  assert.equal(
    fixture.peer.channels.find((channel) => channel.label === 'mar-direct-transport')?.closed,
    true
  );

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(fixture.control.sent.some((message) => message.type === 'direct.heartbeat'));
  assert.ok(fixture.control.sent.some((message) => message.type === 'terminal.direct.heartbeat'));

  transport.close();
  assert.equal(fixture.peer.closed, true);
  assert.equal(fixture.control.closed, true);
});

test('reuses the manifest and waits at the preparation barrier before creating an offer', async () => {
  const fixture = createDirectFixture();
  const manifest = await fixture.client.getTerminalManifest();
  fixture.client.getTerminalManifest = async () => {
    assert.fail('The prepared manifest must not be queried again.');
  };
  let release;
  let prepared;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const preparation = new Promise((resolve) => {
    prepared = resolve;
  });
  const pending = openDirectConnection({
    client: fixture.client,
    manifest,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    timeoutMs: 100,
    peerConnectionFactory: () => fixture.peer,
    onPrepared: () => {
      prepared();
      return barrier;
    }
  });
  await preparation;
  assert.equal(fixture.peer.channels.length, 0);
  assert.equal(
    fixture.control.sent.some((message) => message.type === 'direct.signal'),
    false
  );
  release();
  const transport = await pending;
  transport.close();
});

test('announces ICE connectivity before DTLS and server confirmation without opening a writer', async () => {
  const fixture = createDirectFixture();
  let iceConnected;
  let dtlsConnected;
  const ice = new Promise((resolve) => {
    iceConnected = resolve;
  });
  const dtls = new Promise((resolve) => {
    dtlsConnected = resolve;
  });
  const originalSend = fixture.control.onSend;
  fixture.control.onSend = (message) => {
    if (message.type === 'direct.connected') dtlsConnected();
    else originalSend(message);
  };
  fixture.peer.setRemoteDescription = () => {
    fixture.peer.iceStateCallback?.('connected');
    fixture.peer.iceStateCallback?.('completed');
  };
  let selected = 0;
  const pending = openDirectConnection({
    client: fixture.client,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    timeoutMs: 100,
    peerConnectionFactory: () => fixture.peer,
    onIceConnected: () => {
      selected += 1;
      iceConnected();
    }
  });
  await ice;
  assert.equal(selected, 1);
  assert.equal(
    fixture.control.sent.some((message) => message.type === 'direct.connected'),
    false
  );
  assert.equal(
    fixture.control.sent.some((message) => message.type === 'terminal.direct.prepare'),
    false
  );
  fixture.peer.stateCallback('connected');
  await dtls;
  assert.equal(
    fixture.control.sent.some((message) => message.type === 'terminal.direct.prepare'),
    false
  );
  fixture.control.emit(
    'message',
    JSON.stringify({
      type: 'direct.opened',
      directSessionId: 'transport-1',
      offset: 0
    }),
    false
  );
  const transport = await pending;
  assert.equal(
    fixture.peer.channels.some((channel) => channel.label === NODE_STREAM_CHANNEL_LABEL),
    false
  );
  transport.close();
});

test('captures an offer generated while the bootstrap channel is created', async () => {
  class EagerOfferPeer extends FakePeer {
    localDescriptionValue = null;

    createDataChannel(label) {
      const channel = super.createDataChannel(label);
      if (label === 'mar-direct-transport') {
        this.localDescriptionValue = { type: 'Offer', sdp: SDP() };
        this.localDescriptionCallback?.(this.localDescriptionValue.sdp, 'Offer');
      }
      return channel;
    }

    localDescription() {
      return this.localDescriptionValue;
    }

    setLocalDescription() {
      throw new Error('The native peer has already generated an offer');
    }
  }

  const fixture = createDirectFixture({ peer: new EagerOfferPeer() });
  const transport = await openDirectConnection({
    client: fixture.client,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    timeoutMs: 100,
    peerConnectionFactory: () => fixture.peer
  });
  assert.equal(
    fixture.control.sent.filter(
      (message) => message.type === 'direct.signal' && message.signal.kind === 'OFFER'
    ).length,
    1
  );
  transport.close();
});

test('delivers early Direct output and exit in order after stream activation', async () => {
  const fixture = createDirectFixture({
    handoffFrames: [
      { type: 'output', sequence: 1, data: Buffer.from('direct output\n') },
      { type: 'exit', exitCode: 17 }
    ]
  });
  const signal = new AbortController().signal;
  const path = await openFixturePath(fixture, signal);
  const frames = [];
  const ended = Promise.withResolvers();
  try {
    const stream = await path.openStream(
      request({
        onFrame(raw) {
          frames.push(decodeTerminalMessage(raw));
        },
        onEnd: ended.resolve
      }),
      signal
    );
    assert.ok(stream);
    stream.activate();
    await ended.promise;
    assert.deepEqual(
      frames.map(({ type }) => type),
      ['attach', 'output', 'exit']
    );
    assert.equal(Buffer.from(frames[1].data).toString(), 'direct output\n');
    assert.equal(frames[2].exitCode, 17);
  } finally {
    path.close();
  }
});

test('cleans up a pre-OPEN setup timeout as a relay-safe fallback', async () => {
  const fixture = createDirectFixture();
  fixture.peer.setRemoteDescription = () => {};

  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      timeoutMs: 5,
      peerConnectionFactory: () => fixture.peer
    }),
    (error) => error instanceof DirectFallbackError
  );
  assert.equal(fixture.peer.closed, true);
  const sentBeforeLateCandidate = fixture.control.sent.length;
  fixture.peer.localCandidateCallback?.(HOST_CANDIDATE, '0');
  assert.equal(fixture.control.sent.length, sentBeforeLateCandidate);
  assert.ok(fixture.control.sent.some((message) => message.type === 'direct.cancel'));
  assert.equal(fixture.control.closed, true);
});

test('a losing direct transport never opens a terminal writer', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      timeoutMs: 100,
      peerConnectionFactory: () => fixture.peer,
      onTransportReady: () => {
        throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
      }
    }),
    (error) => error instanceof DirectFallbackError && error.code === 'DIRECT_RACE_CANCELLED'
  );
  assert.equal(
    fixture.peer.channels.some((channel) => channel.label === NODE_STREAM_CHANNEL_LABEL),
    false
  );
  assert.equal(fixture.peer.closed, true);
  assert.ok(fixture.control.sent.some((message) => message.type === 'direct.cancel'));
});

test('does not publish a reusable Direct connection closed during the readiness handoff', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      timeoutMs: 100,
      peerConnectionFactory: () => fixture.peer,
      onTransportReady: () => {
        fixture.control.emit(
          'message',
          JSON.stringify({
            type: 'direct.closed',
            directSessionId: 'transport-1',
            code: 'DIRECT_TRANSFER_CANCELLED'
          }),
          false
        );
      }
    }),
    { code: 'DIRECT_TRANSFER_CANCELLED' }
  );
  assert.equal(fixture.peer.closed, true);
});

test('a disconnected control socket interrupts the readiness handoff', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      timeoutMs: 100,
      peerConnectionFactory: () => fixture.peer,
      onTransportReady: async () => {
        fixture.control.close();
        await new Promise(() => {});
      }
    }),
    { code: 'DIRECT_CONTROL_CLOSED' }
  );
  assert.equal(fixture.peer.closed, true);
});

test('an already-cancelled attach on a warm Direct connection does not request a grant', async () => {
  const fixture = createDirectFixture();
  const path = await openFixturePath(fixture, new AbortController().signal);
  try {
    await assert.rejects(path.openStream(request(), AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(
      fixture.control.sent.some(({ type }) => type === 'terminal.direct.prepare'),
      false
    );
    assert.equal(path.closed, false);
  } finally {
    path.close();
  }
});

test('cancels a late grant without opening a channel or closing the warm connection', async () => {
  const fixture = createDirectFixture();
  const { control, peer } = fixture;
  const path = await openFixturePath(fixture, new AbortController().signal);
  const originalSend = control.onSend;
  let delayedRequest;
  control.onSend = (message) => {
    if (message.type === 'terminal.direct.prepare' && message.terminalId === 'cancelled') {
      delayedRequest = message;
      return;
    }
    originalSend(message);
  };
  try {
    const abort = new AbortController();
    const cancelled = path.openStream(request({ terminalId: 'cancelled' }), abort.signal);
    assert.ok(delayedRequest);
    abort.abort();
    await assert.rejects(cancelled, { code: 'DIRECT_RACE_CANCELLED' });

    control.emit(
      'message',
      JSON.stringify({
        type: 'terminal.direct.prepared',
        requestId: delayedRequest.requestId,
        directSessionId: 'cancelled-grant',
        grant: 'g'.repeat(64)
      }),
      false
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      control.sent.filter(({ type }) => type === 'terminal.direct.cancel'),
      [{ type: 'terminal.direct.cancel', directSessionId: 'cancelled-grant' }]
    );
    assert.equal(
      peer.channels.some(({ sent }) => sent.some(({ type }) => type === 'OPEN')),
      false
    );
    assert.equal(path.closed, false);
    const next = await path.openStream(request(), new AbortController().signal);
    next.close();
  } finally {
    path.close();
  }
});

test('accepts native queued writes without retries and delivers Direct input in order', async () => {
  const peer = new FakePeer();
  const createChannel = peer.createDataChannel.bind(peer);
  peer.createDataChannel = (label) => {
    const channel = createChannel(label);
    if (label !== NODE_STREAM_CHANNEL_LABEL) return channel;
    const send = channel.sendMessageBinary.bind(channel);
    channel.sendMessageBinary = (bytes) => {
      send(bytes);
      return false;
    };
    return channel;
  };
  const signal = new AbortController().signal;
  const path = await openFixturePath(createDirectFixture({ peer }), signal);
  try {
    const stream = await path.openStream(request(), signal);
    const channel = peer.channels.at(-1);
    for (const byte of [1, 2]) {
      await stream.write(
        encodeTerminalMessage({
          type: 'input',
          terminalId: 'terminal-1',
          data: Uint8Array.of(byte)
        })
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(channel.sent.filter(({ type }) => type === 'OPEN').length, 1);
    assert.deepEqual(
      channel.inputs.map(({ data }) => data[0]),
      [1, 2]
    );
  } finally {
    path.close();
  }
});

test('cancels a losing ICE candidate before terminal authorization or OPEN', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      timeoutMs: 100,
      peerConnectionFactory: () => fixture.peer,
      onIceConnected: () => {
        throw new DirectFallbackError('DIRECT_RACE_CANCELLED');
      }
    }),
    (error) => error instanceof DirectFallbackError && error.code === 'DIRECT_RACE_CANCELLED'
  );
  assert.equal(
    fixture.control.sent.some((message) => message.type === 'terminal.direct.prepare'),
    false
  );
  assert.equal(
    fixture.peer.channels.some((channel) => channel.label === NODE_STREAM_CHANNEL_LABEL),
    false
  );
  assert.equal(fixture.peer.closed, true);
});

test('cancels the Direct substream without replay when an OPEN goes unacknowledged', async () => {
  const fixture = createDirectFixture({ attach: false });
  const path = await openFixturePath(fixture, new AbortController().signal);
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15);
    try {
      await assert.rejects(path.openStream(request(), abort.signal), {
        code: 'NODE_STREAM_CANCELLED'
      });
    } finally {
      clearTimeout(timer);
    }
    const channel = fixture.peer.channels.at(-1);
    assert.deepEqual(
      channel.sent.map(({ type }) => type),
      ['OPEN', 'RESET']
    );
    assert.equal(path.closed, false);
  } finally {
    path.close();
  }
});

test('rejects a remote fingerprint that does not match its SDP', async () => {
  const fixture = createDirectFixture({
    answerFingerprint: `sha-256 ${Array.from({ length: 32 }, () => 'BB').join(':')}`
  });

  await assert.rejects(
    openDirectConnection({
      client: fixture.client,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      timeoutMs: 50,
      peerConnectionFactory: () => fixture.peer
    }),
    (error) => error instanceof DirectFallbackError && error.code === 'DIRECT_FINGERPRINT_INVALID'
  );
  assert.equal(fixture.peer.closed, true);
});
