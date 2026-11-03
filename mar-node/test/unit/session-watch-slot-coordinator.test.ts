import { describe, expect, it, vi } from 'vitest';
import { SessionWatchSlotCoordinator } from '../../src/service/session-watch-slot-coordinator.js';
import type { NodeAgentSession } from '../../src/database.js';
import { createTestSessionWatch } from './support/conversation-watch.js';
import { HostedConversationWatch } from '../../src/hosting/hosted-conversation-watch.js';

describe('Session Watch connection slots', () => {
  it('keeps ordinary positions independent and makes hosted observation exclusive', () => {
    const slots = new SessionWatchSlotCoordinator();
    const primaryRelease = vi.fn();
    const secondaryRelease = vi.fn();
    const hostedRelease = vi.fn();
    const primary = slots.replace('owner', 'session', primaryRelease, 'primary');
    const secondary = slots.replace('owner', 'session', secondaryRelease, 'secondary');
    expect(slots.owns('owner', primary)).toBe(true);
    expect(slots.owns('owner', secondary)).toBe(true);
    const replacement = slots.replace('owner', 'session', vi.fn(), 'secondary');
    expect(secondaryRelease).toHaveBeenCalledOnce();
    expect(primaryRelease).not.toHaveBeenCalled();
    slots.release('owner', secondary);
    expect(slots.owns('owner', replacement)).toBe(true);
    const hosted = slots.replace('owner', 'hosted-conversation', hostedRelease);
    expect(primaryRelease).toHaveBeenCalledOnce();
    expect(slots.owns('owner', replacement)).toBe(false);
    expect(slots.owns('owner', hosted)).toBe(true);
    slots.replace('owner', 'session', vi.fn(), 'secondary');
    expect(hostedRelease).toHaveBeenCalledOnce();
  });

  it('routes independent leases and checks readiness of either exact target', async () => {
    const sessions = ['a', 'b', 'c'].map(
      (id) =>
        ({
          id,
          workspaceId: 'workspace',
          runner: 'codex'
        }) as NodeAgentSession
    );
    const events: unknown[] = [];
    const service = createTestSessionWatch({
      resolve: async (id) => sessions.find((session) => session.id === id),
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: (session) => session,
      readPage: async () => ({ turns: [] }),
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: (event) => events.push(event)
    });
    const watch = service.operations()['session.watch']!;
    const unwatch = service.operations()['session.unwatch']!;
    const base = { workspaceId: 'workspace', workbenchConnectionId: 'connection' };
    try {
      await watch({ ...base, sessionId: 'a', watchId: 'watch-a', mode: 'initial' });
      await watch({
        ...base,
        sessionId: 'b',
        watchId: 'watch-b',
        position: 'secondary',
        mode: 'initial'
      });
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(service.observes('local-test', 'connection', 'workspace', 'a')).toBe(true);
      expect(service.observes('local-test', 'connection', 'workspace', 'b')).toBe(true);
      expect(service.observes('local-test', 'connection', 'other', 'b')).toBe(false);
      await watch({
        ...base,
        sessionId: 'c',
        watchId: 'watch-c',
        position: 'secondary',
        mode: 'initial'
      });
      await unwatch({ ...base, sessionId: 'b', watchId: 'watch-b', position: 'secondary' });
      await expect(
        watch({ ...base, sessionId: 'b', watchId: 'watch-b', position: 'secondary', mode: 'renew' })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
      await vi.waitFor(() =>
        expect(service.observes('local-test', 'connection', 'workspace', 'c')).toBe(true)
      );
      expect(service.observes('local-test', 'connection', 'workspace', 'a')).toBe(true);
      expect(service.observes('local-test', 'connection', 'workspace', 'b')).toBe(false);
    } finally {
      service.clear();
    }
  });

  it('initializes secondary independently, rejects expiry, and hosted replaces real ordinary leases', async () => {
    const slots = new SessionWatchSlotCoordinator();
    const sessions = ['a', 'b'].map(
      (id) => ({ id, workspaceId: 'workspace', runner: 'codex' }) as NodeAgentSession
    );
    let releasePrimary!: (page: { turns: [] }) => void;
    const primaryPage = new Promise<{ turns: [] }>((resolve) => {
      releasePrimary = resolve;
    });
    const service = createTestSessionWatch({
      sessionWatchSlots: slots,
      resolve: async (id) => sessions.find((session) => session.id === id),
      managedActive: () => false,
      refreshActivity: async () => undefined,
      present: (session) => session,
      readPage: async (session) => (session.id === 'a' ? primaryPage : { turns: [] }),
      emitSession: vi.fn(),
      emitPage: vi.fn(),
      emitWatchEvent: vi.fn()
    });
    const hosted = new HostedConversationWatch({
      slots,
      nodeId: () => 'node',
      nodeGeneration: () => 'generation',
      emit: vi.fn(),
      nextEvent: () => undefined,
      initial: async () => ({}),
      snapshot: async () => ({}),
      mayRefresh: () => false
    });
    const watch = service.operations()['session.watch']!;
    const base = { workspaceId: 'workspace', workbenchConnectionId: 'connection' };
    const hostInput = {
      workbenchConnectionId: 'connection',
      watchId: 'hosted-watch',
      conversationId: 'hosted'
    };
    try {
      await watch({ ...base, sessionId: 'a', watchId: 'watch-a', mode: 'initial' });
      await watch({
        ...base,
        sessionId: 'b',
        watchId: 'watch-b',
        position: 'secondary',
        mode: 'initial'
      });
      await vi.waitFor(() =>
        expect(service.observes('local-test', 'connection', 'workspace', 'b')).toBe(true)
      );
      expect(service.observes('local-test', 'connection', 'workspace', 'a')).toBe(false);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 46_000);
      expect(service.observes('local-test', 'connection', 'workspace', 'b')).toBe(false);
      clock.mockRestore();
      hosted.watch(hostInput, 'local-test', 1, 'template', () => []);
      releasePrimary({ turns: [] });
      await expect(
        watch({ ...base, sessionId: 'a', watchId: 'watch-a', mode: 'renew' })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
      await expect(
        watch({ ...base, sessionId: 'b', watchId: 'watch-b', position: 'secondary', mode: 'renew' })
      ).rejects.toThrow('SESSION_WATCH_NOT_FOUND');
      expect(service.observes('local-test', 'connection', 'workspace', 'a')).toBe(false);
      expect(service.observes('local-test', 'connection', 'workspace', 'b')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      releasePrimary({ turns: [] });
      hosted.unwatch(hostInput, 'local-test', 1);
      service.clear();
    }
  });
});
