import type { NotificationTarget, ServerNotification } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { watch } from 'vue';
import { createWorkbenchNotificationService } from '../../src/service/workbench-notification-service.js';

function entry(id: string, target: NotificationTarget, updatedAt = 100): ServerNotification {
  return {
    id,
    kind: 'run',
    title: 'Completed',
    message: '',
    target,
    read: false,
    createdAt: 100,
    updatedAt,
    expiresAt: Date.now() + 60_000
  };
}

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const targets: NotificationTarget[] = [
  {
    targetType: 'WORKSPACE_SESSION',
    nodeId: 'node',
    workspaceId: 'workspace',
    sessionId: 'session'
  },
  {
    targetType: 'HOSTED_CONVERSATION',
    nodeId: 'node',
    conversationId: 'conversation',
    conversationName: 'Conversation'
  }
];

function confirm(target: NotificationTarget, readAt = 200, notificationIds = ['covered']) {
  return target.targetType === 'WORKSPACE_SESSION'
    ? {
        type: 'notification.session-read',
        nodeId: target.nodeId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        notificationIds,
        readAt
      }
    : {
        type: 'notification.conversation-read',
        nodeId: target.nodeId,
        conversationId: target.conversationId,
        notificationIds,
        readAt
      };
}

function mark(
  state: ReturnType<typeof createWorkbenchNotificationService>,
  target: NotificationTarget
) {
  if (target.targetType === 'WORKSPACE_SESSION')
    return state.markSessionRead(target.nodeId, target.workspaceId, target.sessionId);
  state.markConversationRead(target.nodeId, target.conversationId);
}

describe.each(targets)('target read confirmation: $targetType', (target) => {
  it('coalesces writes, waits for success and performs no list fetch on repeated switches', async () => {
    const pending = gate<unknown>();
    const request = vi.fn((_path: string, _init?: RequestInit) => pending.promise);
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notifications.value = [{ ...entry('one', target), source: 'server' }];
    mark(state, target);
    mark(state, target);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.unreadCount.value).toBe(1);
    pending.resolve({});
    await vi.waitFor(() => expect(state.unreadCount.value).toBe(0));
    mark(state, target);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
    state.dispose();
  });

  it('retains newer notifications and other identities when projecting an authoritative event', () => {
    const request = vi.fn();
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notifications.value = [
      { ...entry('covered', target), source: 'server' },
      { ...entry('newer', target, 201), source: 'server' },
      { ...entry('late-occurrence', target, 50), source: 'server' },
      { ...entry('other-node', { ...target, nodeId: 'other' }), source: 'server' },
      {
        ...entry(
          'other-scope',
          target.targetType === 'WORKSPACE_SESSION'
            ? { ...target, workspaceId: 'other' }
            : { ...target, conversationId: 'other' }
        ),
        source: 'server'
      }
    ];
    const message = confirm(target, 200, ['covered', 'other-node', 'other-scope']);
    state.projectServerMessage(message);
    state.projectServerMessage(message);
    expect(state.notifications.value.map((item) => [item.id, item.read])).toEqual([
      ['covered', true],
      ['newer', false],
      ['late-occurrence', false],
      ['other-node', false],
      ['other-scope', false]
    ]);
    expect(request).not.toHaveBeenCalled();
    state.dispose();
  });

  it('uses confirmed IDs even when the Node occurrence timestamp is ahead of the Server clock', () => {
    const state = createWorkbenchNotificationService({ value: 'admin' } as never);
    state.notifications.value = [{ ...entry('covered', target, 999), source: 'server' }];
    state.projectServerMessage(confirm(target));
    expect(state.unreadCount.value).toBe(0);
    state.dispose();
  });

  it('replays read confirmations over an older in-flight list without another GET', async () => {
    const snapshot = gate<unknown>();
    const request = vi.fn(() => snapshot.promise);
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    const loading = state.load();
    state.projectServerMessage(confirm(target));
    snapshot.resolve({ notifications: [entry('covered', target), entry('newer', target, 201)] });
    await loading;
    expect(state.notifications.value.map((item) => item.read)).toEqual([true, false]);
    expect(request).toHaveBeenCalledTimes(1);
    state.dispose();
  });
});

describe('target read write boundaries', () => {
  const target = targets[0]!;

  it.each([true, false])(
    'preserves the recovery retry policy when joining an ordinary read: stillActive=%s',
    async (stillActive) => {
      const pending = gate<unknown>();
      let posts = 0;
      let active = true;
      const request = vi.fn((path: string) => {
        if (path === '/api/notifications')
          return Promise.resolve({ notifications: [entry('one', target)] });
        return ++posts === 1 ? pending.promise : Promise.resolve({});
      });
      const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
        request: request as never,
        activeTarget: () => (active ? target : undefined)
      });
      state.notifications.value = [{ ...entry('one', target), source: 'server' }];
      const reading = mark(state, target);
      const recovering = state.recover();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      // Let recovery attach to the pending target write after its snapshot settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      active = stillActive;
      pending.reject(new Error('NETWORK_ERROR'));
      await Promise.all([reading, recovering]);
      expect(posts).toBe(stillActive ? 2 : 1);
      expect(state.unreadCount.value).toBe(stillActive ? 0 : 1);
      state.dispose();
    }
  );

  it('keeps a failed read retryable without fetching the list', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('NETWORK_ERROR')).mockResolvedValue({});
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notifications.value = [{ ...entry('one', target), source: 'server' }];
    await mark(state, target);
    expect(state.unreadCount.value).toBe(1);
    await mark(state, target);
    expect(state.unreadCount.value).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    state.dispose();
  });

  it('does not read a new or updated notification with an earlier write acknowledgement', async () => {
    const pending = gate<unknown>();
    const request = vi.fn(() => pending.promise);
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notifications.value = [{ ...entry('one', target), source: 'server' }];
    const reading = mark(state, target);
    state.notifications.value = [
      { ...entry('one', target, 201), source: 'server' },
      { ...entry('new', target, 201), source: 'server' }
    ];
    pending.resolve({});
    await reading;
    expect(state.unreadCount.value).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
    state.dispose();
  });

  it('does not roll back a confirmed write when an older list response arrives afterward', async () => {
    const snapshot = gate<unknown>();
    const one = entry('one', target);
    const request = vi.fn((path: string) =>
      path === '/api/notifications' ? snapshot.promise : Promise.resolve({})
    );
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: request as never
    });
    state.notifications.value = [{ ...one, source: 'server' }];
    const loading = state.load();
    await mark(state, target);
    expect(state.unreadCount.value).toBe(0);
    const observed: number[] = [];
    const stop = watch(state.unreadCount, (count) => observed.push(count), { flush: 'sync' });
    snapshot.resolve({ notifications: [one] });
    await loading;
    stop();
    expect(state.unreadCount.value).toBe(0);
    expect(observed).not.toContain(1);
    expect(request.mock.calls.filter(([path]) => path === '/api/notifications')).toHaveLength(1);
    state.dispose();
  });

  it('does not apply a delayed acknowledgement after account disposal', async () => {
    const pending = gate<unknown>();
    const state = createWorkbenchNotificationService({ value: 'admin' } as never, {
      request: (() => pending.promise) as never
    });
    state.notifications.value = [{ ...entry('one', target), source: 'server' }];
    const reading = mark(state, target);
    state.dispose();
    state.notifications.value = [{ ...entry('one', target), source: 'server' }];
    pending.resolve({});
    await reading;
    expect(state.unreadCount.value).toBe(1);
    state.dispose();
  });
});
