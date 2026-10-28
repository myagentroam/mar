import Fastify from '../../ee/server/node_modules/fastify/fastify.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceOwnership } from '../../packages/protocol/src/index.js';
import { hashOpaque } from '../../ee/server/src/database.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import type { NodeControl } from '../../ee/server/src/node-control.js';
import type { ResourceAccessService } from '../../ee/server/src/rbac/resource-access-service.js';
import { registerManagementRoutes } from '../../ee/server/src/route/management-routes.js';
import type { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.js';
import { ServerTrafficMetrics } from '../../ee/server/src/service/server-traffic-metrics.js';

const csrfToken = 'csrf-token';
const headers = {
  cookie: 'mar_user_session=session-id',
  'x-csrf-token': csrfToken
};
const metrics: ServerTrafficMetrics[] = [];

afterEach(() => {
  for (const metric of metrics.splice(0)) metric.close();
});

describe('Server conversation hosting maintenance routes', () => {
  it('relays Computer Use enablement and disablement as fixed Node operations', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const enable = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/computer-use/enable',
      headers,
      payload: { enabled: true }
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ capability: { state: 'INITIALIZING', enabled: true } });
    expect(fixture.nodeControl.requestNode).toHaveBeenLastCalledWith(
      'node-1',
      'computer.use.enable',
      { enabled: true },
      expect.objectContaining({ userId: 1, sessionHash: 'admin-session' }),
      undefined
    );

    const disable = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/computer-use/disable',
      headers,
      payload: {}
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ capability: { state: 'DISABLED', enabled: false } });
    expect(fixture.nodeControl.requestNode).toHaveBeenLastCalledWith(
      'node-1',
      'computer.use.disable',
      {},
      expect.objectContaining({ userId: 1, sessionHash: 'admin-session' }),
      undefined
    );
    await app.close();
  });

  it('forwards strict enablement and aggregate maintenance inputs to the online Node', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const enable = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ capability: { state: 'AVAILABLE' } });
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'conversation.hosting.enable',
      { enabled: true },
      expect.objectContaining({ userId: 1, sessionHash: 'admin-session' }),
      undefined
    );

    const storage = await app.inject({
      method: 'GET',
      url: '/api/management/nodes/node-1/conversation-hosting/storage',
      headers
    });
    expect(storage.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'conversation.hosting.storage.inspect',
      {},
      expect.objectContaining({ userId: 1, sessionHash: 'admin-session' }),
      undefined
    );

    const preview = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/cleanup/preview',
      headers,
      payload: { inactiveDays: 60 }
    });
    expect(preview.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      3,
      'node-1',
      'conversation.hosting.cleanup.preview',
      { inactiveDays: 60 },
      expect.objectContaining({ userId: 1 }),
      undefined
    );

    const execute = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/cleanup',
      headers,
      payload: { inactiveDays: 30 }
    });
    expect(execute.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenNthCalledWith(
      4,
      'node-1',
      'conversation.hosting.cleanup.execute',
      { inactiveDays: 30 },
      expect.objectContaining({ userId: 1 }),
      undefined
    );
  });

  it('preserves successful storage and preview results when audit persistence fails', async () => {
    const fixture = routeFixture();
    const audit = vi.spyOn(fixture.database, 'audit').mockRejectedValue(new Error('audit failed'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });
    try {
      const storage = await app.inject({
        method: 'GET',
        url: '/api/management/nodes/node-1/conversation-hosting/storage',
        headers
      });
      const preview = await app.inject({
        method: 'POST',
        url: '/api/management/nodes/node-1/conversation-hosting/cleanup/preview',
        headers,
        payload: { inactiveDays: 60 }
      });
      expect(storage.statusCode).toBe(200);
      expect(storage.json()).toMatchObject({ storage: { hostedStorageUsedBytes: 4096 } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ preview: { candidateConversationCount: 2 } });
      expect(audit).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith('AUDIT_WRITE_FAILED');
    } finally {
      warning.mockRestore();
      await app.close();
    }
  });

  it('returns the created user and temporary password even when audit persistence fails', async () => {
    const fixture = routeFixture();
    const audit = vi.spyOn(fixture.database, 'audit').mockRejectedValue(new Error('audit failed'));
    const createUser = vi.fn(async () => 9);
    Object.assign(fixture.database, {
      createUser,
      listUsers: vi.fn(async () => [{ id: 9, username: 'new-user' }])
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/management/users',
        headers,
        payload: { username: 'new-user' }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        user: { id: 9, username: 'new-user' },
        temporaryPassword: expect.any(String)
      });
      expect(createUser).toHaveBeenCalledOnce();
      expect(audit).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith('AUDIT_WRITE_FAILED');
    } finally {
      warning.mockRestore();
      await app.close();
    }
  });

  it('forwards strict disablement after unified admission and preserves active-Run conflicts', async () => {
    const fixture = routeFixture();
    fixture.ownership.value = { ownerType: 'PERSONAL', ownerUserId: 1 };
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const disable = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/disable',
      headers,
      payload: {}
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ capability: { state: 'DISABLED' } });
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledWith(
      'node-1',
      'conversation.hosting.disable',
      {},
      expect.objectContaining({ userId: 1, sessionHash: 'admin-session' }),
      undefined
    );

    fixture.nodes[0]!.metadata = nodeMetadata({ nodeAppVersion: 'unknown' });
    const withoutVersion = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/disable',
      headers,
      payload: {}
    });
    expect(withoutVersion.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledTimes(2);

    fixture.nodes[0]!.metadata = nodeMetadata();
    fixture.nodeControl.requestNode.mockRejectedValueOnce(
      new Error('CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS')
    );
    const activeRuns = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/disable',
      headers,
      payload: {}
    });
    expect(activeRuns.statusCode).toBe(409);
    expect(activeRuns.json()).toMatchObject({
      error: { code: 'CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS' }
    });
  });

  it('rejects invalid, personal, non-Linux, and offline enablement before Node dispatch', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: false }
    });
    expect(invalid.statusCode).toBe(400);

    fixture.ownership.value = { ownerType: 'PERSONAL', ownerUserId: 1 };
    const personal = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(personal.statusCode).toBe(409);
    expect(personal.json()).toMatchObject({
      error: { code: 'CONVERSATION_HOSTING_ENABLE_ORGANIZATION_NODE_REQUIRED' }
    });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
    fixture.ownership.value = { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 };

    fixture.nodes[0]!.metadata = nodeMetadata({ nodeAppVersion: 'unknown' });
    const withoutVersion = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(withoutVersion.statusCode).toBe(200);
    expect(fixture.nodeControl.requestNode).toHaveBeenCalledOnce();
    fixture.nodeControl.requestNode.mockClear();

    fixture.nodes[0]!.metadata = nodeMetadata({ platform: 'windows' });
    const windows = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(windows.statusCode).toBe(409);
    expect(windows.json()).toMatchObject({
      error: { code: 'CONVERSATION_HOSTING_ENABLE_PLATFORM_UNSUPPORTED' }
    });

    fixture.nodes[0]!.metadata = nodeMetadata();
    fixture.nodes[0]!.connected = false;
    const offline = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ error: { code: 'NODE_OFFLINE' } });

    fixture.nodes[0]!.connected = true;
    fixture.nodes[0]!.disabled = true;
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ error: { code: 'NODE_OFFLINE' } });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
  });

  it('rejects invalid thresholds and offline Nodes before dispatching cleanup', async () => {
    const fixture = routeFixture();
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/cleanup/preview',
      headers,
      payload: { inactiveDays: 0, conversationIds: ['conversation-1'] }
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();

    fixture.nodes[0]!.connected = false;
    const offline = await app.inject({
      method: 'GET',
      url: '/api/management/nodes/node-1/conversation-hosting/storage',
      headers
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ error: { code: 'NODE_OFFLINE' } });
    expect(fixture.nodeControl.requestNode).not.toHaveBeenCalled();
  });

  it('rejects malformed or non-aggregate Node maintenance responses', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestNode.mockResolvedValueOnce({
      storage: {
        hostedStorageUsedBytes: 4_096,
        filesystemTotalBytes: 100_000,
        filesystemAvailableBytes: 20_000,
        filesystemUsageBasisPoints: 8_000,
        capacity: 'AVAILABLE',
        acceptsNewConversations: true,
        automaticCleanupInactiveDays: 60,
        measuredAt: 1_000,
        physicalPath: '/private/hosted-conversations'
      }
    });
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/management/nodes/node-1/conversation-hosting/storage',
      headers
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'CONVERSATION_HOSTING_MAINTENANCE_RESPONSE_INVALID' }
    });
  });

  it('rejects an invalid Node enablement response', async () => {
    const fixture = routeFixture();
    fixture.nodeControl.requestNode.mockResolvedValueOnce({
      capability: { state: 'AVAILABLE' }
    });
    const app = Fastify();
    registerManagementRoutes({
      app,
      database: fixture.database,
      nodeControl: fixture.nodeControl,
      nodeUpgrades: fixture.nodeUpgrades,
      resources: fixture.resources,
      users: {
        list: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        },
        deletionSummary: async () => {
          throw new Error('UNEXPECTED_USER_QUERY');
        }
      },
      directory: {
        listManagedResourcePage: async () => {
          throw new Error('UNEXPECTED_DIRECTORY_QUERY');
        }
      },
      traffic: fixture.traffic,
      publicOrigin: undefined
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/management/nodes/node-1/conversation-hosting/enable',
      headers,
      payload: { enabled: true }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'CONVERSATION_HOSTING_ENABLE_RESPONSE_INVALID' }
    });
  });
});

function routeFixture() {
  const database = {
    findCurrentUserSession: vi.fn(() => ({
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'admin-session',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque(csrfToken)
    })),
    audit: vi.fn(async () => undefined)
  } as unknown as MysqlServerDatabase;
  const nodes = [
    {
      id: 'node-1',
      ownerUserId: 1,
      connected: true,
      disabled: false,
      metadata: nodeMetadata()
    }
  ];
  const nodeControl = {
    listNodes: vi.fn(async () => nodes),
    requestNode: vi.fn(async (_nodeId: string, operation: string) => {
      if (operation === 'computer.use.enable')
        return {
          capability: {
            apiVersion: 1,
            enabled: true,
            state: 'INITIALIZING',
            backend: 'PYAUTOGUI',
            supportsScreenshot: false,
            supportsInput: false,
            supportsUnicodePaste: false,
            supportsPrimaryDisplay: false,
            measuredAt: 1_000
          }
        };
      if (operation === 'computer.use.disable')
        return {
          capability: {
            apiVersion: 1,
            enabled: false,
            state: 'DISABLED',
            backend: 'PYAUTOGUI',
            supportsScreenshot: false,
            supportsInput: false,
            supportsUnicodePaste: false,
            supportsPrimaryDisplay: false,
            measuredAt: 2_000
          }
        };
      if (operation === 'conversation.hosting.enable')
        return {
          capability: {
            state: 'AVAILABLE',
            apiVersion: 1,
            sandboxBackend: 'BUBBLEWRAP',
            sandboxPolicyVersion: 1,
            acceptsNewConversations: true,
            supportsExistingConversations: true,
            capacity: 'AVAILABLE'
          }
        };
      if (operation === 'conversation.hosting.disable')
        return {
          capability: {
            state: 'DISABLED',
            apiVersion: 1,
            acceptsNewConversations: false,
            supportsExistingConversations: false,
            capacity: 'AVAILABLE'
          }
        };
      if (operation === 'conversation.hosting.storage.inspect')
        return {
          storage: {
            hostedStorageUsedBytes: 4_096,
            filesystemTotalBytes: 100_000,
            filesystemAvailableBytes: 20_000,
            filesystemUsageBasisPoints: 8_000,
            capacity: 'AVAILABLE',
            acceptsNewConversations: true,
            automaticCleanupInactiveDays: 60,
            measuredAt: 1_000
          }
        };
      if (operation === 'conversation.hosting.cleanup.preview')
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
          inactiveDays: 30,
          cutoffAt: 1_000,
          deletedConversationCount: 2,
          releasedBytes: 8_192,
          skippedConversationCount: 0,
          completedAt: 3_000
        }
      };
    })
  } as unknown as NodeControl & {
    listNodes: ReturnType<typeof vi.fn>;
    requestNode: ReturnType<typeof vi.fn>;
  };
  const ownership: { value: ResourceOwnership } = {
    value: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
  };
  const resources = {
    nodeOwnership: vi.fn(async () => ownership.value),
    assertCanHostConversationTemplate: vi.fn(async () => {
      if (ownership.value.ownerType !== 'ORGANIZATION')
        throw new Error('CONVERSATION_TEMPLATE_HOST_NODE_INVALID');
    })
  } as unknown as Pick<
    ResourceAccessService,
    'nodeOwnership' | 'assertCanHostConversationTemplate'
  >;
  const nodeUpgrades = {
    availability: vi.fn()
  } as unknown as NodeUpgradeService;
  const traffic = new ServerTrafficMetrics();
  metrics.push(traffic);
  return { database, nodes, nodeControl, nodeUpgrades, ownership, resources, traffic };
}

function nodeMetadata(
  overrides: { readonly platform?: 'linux' | 'windows'; readonly nodeAppVersion?: string } = {}
): string {
  return JSON.stringify({
    platform: overrides.platform ?? 'linux',
    architecture: 'x64',
    nodeAppVersion: overrides.nodeAppVersion ?? '0.9.37',
    nodeVersion: process.version,
    computerUse: {
      apiVersion: 1,
      enabled: false,
      state: 'DISABLED',
      backend: 'PYAUTOGUI',
      supportsScreenshot: false,
      supportsInput: false,
      supportsUnicodePaste: false,
      supportsPrimaryDisplay: false,
      measuredAt: 1
    }
  });
}
