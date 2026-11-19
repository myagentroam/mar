import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../packages/protocol/src/index.js';
import { RelaySocket } from '../../packages/server-core/test/unit/support/relay-socket.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';

const nodeId = 'node-1';
const nodeGeneration = 'generation-1';
const workspaceId = 'workspace-1';
const user = { userId: 1, sessionHash: 'browser-session' };

const cases = [
  { scenario: 'accepts the frame', closure: undefined },
  { scenario: 'exceeds the send buffer', closure: [4009, 'WORKBENCH_BACKPRESSURE'] },
  { scenario: 'throws during send', closure: [1011, 'WORKBENCH_SEND_FAILED'] }
] as const;

type NodeSocket = Parameters<ReturnType<typeof createTestNodeControl>['attach']>[0];

function fixture() {
  const authorize = vi.fn(() => true);
  const control = createTestNodeControl(
    {
      registerNode: () => undefined,
      authenticateNode: (id, credential) =>
        id === nodeId && credential === 'test-credential'
          ? {
              id,
              ownerUserId: user.userId,
              displayName: null,
              registeredAddress: '127.0.0.1',
              metadata: '{}',
              disabled: false,
              lastHeartbeatAt: null
            }
          : undefined,
      updateNodeHeartbeat: () => {},
      listNodes: () => [],
      listNodesForUser: () => [],
      revokeNode: () => false,
      deleteNode: () => false,
      audit: () => {}
    },
    authorize
  );
  const node = new RelaySocket();
  control.attach(node as unknown as NodeSocket);
  const receiveNode = (type: string, payload: object, replyTo?: string) => {
    const envelope = createEnvelope(type, payload, replyTo === undefined ? {} : { replyTo });
    node.receive(envelope);
    return envelope.id;
  };
  const attachPage = () => {
    const socket = new RelaySocket();
    control.attachBrowserWorkbench(socket as unknown as NodeSocket, user);
    socket.receive({ type: 'resume' });
    const ready = socket.sent[0];
    expect(ready).toMatchObject({
      type: 'workbench.ready',
      workbenchConnectionId: expect.any(String)
    });
    return { socket, connectionId: ready!.workbenchConnectionId as string };
  };
  const connect = async () => {
    const id = receiveNode('authenticate', { nodeId, credential: 'test-credential' });
    await control.drainProjections();
    expect(node.sent).toContainEqual(
      expect.objectContaining({ type: 'authenticated', replyTo: id })
    );
    const capabilities = receiveNode('capabilities', {
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.14.6',
      nodeVersion: 'v24',
      codex: { available: false },
      claudeCode: { available: false },
      workspaceDirectTransfer: {
        apiVersion: 3,
        transport: true,
        upload: false,
        download: false,
        range: false,
        gitCommitBlob: false,
        maxChunkBytes: 64 * 1024
      },
      terminalDirect: { apiVersion: 1, transport: true }
    });
    await control.drainProjections();
    expect(node.sent).toContainEqual(
      expect.objectContaining({ type: 'ack', replyTo: capabilities })
    );
    return { page: attachPage(), other: attachPage() };
  };
  return { control, node, receiveNode, authorize, connect };
}

function setSendOutcome(socket: RelaySocket, closure: (typeof cases)[number]['closure']) {
  const send = vi.spyOn(socket, 'send');
  if (closure?.[0] === 4009) socket.bufferedAmount = 16 * 1024 * 1024 + 1;
  if (closure?.[0] === 1011)
    send.mockImplementationOnce(() => {
      throw new Error('Fake Socket send failed');
    });
  return send;
}

function expectIndependentPage(socket: RelaySocket, before: number) {
  expect(socket.close).not.toHaveBeenCalled();
  expect(socket.sent.slice(before)).toEqual([]);
  socket.receive({ type: 'ping', id: 'other-page' });
  expect(socket.sent.slice(before)).toEqual([{ type: 'pong', id: 'other-page' }]);
}

describe('Workbench directed Socket acceptance', () => {
  it.each(cases)(
    'reports the Watch result to Node when the target $scenario',
    async ({ closure }) => {
      const f = fixture();
      try {
        const { page, other } = await f.connect();
        const before = page.socket.sent.length;
        const otherBefore = other.socket.sent.length;
        const send = setSendOutcome(page.socket, closure);
        const event = {
          type: 'watch.workspace.snapshot',
          workbenchConnectionId: page.connectionId,
          watchId: 'watch-1234',
          nodeId,
          nodeGeneration,
          workspaceId,
          topic: 'sessions',
          revision: 1,
          snapshotSequence: 1,
          expiresAt: Date.now() + 30_000,
          payload: { sessions: [] }
        };
        const frame = { type: 'watch.event', event };
        const id = f.receiveNode('watch.event', event);
        await vi.waitFor(() =>
          expect(f.node.sent.some((message) => message.replyTo === id)).toBe(true)
        );
        expect(f.authorize).toHaveBeenCalledWith(
          user.userId,
          nodeId,
          'workbench.event.receive',
          frame,
          workspaceId
        );
        if (closure === undefined) {
          expect(page.socket.sent.slice(before)).toEqual([frame]);
          expect(page.socket.close).not.toHaveBeenCalled();
        } else {
          expect(page.socket.sent.slice(before)).toEqual([]);
          expect(page.socket.close.mock.calls).toEqual([closure]);
        }
        expect(send).toHaveBeenCalledTimes(closure?.[0] === 4009 ? 0 : 1);
        expectIndependentPage(other.socket, otherBefore);
        expect(f.node.sent.filter((message) => message.replyTo === id)).toEqual([
          expect.objectContaining({
            type: 'ack',
            payload: {
              type: 'watch.event',
              delivery: closure === undefined ? 'delivered' : 'unavailable'
            }
          })
        ]);
      } finally {
        f.control.close();
      }
    }
  );

  it.each(cases)(
    'settles the prepared Terminal grant when the target $scenario',
    async ({ closure }) => {
      const f = fixture();
      try {
        const { page, other } = await f.connect();
        page.socket.receive({
          type: 'direct.prepare',
          purpose: 'TRANSPORT',
          requestId: 'transport-request',
          nodeId,
          nodeGeneration
        });
        await vi.waitFor(() =>
          expect(page.socket.sent.some((message) => message.type === 'direct.prepared')).toBe(true)
        );
        const transportSessionId = page.socket.sent.find(
          (message) => message.type === 'direct.prepared'
        )!.directSessionId;
        const fingerprint = (octet: string) => `sha-256 ${Array<string>(32).fill(octet).join(':')}`;
        page.socket.receive({
          type: 'direct.signal',
          directSessionId: transportSessionId,
          signal: { kind: 'OFFER', sdp: 'v=0', fingerprint: fingerprint('AA') }
        });
        f.receiveNode('direct.signal', {
          directSessionId: transportSessionId,
          signal: { kind: 'ANSWER', sdp: 'v=0', fingerprint: fingerprint('BB') }
        });
        page.socket.receive({ type: 'direct.connected', directSessionId: transportSessionId });
        f.receiveNode('direct.connected', { directSessionId: transportSessionId });
        await f.control.drainProjections();

        const requestId = 'terminal-request';
        page.socket.receive({
          type: 'terminal.direct.prepare',
          requestId,
          nodeId,
          nodeGeneration,
          transportSessionId,
          terminalId: 'terminal-1',
          workspaceId,
          afterSequence: 0,
          readonly: false
        });
        const preflight = await vi.waitFor(() => {
          const request = f.node.sent.find((message) => message.type === 'node.request');
          expect(request).toMatchObject({
            payload: {
              operation: 'terminal.direct.preflight',
              data: { terminalId: 'terminal-1', workspaceId }
            }
          });
          return request!;
        });
        f.receiveNode('node.response', { result: {} }, preflight.id as string);
        const prepare = await vi.waitFor(() => {
          const command = f.node.sent.find((message) => message.type === 'terminal.direct.prepare');
          expect(command?.payload).toMatchObject({
            directSessionId: expect.any(String),
            workbenchConnectionId: page.connectionId,
            grant: expect.any(String)
          });
          return command!.payload as {
            directSessionId: string;
            grant: string;
            openExpiresAt: number;
            expiresAt: number;
          };
        });
        expect(
          page.socket.sent.some((message) => message.type === 'terminal.direct.prepared')
        ).toBe(false);
        const before = page.socket.sent.length;
        const otherBefore = other.socket.sent.length;
        const send = setSendOutcome(page.socket, closure);
        const { directSessionId, grant, openExpiresAt, expiresAt } = prepare;
        f.receiveNode('terminal.direct.ready', { directSessionId, phase: 'PREPARED' });
        await f.control.drainProjections();

        const cancels = f.node.sent.filter((message) => message.type === 'terminal.direct.cancel');
        if (closure === undefined) {
          expect(page.socket.sent.slice(before)).toEqual([
            {
              type: 'terminal.direct.prepared',
              requestId,
              directSessionId,
              grant,
              openExpiresAt,
              expiresAt
            }
          ]);
          expect(page.socket.close).not.toHaveBeenCalled();
          expect(cancels).toEqual([]);
        } else {
          expect(page.socket.sent.slice(before)).toEqual([]);
          expect(page.socket.close.mock.calls).toEqual([closure]);
        }
        expect(send).toHaveBeenCalledTimes(closure?.[0] === 4009 ? 0 : 1);
        expectIndependentPage(other.socket, otherBefore);
        if (closure !== undefined)
          expect(cancels.map((message) => message.payload)).toEqual([
            {
              type: 'terminal.direct.cancel',
              directSessionId,
              code: 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE'
            }
          ]);
      } finally {
        f.control.close();
      }
    }
  );
});
