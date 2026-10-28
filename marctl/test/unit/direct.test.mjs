import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { openDirectTerminal } from '../../src/direct.mjs';
import { DirectFallbackError, DirectUnsafeError } from '../../src/direct-errors.mjs';
import { runTerminalSession } from '../../src/terminal.mjs';

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => 'AA').join(':')}`;
const HOST_CANDIDATE = 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host';
const SRFLX_CANDIDATE = 'candidate:2 1 UDP 1 198.51.100.1 5001 typ srflx';
const SDP = (candidate = HOST_CANDIDATE) =>
  `v=0\r\na=fingerprint:${FINGERPRINT}\r\na=candidate:${candidate.replace(/^candidate:/u, '')}\r\n`;

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
    this.attachOnOpen = attachOnOpen;
    this.handoffFrames = handoffFrames;
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

  sendMessage(value) {
    if (!this.open) return false;
    const message = JSON.parse(value);
    this.sent.push(message);
    if (this.attachOnOpen && message.type === 'OPEN') {
      this.onMessageCallback?.(
        JSON.stringify({
          type: 'ATTACHED',
          terminalId: 'terminal-1',
          afterSequence: 0
        })
      );
      for (const frame of this.handoffFrames)
        this.onMessageCallback?.(JSON.stringify({ terminalId: 'terminal-1', ...frame }));
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
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
      attachOnOpen: this.attachTerminal && label.startsWith('mar-terminal-'),
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
    const pending = openDirectTerminal({
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
    openDirectTerminal({
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
  const transport = await openDirectTerminal({
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
    openDirectTerminal({
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
    openDirectTerminal({
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

test('does not send OPEN when cancelled during the handoff', async () => {
  const fixture = createDirectFixture();
  const controller = new AbortController();
  await assert.rejects(
    openDirectTerminal({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => fixture.peer,
      timeoutMs: 150,
      signal: controller.signal,
      beforeOpen: async () => controller.abort('SIGINT')
    })
  );
  assert.equal(
    fixture.peer.channels.flatMap((channel) => channel.sent).some((frame) => frame.type === 'OPEN'),
    false
  );
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
    let relayCalls = 0;
    const client = {
      ...fixture.client,
      async createTerminal() {
        return 'terminal-1';
      },
      async deleteTerminal() {},
      async createAttachTicket() {
        relayCalls++;
        return 'ticket';
      }
    };
    await assert.rejects(
      runTerminalSession({
        client,
        WebSocketClass: FakeSocket,
        nodeId: 'node-1',
        command: 'echo test',
        connectionTimeoutMs: 500,
        openDirectTerminal: (options) =>
          openDirectTerminal({ ...options, peerConnectionFactory: () => fixture.peer })
      }),
      (error) => error.code === code
    );
    assert.equal(relayCalls, 0);
  });
}

test('allows relay fallback when direct prepare reports a transient transport failure', async () => {
  const fixture = createDirectFixture({ terminalError: 'TERMINAL_DIRECT_UNAVAILABLE' });
  await assert.rejects(
    openDirectTerminal({
      client: fixture.client,
      WebSocketClass: FakeSocket,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      peerConnectionFactory: () => fixture.peer,
      timeoutMs: 500
    }),
    (error) => error instanceof DirectFallbackError && error.code === 'TERMINAL_DIRECT_UNAVAILABLE'
  );
});

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

test('delegates the default native lifecycle to the authenticated client process boundary', async () => {
  const transport = new EventEmitter();
  let received;
  const client = {
    async openDirectTerminal(options) {
      received = options;
      return transport;
    }
  };
  const options = { client, nodeId: 'node-1', terminalId: 'terminal-1' };
  assert.equal(await openDirectTerminal(options), transport);
  assert.equal(received, options);
});

test('waits for permission to send OPEN and disposes the isolated native owner once', async () => {
  const fixture = createDirectFixture();
  let release;
  let cleaned = 0;
  const permission = new Promise((resolve) => {
    release = resolve;
  });
  const opening = openDirectTerminal({
    client: fixture.client,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    peerConnectionFactory: () => fixture.peer,
    beforeOpen: () => permission,
    cleanupNative: () => {
      cleaned += 1;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fixture.control.sent.some((message) => message.type === 'terminal.direct.prepare'));
  assert.equal(
    fixture.peer.channels.flatMap((channel) => channel.sent).some((frame) => frame.type === 'OPEN'),
    false
  );
  release();
  const transport = await opening;
  transport.close();
  transport.close();
  assert.equal(cleaned, 1);
});

test('opens a direct terminal with host-only signaling, fingerprint validation, and heartbeats', async () => {
  const fixture = createDirectFixture();
  const transport = await openDirectTerminal({
    client: fixture.client,
    nodeId: 'node-1',
    terminalId: 'terminal-1',
    timeoutMs: 100,
    heartbeatMs: 5,
    peerConnectionFactory: () => fixture.peer
  });

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
  assert.ok(
    fixture.peer.channels.some((channel) => channel.label === 'mar-terminal-terminal-direct-1')
  );
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
  const pending = openDirectTerminal({
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
  const pending = openDirectTerminal({
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
    fixture.peer.channels.some((channel) => channel.label.startsWith('mar-terminal-')),
    true
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
  const transport = await openDirectTerminal({
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

test('delivers direct output and exit frames emitted in the ATTACHED handoff tick', async () => {
  const fixture = createDirectFixture({
    handoffFrames: [
      { type: 'output', sequence: 1, data: 'direct output\n' },
      { type: 'exit', exitCode: 17 }
    ]
  });
  const stdout = new FakeStdout();
  const client = {
    ...fixture.client,
    async createTerminal() {
      return 'terminal-1';
    },
    async deleteTerminal() {}
  };

  const result = await runTerminalSession({
    client,
    WebSocketClass: FakeSocket,
    nodeId: 'node-1',
    command: 'printf direct',
    stdin: new EventEmitter(),
    stdout,
    signals: new EventEmitter(),
    openDirectTerminal: (options) =>
      openDirectTerminal({
        ...options,
        timeoutMs: 100,
        heartbeatMs: 1000,
        peerConnectionFactory: () => fixture.peer
      })
  });

  assert.equal(result, 17);
  assert.equal(stdout.output, 'direct output\n');
});

test('cleans up a pre-OPEN setup timeout as a relay-safe fallback', async () => {
  const fixture = createDirectFixture();
  fixture.peer.setRemoteDescription = () => {};

  await assert.rejects(
    openDirectTerminal({
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
    openDirectTerminal({
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
    fixture.peer.channels.some((channel) => channel.label.startsWith('mar-terminal-')),
    false
  );
  assert.equal(fixture.peer.closed, true);
  assert.ok(fixture.control.sent.some((message) => message.type === 'direct.cancel'));
});

test('cancels a losing ICE candidate before terminal authorization or OPEN', async () => {
  const fixture = createDirectFixture();
  await assert.rejects(
    openDirectTerminal({
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
    fixture.peer.channels.some((channel) => channel.label.startsWith('mar-terminal-')),
    false
  );
  assert.equal(fixture.peer.closed, true);
});

test('refuses relay fallback once OPEN was sent', async () => {
  const fixture = createDirectFixture({ attach: false });
  let closeCount = 0;
  fixture.peer.close = () => {
    closeCount += 1;
    fixture.peer.closed = true;
  };

  await assert.rejects(
    openDirectTerminal({
      client: fixture.client,
      nodeId: 'node-1',
      terminalId: 'terminal-1',
      timeoutMs: 5,
      peerConnectionFactory: () => fixture.peer
    }),
    (error) => error instanceof DirectUnsafeError
  );
  const terminalChannel = fixture.peer.channels.find((channel) =>
    channel.label.startsWith('mar-terminal-')
  );
  assert.ok(terminalChannel?.sent.some((message) => message.type === 'OPEN'));
  assert.equal(fixture.peer.closed, true);
  assert.equal(closeCount, 1);
});

test('rejects a remote fingerprint that does not match its SDP', async () => {
  const fixture = createDirectFixture({
    answerFingerprint: `sha-256 ${Array.from({ length: 32 }, () => 'BB').join(':')}`
  });

  await assert.rejects(
    openDirectTerminal({
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
