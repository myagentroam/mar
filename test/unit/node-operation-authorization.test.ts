import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
import { createTestNodeControl } from '../support/create-test-node-control.js';

describe('Node operation authorization changes', () => {
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
