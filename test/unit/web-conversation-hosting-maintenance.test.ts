import { describe, expect, it, vi } from 'vitest';
import {
  conversationHostingMaintenanceAvailability,
  createConversationHostingMaintenanceService,
  sameConversationHostingMaintenanceContext
} from '@myagentroam/web-core/hosting-maintenance';
import {
  conversationHostingDisablementAvailability,
  conversationHostingEnablementAvailability,
  createConversationHostingEnablementService
} from '../../ee/web/src/service/conversation-hosting-enablement-service.js';

describe('Web conversation hosting maintenance service', () => {
  it('gates one-way enablement on organization ownership, Linux, connection, and current state', () => {
    const disabled = {
      state: 'DISABLED',
      apiVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: false,
      capacity: 'AVAILABLE'
    } as const;

    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        ownerType: 'ORGANIZATION',
        capability: disabled,
        writable: true
      })
    ).toEqual({ enabled: false, canEnable: true });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        ownerType: 'PERSONAL',
        capability: disabled,
        writable: true
      })
    ).toEqual({
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_ORGANIZATION_NODE_REQUIRED'
    });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        ownerType: 'ORGANIZATION',
        capability: undefined,
        writable: true
      })
    ).toEqual({
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_STATE_UNKNOWN'
    });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'windows',
        connected: true,
        disabled: false,
        ownerType: 'ORGANIZATION',
        capability: disabled,
        writable: true
      })
    ).toEqual({
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_PLATFORM_UNSUPPORTED'
    });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: false,
        disabled: false,
        ownerType: 'ORGANIZATION',
        capability: disabled,
        writable: true
      })
    ).toEqual({
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_NODE_OFFLINE'
    });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: true,
        ownerType: 'ORGANIZATION',
        capability: disabled,
        writable: true
      })
    ).toEqual({
      enabled: false,
      canEnable: false,
      reasonCode: 'CONVERSATION_HOSTING_ENABLE_NODE_OFFLINE'
    });
    expect(
      conversationHostingEnablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        ownerType: 'ORGANIZATION',
        capability: {
          ...disabled,
          state: 'UNAVAILABLE',
          reasonCode: 'SANDBOX_UNAVAILABLE'
        },
        writable: true
      })
    ).toEqual({
      enabled: true,
      canEnable: false,
      reasonCode: 'SANDBOX_UNAVAILABLE'
    });
  });

  it('posts strict enablement and validates the returned Node capability', async () => {
    const request = vi.fn<
      (
        path: string,
        init?: RequestInit
      ) => Promise<{
        capability: {
          state: 'AVAILABLE';
          apiVersion: 1;
          sandboxBackend: 'BUBBLEWRAP';
          sandboxPolicyVersion: 1;
          acceptsNewConversations: true;
          supportsExistingConversations: true;
          capacity: 'AVAILABLE';
        };
      }>
    >(async () => ({
      capability: {
        state: 'AVAILABLE',
        apiVersion: 1,
        sandboxBackend: 'BUBBLEWRAP',
        sandboxPolicyVersion: 1,
        acceptsNewConversations: true,
        supportsExistingConversations: true,
        capacity: 'AVAILABLE'
      }
    }));
    const service = createConversationHostingEnablementService(
      async <T>(path: string, init?: RequestInit) => (await request(path, init)) as T
    );

    await expect(service.enable('node/1')).resolves.toMatchObject({ state: 'AVAILABLE' });
    expect(request).toHaveBeenCalledWith(
      '/api/management/nodes/node%2F1/conversation-hosting/enable',
      {
        method: 'POST',
        body: JSON.stringify({ enabled: true })
      }
    );

    const invalid = createConversationHostingEnablementService(
      async <T>(): Promise<T> => ({ capability: { state: 'AVAILABLE' } }) as T
    );
    await expect(invalid.enable('node-1')).rejects.toThrow(
      'CONVERSATION_HOSTING_ENABLE_RESPONSE_INVALID'
    );
  });

  it('gates disablement on write access and posts a strict empty request', async () => {
    const enabled = {
      state: 'AVAILABLE',
      apiVersion: 1,
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      acceptsNewConversations: true,
      supportsExistingConversations: true,
      capacity: 'AVAILABLE'
    } as const;
    expect(
      conversationHostingDisablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        capability: enabled,
        writable: true
      })
    ).toEqual({ enabled: true, canDisable: true });
    expect(
      conversationHostingDisablementAvailability({
        platform: 'linux',
        connected: true,
        disabled: false,
        capability: enabled,
        writable: false
      })
    ).toEqual({
      enabled: true,
      canDisable: false,
      reasonCode: 'CONVERSATION_HOSTING_DISABLE_READ_ONLY'
    });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      void path;
      void init;
      return {
        capability: {
          state: 'DISABLED',
          apiVersion: 1,
          acceptsNewConversations: false,
          supportsExistingConversations: false,
          capacity: 'AVAILABLE'
        }
      };
    });
    const service = createConversationHostingEnablementService(
      async <T>(path: string, init?: RequestInit) => (await request(path, init)) as T
    );

    await expect(service.disable('node/1')).resolves.toMatchObject({ state: 'DISABLED' });
    expect(request).toHaveBeenCalledWith(
      '/api/management/nodes/node%2F1/conversation-hosting/disable',
      { method: 'POST', body: '{}' }
    );
  });

  it('gates maintenance requests on connection and hosting capability', () => {
    const capability = {
      state: 'AVAILABLE',
      apiVersion: 1,
      sandboxBackend: 'BUBBLEWRAP',
      sandboxPolicyVersion: 1,
      acceptsNewConversations: false,
      supportsExistingConversations: true,
      capacity: 'FULL'
    } as const;

    expect(conversationHostingMaintenanceAvailability(true, false, capability)).toEqual({
      available: true
    });
    expect(
      conversationHostingMaintenanceAvailability(true, false, {
        ...capability,
        state: 'UNAVAILABLE',
        acceptsNewConversations: false,
        supportsExistingConversations: false,
        capacity: 'AVAILABLE',
        reasonCode: 'SANDBOX_UNAVAILABLE'
      })
    ).toEqual({ available: false, reasonCode: 'SANDBOX_UNAVAILABLE' });
    expect(conversationHostingMaintenanceAvailability(false, false, capability)).toEqual({
      available: false,
      reasonCode: 'CONVERSATION_HOSTING_MAINTENANCE_NODE_OFFLINE'
    });
  });

  it('rejects stale maintenance responses after Node, threshold or context changes', () => {
    const requestContext = {
      nodeId: 'node-a',
      inactiveDays: 60,
      sequence: 7
    };

    expect(
      sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: 'node-a',
        inactiveDays: 60,
        sequence: 7
      })
    ).toBe(true);
    expect(
      sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: 'node-b',
        inactiveDays: 60,
        sequence: 7
      })
    ).toBe(false);
    expect(
      sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: 'node-a',
        inactiveDays: 30,
        sequence: 7
      })
    ).toBe(false);
    expect(
      sameConversationHostingMaintenanceContext(requestContext, {
        nodeId: 'node-a',
        inactiveDays: 60,
        sequence: 8
      })
    ).toBe(false);
  });

  it('loads aggregate storage and forwards strict preview and cleanup thresholds', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      void init;
      if (path.endsWith('/storage'))
        return {
          storage: {
            hostedStorageUsedBytes: 4_096,
            filesystemTotalBytes: 100_000,
            filesystemAvailableBytes: 10_000,
            filesystemUsageBasisPoints: 9_000,
            capacity: 'HIGH',
            acceptsNewConversations: true,
            automaticCleanupInactiveDays: 60,
            measuredAt: 1_000
          }
        };
      if (path.endsWith('/preview'))
        return {
          preview: {
            inactiveDays: 60,
            cutoffAt: 1_000,
            candidateConversationCount: 2,
            reclaimableBytes: 8_192,
            measuredAt: 2_000
          }
        };
      return {
        result: {
          inactiveDays: 60,
          cutoffAt: 1_000,
          deletedConversationCount: 1,
          releasedBytes: 4_096,
          skippedConversationCount: 1,
          completedAt: 3_000
        }
      };
    });
    const service = createConversationHostingMaintenanceService(
      async <T>(path: string, init?: RequestInit) => {
        const response = init === undefined ? await request(path) : await request(path, init);
        return response as T;
      }
    );

    await expect(service.storage('node/1')).resolves.toMatchObject({ capacity: 'HIGH' });
    await expect(service.preview('node/1', 60)).resolves.toMatchObject({
      candidateConversationCount: 2
    });
    await expect(service.execute('node/1', 60)).resolves.toMatchObject({
      deletedConversationCount: 1,
      skippedConversationCount: 1
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/api/management/nodes/node%2F1/conversation-hosting/storage'
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/api/management/nodes/node%2F1/conversation-hosting/cleanup/preview',
      { method: 'POST', body: JSON.stringify({ inactiveDays: 60 }) }
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/api/management/nodes/node%2F1/conversation-hosting/cleanup',
      { method: 'POST', body: JSON.stringify({ inactiveDays: 60 }) }
    );
  });

  it('rejects invalid aggregate responses instead of rendering guessed maintenance state', async () => {
    const service = createConversationHostingMaintenanceService(
      async <T>(): Promise<T> => ({ storage: { capacity: 'FULL' } }) as T
    );
    await expect(service.storage('node-1')).rejects.toThrow(
      'CONVERSATION_HOSTING_MAINTENANCE_RESPONSE_INVALID'
    );
  });
});
