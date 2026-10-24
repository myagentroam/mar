import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../packages/protocol/src/index.js';

import { ServerDatabase } from '../../ee/server/src/database.js';
import { NodeControl } from '../../ee/server/src/node-control.js';

import { WorkbenchRelayService } from '../../ee/server/src/service/workbench-relay-service.js';

import { registerOwnedNode } from './support/node-control-fixture.js';

describe('Node controlled relay contract', () => {
  it('clears offline recent sessions after previously admitted projections finish', async () => {
    const database = new ServerDatabase(':memory:');
    const nodeId = registerOwnedNode(database);
    const control = new NodeControl(database);
    const active = new Set<string>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    control.setNotificationHandler(async () => {
      await pending;
      return true;
    });
    control.setRecentRunHandler(
      async () => {
        active.add('session-1');
        return true;
      },
      async () => {
        active.clear();
      }
    );
    const internals = control as unknown as {
      sockets: Map<string, unknown>;
      handleAuthenticatedMessage(
        nodeId: string,
        socket: unknown,
        envelope: ReturnType<typeof createEnvelope>
      ): Promise<boolean>;
      messageProjector: {
        enqueueSessionProjection(nodeId: string, project: () => Promise<void>): Promise<void>;
      };
    };
    const socket = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() };
    internals.sockets.set(nodeId, socket);
    try {
      await internals.handleAuthenticatedMessage(
        nodeId,
        socket,
        createEnvelope('workbench.event', {
          sequence: 1,
          category: 'conversation',
          payload: { event: { eventType: 'notification', payload: {} } }
        })
      );
      await internals.handleAuthenticatedMessage(nodeId, socket, createEnvelope('recent-runs', {}));
      control.closeNode(nodeId, 1000, 'TEST_NODE_OFFLINE');
      expect(control.isNodeConnected(nodeId)).toBe(false);
      release();
      await internals.messageProjector.enqueueSessionProjection(nodeId, async () => undefined);
      expect(active.size).toBe(0);
    } finally {
      release();
      control.close();
      database.close();
    }
  });

  it('Global Workbench frames relay by Node sequence and repeated resume does not replay events', async () => {
    const database = new ServerDatabase(':memory:');
    const nodeId = registerOwnedNode(database);
    const control = new NodeControl(database);
    const browserSent: unknown[] = [];
    const browserHandlers = new Map<string, (value: Buffer | string) => void>();
    const browser = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        browserSent.push(JSON.parse(raw));
      },
      close() {},
      on(event: string, handler: (value: Buffer | string) => void) {
        browserHandlers.set(event, handler);
      }
    };
    control.attachBrowserWorkbench(browser as never, { userId: 1, sessionHash: 'a'.repeat(43) });
    browserHandlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    await vi.waitFor(() =>
      expect(browserSent).toContainEqual(
        expect.objectContaining({ type: 'workbench.ready', resumed: false })
      )
    );

    const nodeSent: unknown[] = [];
    const node = {
      readyState: 1,
      OPEN: 1,
      send(raw: string) {
        const message = JSON.parse(raw) as {
          id: string;
          type: string;
          payload: { operation?: string };
        };
        nodeSent.push(message);
      }
    };
    (control as unknown as { sockets: Map<string, typeof node> }).sockets.set(nodeId, node);
    (
      control as unknown as {
        recordWorkbenchEvent(
          nodeId: string,
          socket: typeof node,
          envelope: ReturnType<typeof createEnvelope>
        ): void;
      }
    ).recordWorkbenchEvent(
      nodeId,
      node,
      createEnvelope('workbench.event', {
        sequence: 1,
        category: 'conversation',
        payload: {
          event: { runId: 'r', sequence: 1, eventType: 'text.delta', payload: { text: 'ok' } }
        }
      })
    );
    expect(nodeSent).toContainEqual(
      expect.objectContaining({ type: 'ack', payload: { type: 'workbench.event', sequence: 1 } })
    );
    await vi.waitFor(() =>
      expect(browserSent).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: expect.objectContaining({ nodeId, sequence: 1 })
        })
      )
    );

    const notification = vi.fn(async () => true);
    control.setNotificationHandler(notification);
    const browserCount = browserSent.length;
    (
      control as unknown as {
        recordWorkbenchEvent(
          nodeId: string,
          socket: typeof node,
          envelope: ReturnType<typeof createEnvelope>
        ): void;
      }
    ).recordWorkbenchEvent(
      nodeId,
      node,
      createEnvelope('workbench.event', {
        sequence: 2,
        category: 'conversation',
        payload: {
          event: {
            runId: 'r',
            sequence: 1,
            eventType: 'notification',
            payload: { notificationId: 'notification-1' }
          }
        }
      })
    );
    await vi.waitFor(() =>
      expect(notification).toHaveBeenCalledWith(nodeId, {
        notificationId: 'notification-1'
      })
    );
    expect(browserSent).toHaveLength(browserCount);

    (
      control as unknown as {
        recordWorkbenchEvent(
          nodeId: string,
          socket: typeof node,
          envelope: ReturnType<typeof createEnvelope>
        ): void;
      }
    ).recordWorkbenchEvent(
      nodeId,
      node,
      createEnvelope('workbench.event', {
        sequence: 3,
        category: 'hosted-conversation',
        payload: {
          kind: 'notification',
          event: {
            runId: 'hosted-run',
            sequence: 1,
            eventType: 'notification',
            payload: { notificationId: 'hosted-notification-1' }
          }
        }
      })
    );
    await vi.waitFor(() =>
      expect(notification).toHaveBeenCalledWith(nodeId, {
        notificationId: 'hosted-notification-1'
      })
    );
    expect(browserSent).toHaveLength(browserCount);

    const hostedActivity = vi.fn(async () => true);
    control.setHostedConversationActivityHandler(hostedActivity);
    (
      control as unknown as {
        recordWorkbenchEvent(
          nodeId: string,
          socket: typeof node,
          envelope: ReturnType<typeof createEnvelope>
        ): void;
      }
    ).recordWorkbenchEvent(
      nodeId,
      node,
      createEnvelope('workbench.event', {
        sequence: 4,
        category: 'hosted-conversation',
        payload: {
          kind: 'activity',
          userId: 7,
          templateId: 'template-1',
          conversationId: 'conversation-1',
          activity: { status: 'RUNNING', version: 1, updatedAt: 1 }
        }
      })
    );
    await vi.waitFor(() =>
      expect(hostedActivity).toHaveBeenCalledWith(
        nodeId,
        expect.objectContaining({
          conversationId: 'conversation-1',
          activity: expect.objectContaining({ status: 'RUNNING' })
        })
      )
    );
    expect(browserSent).toHaveLength(browserCount);

    const sentBeforeResume = nodeSent.length;
    browserHandlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    await Promise.resolve();
    expect(nodeSent).toHaveLength(sentBeforeResume);
    database.close();
  });

  it('Workbench limits count logical connections during the grace period and permit replacement of the same connection', async () => {
    const database = new ServerDatabase(':memory:');
    const control = new NodeControl(database);
    const sockets: Array<{
      sent: Array<Record<string, unknown>>;
      close: ReturnType<typeof vi.fn>;
      handlers: Map<string, (value: Buffer | string) => void>;
    }> = [];
    const createBrowser = () => {
      const sent: Array<Record<string, unknown>> = [];
      const close = vi.fn();
      const handlers = new Map<string, (value: Buffer | string) => void>();
      const socket = {
        readyState: 1,
        OPEN: 1,
        bufferedAmount: 0,
        send(raw: string) {
          sent.push(JSON.parse(raw) as Record<string, unknown>);
        },
        close,
        on(event: string, handler: (value: Buffer | string) => void) {
          handlers.set(event, handler);
        }
      };
      sockets.push({ sent, close, handlers });
      control.attachBrowserWorkbench(socket as never, { userId: 1, sessionHash: 'a'.repeat(43) });
      return sockets.at(-1)!;
    };

    for (let index = 0; index < 8; index += 1) {
      const browser = createBrowser();
      browser.handlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    }
    await vi.waitFor(() => expect(sockets.every((socket) => socket.sent.length === 1)).toBe(true));
    const rejected = createBrowser();
    rejected.handlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    await vi.waitFor(() =>
      expect(rejected.close).toHaveBeenCalledWith(4008, 'WORKBENCH_CONNECTION_LIMIT_REACHED')
    );

    const firstReady = sockets[0]!.sent[0]!;
    const replacement = createBrowser();
    replacement.handlers.get('message')?.(
      JSON.stringify({
        type: 'resume',
        workbenchConnectionId: firstReady['workbenchConnectionId'],
        workbenchResumeToken: firstReady['workbenchResumeToken']
      })
    );
    await vi.waitFor(() =>
      expect(replacement.sent).toContainEqual(
        expect.objectContaining({
          type: 'workbench.ready',
          workbenchConnectionId: firstReady['workbenchConnectionId'],
          resumed: true
        })
      )
    );
    control.close();
    database.close();
  });

  it('One Workbench WebSocket cannot create duplicate logical connections', async () => {
    const database = new ServerDatabase(':memory:');
    const control = new NodeControl(database);
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const handlers = new Map<string, (value: Buffer | string) => void>();
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        sent.push(JSON.parse(raw) as Record<string, unknown>);
      },
      close,
      on(event: string, handler: (value: Buffer | string) => void) {
        handlers.set(event, handler);
      }
    };
    control.attachBrowserWorkbench(socket as never, {
      userId: 1,
      sessionHash: 'a'.repeat(43)
    });
    handlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    await vi.waitFor(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'workbench.ready' }))
    );
    handlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    expect(close).toHaveBeenCalledWith(4002, 'WORKBENCH_ALREADY_READY');
    expect(sent).toHaveLength(1);
    control.close();
    database.close();
  });

  it('Ready Workbench WebSockets echo application-level ping', async () => {
    const database = new ServerDatabase(':memory:');
    const control = new NodeControl(database);
    const sent: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const handlers = new Map<string, (value: Buffer | string) => void>();
    const socket = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        sent.push(JSON.parse(raw) as Record<string, unknown>);
      },
      close,
      on(event: string, handler: (value: Buffer | string) => void) {
        handlers.set(event, handler);
      }
    };
    control.attachBrowserWorkbench(socket as never, {
      userId: 1,
      sessionHash: 'a'.repeat(43)
    });
    handlers.get('message')?.(JSON.stringify({ type: 'resume' }));
    await vi.waitFor(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'workbench.ready' }))
    );

    handlers.get('message')?.(JSON.stringify({ type: 'ping', id: 'ping-1' }));

    expect(sent).toContainEqual({ type: 'pong', id: 'ping-1' });
    expect(close).not.toHaveBeenCalled();
    control.close();
    database.close();
  });

  it('Workbench broadcasts for a busy Node do not starve other Nodes', async () => {
    const database = new ServerDatabase(':memory:');
    const firstNodeId = registerOwnedNode(database);
    const secondNodeId = registerOwnedNode(database);
    const control = new NodeControl(database);
    const sent: string[] = [];
    let browserMessage: ((value: string, isBinary?: boolean) => void) | undefined;
    const browser = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        const message = JSON.parse(raw) as { type: string; nodeId?: string };
        if (message.type !== 'ready' && message.nodeId !== undefined) sent.push(message.nodeId);
      },
      close() {},
      on(event: string, handler: (value: string, isBinary?: boolean) => void) {
        if (event === 'message') browserMessage = handler;
      }
    };
    control.attachBrowserWorkbench(browser as never, { userId: 1, sessionHash: 'a'.repeat(43) });
    browserMessage?.(JSON.stringify({ type: 'resume' }), false);
    const relay = (
      control as unknown as {
        workbenchRelay: { enqueue(nodeId: string, message: object): void };
      }
    ).workbenchRelay;
    const enqueue = relay.enqueue.bind(relay);
    for (let index = 0; index < 40; index += 1)
      enqueue(firstNodeId, {
        type: 'node',
        nodeId: firstNodeId,
        connected: true,
        ...(index < 2 ? { pressure: 'x'.repeat(300 * 1024) } : {})
      });
    enqueue(secondNodeId, { type: 'node', nodeId: secondNodeId, connected: true });

    await vi.waitFor(() => expect(sent).toHaveLength(41));
    expect(sent.indexOf(secondNodeId)).toBeLessThanOrEqual(1);
    control.close();
    database.close();
  });

  it('Asynchronous Workbench authorization preserves broadcast and targeted Watch event order', async () => {
    const resolvers: Array<(allowed: boolean) => void> = [];
    const database = {
      userCanRequestNode: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          })
      )
    };
    const relay = new WorkbenchRelayService({ database: database as never });
    const sent: number[] = [];
    const directed: number[] = [];
    let connectionId: string | undefined;
    let browserMessage: ((value: string, isBinary?: boolean) => void) | undefined;
    const browser = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send(raw: string) {
        const message = JSON.parse(raw) as {
          type: string;
          workbenchConnectionId?: string;
          event?: { sequence?: number };
        };
        if (message.type === 'workbench.ready') connectionId = message.workbenchConnectionId;
        if (message.type === 'event' && message.event?.sequence !== undefined)
          sent.push(message.event.sequence);
        if (message.type === 'watch.event' && message.event?.sequence !== undefined)
          directed.push(message.event.sequence);
      },
      close() {},
      on(event: string, handler: (value: string, isBinary?: boolean) => void) {
        if (event === 'message') browserMessage = handler;
      }
    };
    relay.attach(browser as never, { userId: 1, sessionHash: 'a'.repeat(43) });
    browserMessage?.(JSON.stringify({ type: 'resume' }), false);

    relay.publish({ nodeId: 'node-1', sequence: 1, category: 'conversation', payload: {} });
    relay.publish({ nodeId: 'node-1', sequence: 2, category: 'conversation', payload: {} });

    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]?.(true);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.(true);
    await vi.waitFor(() => expect(sent).toEqual([1, 2]));

    const first = relay.sendConnection(connectionId!, {
      type: 'watch.event',
      event: { nodeId: 'node-1', workspaceId: 'workspace-1', sequence: 3 }
    });
    const second = relay.sendConnection(connectionId!, {
      type: 'watch.event',
      event: { nodeId: 'node-1', workspaceId: 'workspace-1', sequence: 4 }
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]?.(true);
    await vi.waitFor(() => expect(resolvers).toHaveLength(4));
    resolvers[3]?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual(['delivered', 'delivered']);
    expect(directed).toEqual([3, 4]);
    relay.close();
  });
});
