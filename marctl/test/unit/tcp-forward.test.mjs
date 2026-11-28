import assert from 'node:assert/strict';
import dns from 'node:dns';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { NodeStream } from '@myagentroam/protocol/node-stream';
import { writeTcpForwardNotice } from '@myagentroam/protocol/tcp-forward';
import { runTcpForward } from '../../src/tcp-forward.mjs';
import { bridgeForwardSocket } from '../../src/tcp-forward-socket.mjs';

test('losing the forwarding lease during local bind does not report readiness', async (t) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const lookup = Promise.withResolvers();
  const lookupHost = 'tcp-forward.test';
  const originalLookup = dns.lookup;
  t.mock.method(dns, 'lookup', (host, ...args) => {
    if (host === lookupHost) lookup.resolve(args.at(-1));
    else return originalLookup(host, ...args);
  });
  const control = new NodeStream(
    1,
    async () => {},
    () => {}
  );
  const path = { openStream: async () => control, close: t.mock.fn() };
  const onReady = t.mock.fn();
  const result = runTcpForward({
    client: { openForwardRelay: async () => path },
    nodeId: 'node-test',
    forward: {
      direction: 'local',
      listenHost: lookupHost,
      listenPort: port,
      targetHost: 'localhost',
      targetPort: 8080
    },
    onReady,
    translate: (key) => key,
    signal: AbortSignal.timeout(2_000)
  });
  result.catch(() => {});
  control.receive({ type: 'DATA', streamId: 1, bytes: writeTcpForwardNotice(0) });
  const finishLookup = await lookup.promise;
  control.receive({ type: 'RESET', streamId: 1, code: 'RESOURCE_DENIED' });
  finishLookup(null, '127.0.0.1', 4);

  await assert.rejects(result, { code: 'RESOURCE_DENIED' });
  assert.equal(onReady.mock.callCount(), 0);
  assert.ok(path.close.mock.callCount() > 0);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve) => server.close(resolve));
});

test('reset closes a TCP connection while its write is blocked', async () => {
  const writing = Promise.withResolvers();
  const socket = new Duplex({
    read() {},
    write() {
      writing.resolve();
    }
  });
  const stream = new NodeStream(
    1,
    async () => {},
    () => {}
  );
  const lifetime = new AbortController();
  const bridged = bridgeForwardSocket(socket, stream, lifetime.signal);
  try {
    stream.receive({ type: 'DATA', streamId: 1, bytes: Uint8Array.of(1) });
    await writing.promise;
    stream.receive({ type: 'RESET', streamId: 1, code: 'TCP_FORWARD_CONNECTION_LOST' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.destroyed, true);
  } finally {
    lifetime.abort();
    await bridged;
  }
});

test('normal FIN waits for an outstanding TCP write to finish', async () => {
  const writing = Promise.withResolvers();
  const socket = new Duplex({
    read() {},
    write(_data, _encoding, callback) {
      writing.resolve(callback);
    }
  });
  const stream = new NodeStream(
    1,
    async () => {},
    () => {}
  );
  const lifetime = new AbortController();
  const bridged = bridgeForwardSocket(socket, stream, lifetime.signal);
  try {
    stream.receive({ type: 'DATA', streamId: 1, bytes: Uint8Array.of(1) });
    const completeWrite = await writing.promise;
    socket.push(null);
    stream.receive({ type: 'FIN', streamId: 1 });
    await stream.finished;
    assert.equal(socket.destroyed, false);
    completeWrite();
    await bridged;
    assert.equal(socket.writableFinished, true);
  } finally {
    lifetime.abort();
    await bridged;
  }
});
