import { createEnvelope, sessionGroupChangedSchema } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createTestNodeMessageProjector } from './support/node-message-projector.js';

describe('Node message projection boundaries', () => {
  it('drains admitted hosted activity and ordered session projections', async () => {
    let releaseActivity!: () => void;
    let releaseSession!: () => void;
    const activity = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    const session = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const projector = createTestNodeMessageProjector({
      relay: { publish: vi.fn() } as never,
      send: vi.fn(),
      sendInvalid: vi.fn(),
      hostedConversationActivity: async () => {
        await activity;
        return true;
      }
    });
    projector.project(
      'node-1',
      { send() {} } as never,
      createEnvelope('workbench.event', {
        sequence: 1,
        category: 'hosted-conversation',
        payload: { kind: 'activity' }
      })
    );
    const pending = projector.enqueueSessionProjection('node-1', async () => session);
    let drained = false;
    const done = projector.drain().then(() => {
      drained = true;
    });
    releaseSession();
    await pending;
    expect(drained).toBe(false);
    releaseActivity();
    await done;
    expect(drained).toBe(true);
  });
  it('accepts only a strictly scoped Main-session classification change', () => {
    const change = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;

    expect(sessionGroupChangedSchema.safeParse(change).success).toBe(true);
    expect(sessionGroupChangedSchema.safeParse({ ...change, sessionGroup: 'CHILD' }).success).toBe(
      false
    );
    expect(sessionGroupChangedSchema.safeParse({ ...change, parentSessionId: null }).success).toBe(
      false
    );
    expect(
      sessionGroupChangedSchema.safeParse({
        nodeId: change.nodeId,
        sessionId: change.sessionId,
        sessionGroup: change.sessionGroup
      }).success
    ).toBe(false);
  });

  it('acknowledges a session-group change only after reclassification succeeds', async () => {
    let completeProjection!: () => void;
    const projection = new Promise<void>((resolve) => {
      completeProjection = resolve;
    });
    const send = vi.fn();
    const sendInvalid = vi.fn();
    const publish = vi.fn();
    const sessionGroupChanged = vi.fn(() => projection);
    const projector = createTestNodeMessageProjector({
      relay: { publish } as never,
      send,
      sendInvalid,
      sessionGroupChanged
    });
    const socket = {} as never;
    const change = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;
    const envelope = createEnvelope('session.group.changed', change);

    projector.project('node-1', socket, envelope);

    expect(sessionGroupChanged).toHaveBeenCalledExactlyOnceWith(change);
    expect(send).not.toHaveBeenCalled();
    expect(sendInvalid).not.toHaveBeenCalled();
    completeProjection();
    await projection;
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith(socket, 'session.group.ack', change, envelope.id)
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['notification', 'recent-runs', 'notification-channels'] as const)(
    'waits for an earlier %s projection before reclassifying and acknowledging the session',
    async (source) => {
      let finishPrevious!: () => void;
      const previous = new Promise<void>((resolve) => (finishPrevious = resolve));
      let storedGroup = 'CHILD';
      const projectPrevious = vi.fn(async () => {
        await previous;
        storedGroup = 'CHILD';
        return true;
      });
      const sessionGroupChanged = vi.fn(async () => {
        storedGroup = 'MAIN';
      });
      const send = vi.fn();
      const projector = createTestNodeMessageProjector({
        relay: { publish: vi.fn() } as never,
        send,
        sendInvalid: vi.fn(),
        notification: projectPrevious,
        recentRuns: projectPrevious,
        sessionGroupChanged
      });
      const socket = {} as never;
      const change = {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        sessionGroup: 'MAIN'
      } as const;
      const earlier =
        source === 'recent-runs'
          ? createEnvelope('recent-runs', {})
          : createEnvelope('workbench.event', {
              sequence: 1,
              category: 'conversation',
              payload: { event: { eventType: 'notification', payload: { sessionGroup: 'CHILD' } } }
            });
      if (source === 'notification-channels')
        void projector.enqueueSessionProjection('node-1', projectPrevious);
      else projector.project('node-1', socket, earlier);
      const moved = createEnvelope('session.group.changed', change);
      projector.project('node-1', socket, moved);
      await Promise.resolve();

      expect(projectPrevious).toHaveBeenCalledOnce();
      expect(sessionGroupChanged).not.toHaveBeenCalled();
      expect(send.mock.calls.some(([, type]) => type === 'session.group.ack')).toBe(false);

      finishPrevious();
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(socket, 'session.group.ack', change, moved.id)
      );
      expect(storedGroup).toBe('MAIN');
    }
  );

  it('does not block another Node while a session projection is pending', async () => {
    let finishPrevious!: () => void;
    const previous = new Promise<boolean>((resolve) => {
      finishPrevious = () => resolve(true);
    });
    const send = vi.fn();
    const publish = vi.fn();
    const projector = createTestNodeMessageProjector({
      relay: { publish } as never,
      send,
      sendInvalid: vi.fn(),
      recentRuns: () => previous,
      sessionGroupChanged: async () => undefined
    });
    const socket = {} as never;
    const change = {
      nodeId: 'node-2',
      workspaceId: 'workspace-2',
      sessionId: 'session-2',
      sessionGroup: 'MAIN'
    } as const;
    projector.project('node-1', socket, createEnvelope('recent-runs', {}));
    projector.project(
      'node-1',
      socket,
      createEnvelope('workbench.event', {
        sequence: 1,
        category: 'run',
        payload: { run: { id: 'run-1', status: 'RUNNING' } }
      })
    );
    expect(publish).toHaveBeenCalledOnce();
    const moved = createEnvelope('session.group.changed', change);
    projector.project('node-2', socket, moved);
    try {
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(socket, 'session.group.ack', change, moved.id)
      );
    } finally {
      finishPrevious();
    }
  });

  it('continues reclassification after an earlier projection fails', async () => {
    const send = vi.fn();
    const projector = createTestNodeMessageProjector({
      relay: { publish: vi.fn() } as never,
      send,
      sendInvalid: vi.fn(),
      recentRuns: async () => {
        throw new Error('RECENT_RUN_STORE_FAILED');
      },
      sessionGroupChanged: async () => undefined
    });
    const socket = {} as never;
    const change = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;
    projector.project('node-1', socket, createEnvelope('recent-runs', {}));
    const moved = createEnvelope('session.group.changed', change);
    projector.project('node-1', socket, moved);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(socket, 'session.group.ack', change, moved.id)
    );
  });

  it('closes the Node socket and never acknowledges when session-group reclassification fails', async () => {
    const send = vi.fn();
    const sendInvalid = vi.fn();
    const publish = vi.fn();
    const close = vi.fn();
    const sessionGroupChanged = vi.fn(async () => {
      throw new Error('SESSION_GROUP_STORE_FAILED');
    });
    const projector = createTestNodeMessageProjector({
      relay: { publish } as never,
      send,
      sendInvalid,
      sessionGroupChanged
    });
    const socket = { close } as never;
    const change = {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    } as const;

    projector.project('node-1', socket, createEnvelope('session.group.changed', change));
    await vi.waitFor(() =>
      expect(close).toHaveBeenCalledExactlyOnceWith(1011, 'SESSION_GROUP_PROJECTION_FAILED')
    );

    expect(send).not.toHaveBeenCalled();
    expect(sendInvalid).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a session-group event that spoofs its connected Node identity', () => {
    const send = vi.fn();
    const sendInvalid = vi.fn();
    const publish = vi.fn();
    const sessionGroupChanged = vi.fn(async () => undefined);
    const projector = createTestNodeMessageProjector({
      relay: { publish } as never,
      send,
      sendInvalid,
      sessionGroupChanged
    });
    const socket = {} as never;
    const envelope = createEnvelope('session.group.changed', {
      nodeId: 'node-spoofed',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionGroup: 'MAIN'
    });

    expect(projector.handles(envelope.type)).toBe(true);
    projector.project('node-1', socket, envelope);

    expect(sendInvalid).toHaveBeenCalledExactlyOnceWith(socket, envelope.id);
    expect(sessionGroupChanged).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('still acknowledges and relays ordinary Workbench Run state events', () => {
    const send = vi.fn();
    const sendInvalid = vi.fn();
    const publish = vi.fn();
    const projector = createTestNodeMessageProjector({
      relay: { publish } as never,
      send,
      sendInvalid
    });
    const socket = {} as never;
    const event = {
      sequence: 1,
      category: 'run',
      payload: { run: { id: 'run-1', status: 'RUNNING' } }
    };
    const envelope = createEnvelope('workbench.event', event);
    expect(projector.handles(envelope.type)).toBe(true);
    projector.project('node-1', socket, envelope);
    expect(sendInvalid).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      socket,
      'ack',
      { type: 'workbench.event', sequence: 1 },
      envelope.id
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith({ nodeId: 'node-1', ...event });
  });

  it.each(['runs.reconcile', 'lease.reconcile', 'unknown.control.message'])(
    'does not claim or acknowledge %s regardless of its old payload shape',
    (type) => {
      const send = vi.fn();
      const sendInvalid = vi.fn();
      const publish = vi.fn();
      const notification = vi.fn();
      const recentRuns = vi.fn();
      const projector = createTestNodeMessageProjector({
        relay: { publish } as never,
        send,
        sendInvalid,
        notification,
        recentRuns
      });
      expect(projector.handles(type)).toBe(false);
      for (const payload of [
        { runIds: ['active-run', 'unknown-run'] },
        { runId: 'active-run', known: false },
        {}
      ]) {
        projector.project('node-1', {} as never, createEnvelope(type, payload));
      }
      expect(send).not.toHaveBeenCalled();
      expect(sendInvalid).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(recentRuns).not.toHaveBeenCalled();
    }
  );
});
