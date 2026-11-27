import { once } from 'node:events';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  createEnvelope,
  encodeFileRelayFrame,
  FILE_RELAY_CHUNK_BYTES,
  FILE_RELAY_MAX_PENDING,
  type NodeEnvelope
} from '../../../../packages/protocol/src/index.js';
import { NodeFileRelay } from '../../../../packages/server-core/src/node-file-relay.js';
import { NodeRequestChannel } from '../../../../packages/server-core/src/node-request-channel.js';
import { NodeFileChannel } from '../../../../mar-node/src/service/node-file-channel.js';
import { registerRealtimeRoutes } from '../../src/route/realtime-routes.js';

it('carries only authorized file chunks on a separate binary socket and settles loss without replay', async () => {
  const app = Fastify();
  const control = { readyState: 1, OPEN: 1, send: vi.fn() } as unknown as WebSocket;
  let currentControl: WebSocket | undefined = control;
  let currentBinding = 'initial-binding';
  const authorize = vi.fn(() => ({ id: 'node-1', disabled: false }));
  const inbound = vi.fn();
  const outbound = vi.fn();
  const request = new NodeRequestChannel(
    () => currentControl,
    undefined,
    outbound,
    (nodeId) => relay.socketFor(nodeId)
  );
  const relay = new NodeFileRelay({
    database: { authenticateNode: authorize as never },
    recordIncoming: inbound,
    currentControl: (_nodeId, binding) => (binding === currentBinding ? currentControl : undefined),
    response: (nodeId, socket, envelope, bytes, declaredLength) =>
      request.resolve(nodeId, envelope, { socket, bytes, declaredLength }),
    disconnected: (socket) => request.rejectFileSocket(socket)
  });
  const received = vi.fn<(envelope: NodeEnvelope) => void>();
  let dropResponse = false;
  const heldRequests: (() => void)[] = [];
  registerRealtimeRoutes({
    app,
    database: {} as never,
    nodeControl: { attachFileRelay: (socket: WebSocket) => relay.attach(socket) } as never,
    publicOrigin: undefined
  });
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const node = new NodeFileChannel({
    config: () => ({
      serverUrl,
      allowedRoots: [],
      nodeId: 'node-1',
      credential: 'fixture-credential'
    }),
    controlConnected: () => currentControl !== undefined,
    reconnect: false,
    reconnectDelay: () => 0,
    request: async (envelope, reply) => {
      received(envelope);
      if (dropResponse) await new Promise<void>((resolve) => heldRequests.push(resolve));
      const { operation, data } = envelope.payload as {
        operation: string;
        data: { bytes?: Uint8Array };
      };
      if (operation === 'browser.upload' || operation === 'browser.download') {
        const result =
          operation === 'browser.upload' ? {} : { offset: 0, bytes: Buffer.of(255, 0) };
        reply('node.response', { result }, envelope.id);
        return;
      }
      if (operation === 'conversation.hosted.file.read') {
        reply(
          'node.response',
          { error: 'HOSTED_CONVERSATION_NOT_AUTHORIZED', message: 'The file is not authorized.' },
          envelope.id
        );
        return;
      }
      reply(
        'node.response',
        {
          result: operation.endsWith('.chunk')
            ? { received: data.bytes?.length }
            : { file: { bytes: Buffer.from([0, 0xff, 8]) } }
        },
        envelope.id
      );
    }
  });
  const user = { userId: 1, sessionHash: 'fixture-session' };
  try {
    for (const malformed of [
      JSON.stringify({ type: 'file.authenticate' }),
      encodeFileRelayFrame({ type: 'file.authenticate', nodeId: 'node-1' }, Uint8Array.of(1)),
      encodeFileRelayFrame({
        type: 'file.authenticate',
        nodeId: 'node-1',
        credential: 'fixture-credential'
      })
    ]) {
      const client = new WebSocket(`${serverUrl.replace('http:', 'ws:')}/api/node/file-connect`);
      await once(client, 'open');
      const closed = once(client, 'close');
      client.send(malformed);
      await closed;
      expect(relay.socketFor('node-1')).toBeUndefined();
    }
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      request.request('node-1', 'workspace.file.content.read', {}, user)
    ).rejects.toMatchObject({ message: 'FILE_RELAY_UNAVAILABLE' });
    node.connect(currentBinding);
    await vi.waitFor(() => expect(relay.socketFor('node-1')).toBeDefined());
    expect(authorize).toHaveBeenCalledExactlyOnceWith('node-1', 'fixture-credential');
    inbound.mockClear();
    const bytes = Buffer.alloc(FILE_RELAY_CHUNK_BYTES, 0xff);
    await expect(
      request.request('node-1', 'workspace.files.upload.chunk', { bytes }, user)
    ).resolves.toEqual({ received: bytes.length });
    expect(outbound).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
    expect(outbound.mock.calls[0]![0]).toBeGreaterThan(bytes.length);
    expect(inbound).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
    expect(received.mock.calls[0]![0].payload).toMatchObject({
      data: { bytes },
      userAuthorization: { userId: 1 }
    });
    await expect(
      request.request('node-1', 'workspace.file.content.read', {}, user)
    ).resolves.toEqual({ file: { bytes: Buffer.from([0, 0xff, 8]) } });
    await expect(
      request.request('node-1', 'conversation.hosted.file.read', {}, user)
    ).rejects.toMatchObject({ code: 'HOSTED_CONVERSATION_NOT_AUTHORIZED', source: 'node' });
    const upload = { payload: { command: { action: 'chunk', bytes: Buffer.of(0, 255) } } };
    await expect(request.request('node-1', 'browser.upload', upload, user)).resolves.toEqual({});
    expect(received.mock.lastCall?.[0].payload).toMatchObject({ data: upload });
    const download = { payload: { command: { action: 'read' } } };
    await expect(request.request('node-1', 'browser.download', download, user)).resolves.toEqual({
      offset: 0,
      bytes: Buffer.of(255, 0)
    });
    expect(relay.socketFor('node-1')?.extensions).toBe('permessage-deflate');
    expect(control.send).not.toHaveBeenCalled();
    const controlRequest = request.request('node-1', 'workspace.files.upload.complete', {}, user);
    const controlEnvelope = JSON.parse(
      vi.mocked(control.send).mock.calls[0]![0] as string
    ) as NodeEnvelope;
    request.resolve(
      'node-1',
      createEnvelope('node.response', { result: {} }, { replyTo: controlEnvelope.id })
    );
    await expect(controlRequest).resolves.toEqual({});
    dropResponse = true;
    const originalSocket = relay.socketFor('node-1');
    const held = Array.from({ length: FILE_RELAY_MAX_PENDING }, () => new AbortController()).map(
      (controller) => ({
        controller,
        rejected: expect(
          request.request(
            'node-1',
            'workspace.file.content.read',
            {},
            user,
            15_000,
            undefined,
            controller.signal
          )
        ).rejects.toMatchObject({ code: 'NODE_REQUEST_CANCELLED' })
      })
    );
    await vi.waitFor(() => expect(heldRequests).toHaveLength(FILE_RELAY_MAX_PENDING));
    for (const { controller } of held) controller.abort();
    await Promise.all(held.map(({ rejected }) => rejected));
    await expect(
      request.request('node-1', 'workspace.file.content.read', {}, user)
    ).rejects.toMatchObject({ code: 'FILE_RELAY_BUSY', source: 'node' });
    expect(relay.socketFor('node-1')).toBe(originalSocket);

    const staleBinding = currentBinding;
    currentBinding = 'replacement-binding';
    currentControl = { ...control } as WebSocket;
    const originalClosed = once(originalSocket!, 'close');
    node.connect(currentBinding);
    await originalClosed;
    await vi.waitFor(() => expect(relay.socketFor('node-1')).toBeDefined());
    const replacementSocket = relay.socketFor('node-1');
    expect(replacementSocket).not.toBe(originalSocket);
    const staleClient = new WebSocket(`${serverUrl.replace('http:', 'ws:')}/api/node/file-connect`);
    try {
      await once(staleClient, 'open');
      const handshake = Promise.race([
        once(staleClient, 'close').then(() => 'closed'),
        once(staleClient, 'message').then(() => 'accepted')
      ]);
      staleClient.send(
        encodeFileRelayFrame({
          type: 'file.authenticate',
          nodeId: 'node-1',
          credential: 'fixture-credential',
          controlBinding: staleBinding
        })
      );
      expect(await handshake).toBe('closed');
      expect(relay.socketFor('node-1')).toBe(replacementSocket);
    } finally {
      staleClient.terminate();
    }
    dropResponse = false;
    await expect(
      request.request('node-1', 'workspace.file.content.read', {}, user)
    ).rejects.toMatchObject({ code: 'FILE_RELAY_BUSY', source: 'node' });
    expect(relay.socketFor('node-1')).toBe(replacementSocket);
    const inboundBeforeRelease = inbound.mock.calls.length;
    for (const release of heldRequests.splice(0)) release();
    // Drain the held operations' reply/finally microtasks. A retired socket's
    // results must not be delivered on the replacement connection.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inbound).toHaveBeenCalledTimes(inboundBeforeRelease);
    await expect(
      request.request('node-1', 'workspace.file.content.read', {}, user)
    ).resolves.toEqual({ file: { bytes: Buffer.of(0, 255, 8) } });
    dropResponse = true;
    const pending = request.request('node-1', 'workspace.file.content.read', {}, user);
    const failed = expect(pending).rejects.toMatchObject({ code: 'FILE_RELAY_UNAVAILABLE' });
    await vi.waitFor(() => expect(heldRequests).toHaveLength(1));
    currentControl = undefined;
    relay.disconnectNode('node-1');
    await failed;
    expect(relay.socketFor('node-1')).toBeUndefined();
  } finally {
    node.disconnect();
    for (const release of heldRequests) release();
    relay.close();
    request.close();
    await app.close();
  }
});
