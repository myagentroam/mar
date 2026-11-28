import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../packages/protocol/src/index.js';
import {
  decodeNodeRelayHandshake,
  decodeNodeStreamFrame,
  encodeNodeRelayHandshake,
  encodeNodeStreamFrame,
  type NodeStreamFrame
} from '../../packages/protocol/src/node-stream-wire.js';
import { ServerDatabase } from '../../ee/server/src/database.js';
import { registerRealtimeRoutes } from '../../ee/server/src/route/realtime-routes.js';
import { SESSION_COOKIE_NAME } from '../../packages/server-core/src/auth.js';
import { createTestNodeControl } from '../support/create-test-node-control.js';

const WebSocket = createRequire(import.meta.url)(
  '../../ee/server/node_modules/ws'
) as typeof import('../../ee/server/node_modules/@types/ws/index.js');

describe('Node operation authorization changes', () => {
  it('uses current Workspace access on a carrier admitted through a Hosted conversation', async () => {
    const f = await fixture();
    const app = Fastify();
    const user = { userId: 2, sessionHash: 'hosted-session' };
    const workspaceTicket = () =>
      f.control.createWorkspaceFileStreamTicket(f.nodeId, user, {
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId: 'workspace', path: 'file' },
        fileName: 'file',
        size: 1,
        revision: 'revision'
      });
    let client: InstanceType<typeof WebSocket> | undefined;
    try {
      const oldTicket = await workspaceTicket();
      f.denied.add(user.userId);
      registerRealtimeRoutes({
        app,
        database: {
          findCurrentUserSession: (cookie) =>
            cookie === 'hosted-login'
              ? {
                  ...user,
                  username: 'member',
                  csrfTokenHash: 'csrf',
                  isAdmin: false,
                  mustChangePassword: false
                }
              : undefined
        },
        nodeControl: f.control,
        publicOrigin: undefined,
        relayAccess: {
          credentials: { authenticateContext: async () => undefined },
          canUseNode: async () => false,
          canAccessNodeContainer: async () => !f.denied.has(user.userId),
          canAccessHostedConversation: async (actor, node, conversationId) =>
            actor.userId === user.userId && node === f.nodeId && conversationId === 'conversation'
        }
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const socket = new WebSocket(
        `${origin.replace(/^http:/u, 'ws:')}/api/relay/${f.nodeId}?hostedConversationId=conversation`,
        { headers: { origin, cookie: `${SESSION_COOKIE_NAME}=hosted-login` } }
      );
      client = socket;
      socket.binaryType = 'arraybuffer';
      const receive = async () => (await once(socket, 'message'))[0];
      expect(decodeNodeRelayHandshake(await receive())).toEqual({ type: 'RELAY_READY' });
      const send = async (frame: NodeStreamFrame) => {
        const reply = receive();
        socket.send(encodeNodeStreamFrame(frame));
        return decodeNodeStreamFrame(await reply);
      };
      const acknowledge = async (kind: string) => {
        await vi.waitFor(() => expect(f.relay.sent).toHaveLength(1));
        const open = decodeNodeStreamFrame(f.relay.sent.shift());
        expect(open).toMatchObject({ type: 'OPEN', kind });
        f.relay.receiveFrame({ type: 'OPENED', streamId: open.streamId });
        return open.streamId;
      };
      const hosted = await f.control.createHostedFileStreamTicket({
        kind: 'hosted-file-download',
        nodeId: f.nodeId,
        user,
        templateId: 'template',
        descriptor: { conversationId: 'conversation', fileId: 'file', revision: '1-1' },
        allowed: async () => true
      });
      const [hostedReply, hostedNodeId] = await Promise.all([
        send({ type: 'OPEN', streamId: 1, kind: 'hosted-file-download', grant: hosted }),
        acknowledge('hosted-file-download')
      ]);
      expect(hostedReply).toEqual({ type: 'OPENED', streamId: 1 });
      expect(
        await send({ type: 'OPEN', streamId: 2, kind: 'file-download', grant: oldTicket })
      ).toEqual({ type: 'RESET', streamId: 2, code: 'NODE_ACCESS_DENIED' });
      expect(f.relay.sent).toEqual([]);

      f.denied.delete(user.userId);
      const grant = await workspaceTicket();
      const [, workspaceNodeId] = await Promise.all([
        send({ type: 'OPEN', streamId: 3, kind: 'file-download', grant }).then((reply) =>
          expect(reply).toEqual({ type: 'OPENED', streamId: 3 })
        ),
        acknowledge('file-download')
      ]);
      for (const [streamId, nodeStreamId] of [
        [1, hostedNodeId],
        [3, workspaceNodeId]
      ] as const) {
        const bytes = Uint8Array.of(streamId);
        const data = receive();
        f.relay.receiveFrame({ type: 'DATA', streamId: nodeStreamId, bytes });
        expect(decodeNodeStreamFrame(await data)).toEqual({ type: 'DATA', streamId, bytes });
      }
    } finally {
      client?.terminate();
      await app.close();
      f.close();
    }
  });

  it.each([
    { change: 'tree change', reset: [1, 2, 3] },
    { change: 'membership change', reset: [1, 2, 3] },
    { change: 'membership change with access retained', reset: [] },
    { change: 'account deletion', reset: [1, 2, 3] },
    { change: 'Workspace grant removal', reset: [1, 2] },
    { change: 'template grant removal', reset: [3] }
  ] as const)(
    'ends only the affected continuing operations after $change',
    async ({ change, reset }) => {
      const f = await fixture();
      try {
        const affected = { userId: 2, sessionHash: 'affected' };
        const retained = { userId: 3, sessionHash: 'retained' };
        const first = await f.openOperations(affected);
        const second = await f.openOperations(retained);
        if (reset.length > 0) f.denied.add(affected.userId);
        switch (change) {
          case 'tree change':
            await f.control.revalidateOrganizationAuthorizations();
            break;
          case 'membership change':
          case 'membership change with access retained':
            await f.control.revalidateUserAuthorizations(affected.userId);
            break;
          case 'account deletion':
            f.control.closeUserSessions(affected.userId);
            break;
          case 'Workspace grant removal':
            await f.control.revalidateDataAuthorizations({
              nodeId: f.nodeId,
              workspaceId: 'workspace'
            });
            break;
          case 'template grant removal':
            await f.control.revalidateHostedFileAuthorizations('template');
            break;
        }

        expect(first.client.frames().sort((a, b) => a.streamId - b.streamId)).toEqual(
          reset.map((streamId) => ({
            type: 'RESET',
            code: 'RESOURCE_DENIED',
            streamId
          }))
        );
        expect(second.client.frames()).toEqual([]);
        for (const streamId of [1, 2, 3, 4] as const) {
          if (!reset.some((id) => id === streamId)) f.assertData(first, streamId);
        }
        f.assertData(second, 1);
        for (const { page } of change === 'account deletion' ? [second] : [first, second]) {
          page.receiveJson({ type: 'ping', id: 'still-ready' });
          expect(page.lastJson()).toEqual({ type: 'pong', id: 'still-ready' });
        }
      } finally {
        f.close();
      }
    }
  );
});

type User = { userId: number; sessionHash: string };

async function fixture() {
  const database = new ServerDatabase(':memory:');
  const { nodeId, credential } = database.registerNode(
    database.createNodeRegistrationToken(database.getAdmin().id).token,
    { metadata: '{}' }
  )!;
  const denied = new Set<number>();
  const control = createTestNodeControl(database, async (userId) => !denied.has(userId));
  const node = new Socket();
  const relay = new Socket();
  const close = () => {
    control.close();
    database.close();
  };
  try {
    control.attach(node.ws);
    node.receiveJson(createEnvelope('authenticate', { nodeId, credential }));
    await vi.waitFor(() => expect(node.lastJson()?.type).toBe('authenticated'));
    node.receiveJson(
      createEnvelope('capabilities', {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v24',
        nodeAppVersion: '0.15.26',
        codex: { available: false },
        claudeCode: { available: false }
      })
    );
    await vi.waitFor(() =>
      expect(node.lastJson()?.payload?.dataControlBinding).toBeTypeOf('string')
    );
    control.attachNodeRelay(relay.ws);
    relay.receiveBytes(
      encodeNodeRelayHandshake({
        type: 'RELAY_AUTH',
        nodeId,
        credential,
        controlBinding: node.lastJson()!.payload!.dataControlBinding!
      })
    );
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    expect(decodeNodeRelayHandshake(relay.sent.shift())).toEqual({ type: 'RELAY_READY' });
    node.onSend = (message) => {
      if (message.type === 'node.request')
        queueMicrotask(() =>
          node.receiveJson(
            createEnvelope(
              'node.response',
              {
                result: { grant: randomUUID() }
              },
              { replyTo: message.id }
            )
          )
        );
    };
  } catch (error) {
    close();
    throw error;
  }

  async function openOperations(user: User) {
    const client = new Socket();
    const page = new Socket();
    control.attachClientRelay(client.ws, nodeId, user);
    expect(decodeNodeRelayHandshake(client.sent.shift())).toEqual({ type: 'RELAY_READY' });
    control.attachBrowserWorkbench(page.ws, user);
    page.receiveJson({ type: 'resume' });
    expect(page.lastJson()?.type).toBe('workbench.ready');

    const workspaceId = 'workspace';
    const fileTicket = (path: string) =>
      control.createWorkspaceFileStreamTicket(nodeId, user, {
        direction: 'DOWNLOAD',
        resource: { kind: 'WORKSPACE_FILE', workspaceId, path },
        fileName: 'file',
        size: 1,
        revision: 'revision'
      });
    const tickets = [
      [
        'terminal',
        control.createTerminalTicket({ nodeId, user, workspaceId, terminalId: 'terminal' }).ticket
      ],
      ['file-download', await fileTicket(`mar-attachment://${randomUUID()}/file`)],
      [
        'hosted-file-download',
        await control.createHostedFileStreamTicket({
          kind: 'hosted-file-download',
          nodeId,
          user,
          templateId: 'template',
          descriptor: { conversationId: 'conversation', fileId: 'file', revision: '1-1' },
          allowed: async () => !denied.has(user.userId)
        })
      ],
      ['file-download', await fileTicket('ordinary')]
    ] as const;
    const nodeIds: number[] = [];
    for (const [kind, grant] of tickets) {
      const streamId = nodeIds.length + 1;
      // The fixture opens sequentially and consumes each forwarded OPEN before the next.
      client.receiveFrame({ type: 'OPEN', streamId, kind, grant });
      await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
      const open = decodeNodeStreamFrame(relay.sent.shift());
      expect(open).toMatchObject({ type: 'OPEN', kind });
      nodeIds.push(open.streamId);
      relay.receiveFrame({ type: 'OPENED', streamId: open.streamId });
      expect(client.frames()).toEqual([{ type: 'OPENED', streamId }]);
    }
    return { client, page, nodeIds };
  }

  return {
    control,
    nodeId,
    denied,
    relay,
    close,
    openOperations,
    assertData(operations: Awaited<ReturnType<typeof openOperations>>, streamId: number) {
      const bytes = Uint8Array.of(42);
      relay.receiveFrame({ type: 'DATA', streamId: operations.nodeIds[streamId - 1]!, bytes });
      expect(operations.client.frames()).toEqual([{ type: 'DATA', streamId, bytes }]);
    }
  };
}

type Message = { id: string; type: string; payload?: { dataControlBinding?: string } };

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readonly bufferedAmount = 0;
  readyState = this.OPEN;
  readonly sent: (string | Uint8Array)[] = [];
  onSend?: (message: Message) => void;

  get ws() {
    return this as unknown as Parameters<ReturnType<typeof createTestNodeControl>['attach']>[0];
  }
  send(message: string | Uint8Array) {
    this.sent.push(message);
    if (typeof message === 'string') this.onSend?.(JSON.parse(message));
  }
  lastJson(): Message | undefined {
    const last = this.sent.at(-1);
    return typeof last === 'string' ? JSON.parse(last) : undefined;
  }
  frames() {
    return this.sent.splice(0).map(decodeNodeStreamFrame);
  }
  receiveJson(message: object) {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  receiveBytes(bytes: Uint8Array) {
    this.emit('message', Buffer.from(bytes), true);
  }
  receiveFrame(frame: NodeStreamFrame) {
    this.receiveBytes(encodeNodeStreamFrame(frame));
  }
  ping() {}
  close() {
    this.terminate();
  }
  terminate() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}
