import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpService } from '../../src/mcp-service.js';
import { registerMcpRoutes } from '../../src/mcp-routes.js';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { hashOpaque } from '../../src/session-token.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe('MCP installation routes', () => {
  it('waits past the former 15-second boundary for Workspace MCP installation', async () => {
    vi.useFakeTimers();
    const app = Fastify();
    apps.push(app);
    const session = {
      userId: 1,
      username: 'admin',
      isAdmin: true,
      sessionHash: 'session-hash',
      mustChangePassword: false,
      csrfTokenHash: hashOpaque('csrf')
    };
    const entry = {
      id: 'fixture',
      sourceId: 'official',
      scope: 'ENTERPRISE',
      serverName: 'fixture',
      displayName: 'Fixture',
      description: 'Fixture',
      version: '1.0.0',
      featured: false,
      tags: [],
      runtime: { transport: 'STDIO', command: 'fixture', args: [] },
      createdAt: 1,
      updatedAt: 1
    } as const;
    const requestNode = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ installations: [] }), 15_001))
    );
    registerMcpRoutes({
      app,
      database: { findCurrentUserSession: (id) => (id === 'session' ? session : undefined) },
      service: { getVisibleCatalog: vi.fn(async () => entry) } as unknown as McpService,
      nodeControl: { requestNode },
      secrets: { resolve: vi.fn(async () => ({})) },
      publicOrigin: 'http://localhost'
    });

    const response = app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/mcps?nodeId=node-1',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=session`,
        origin: 'http://localhost',
        'x-csrf-token': 'csrf'
      },
      payload: { catalogEntryId: 'fixture' }
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(response).resolves.toMatchObject({ statusCode: 200 });
    expect(requestNode).toHaveBeenCalledWith(
      'node-1',
      'workspace.mcps.install',
      expect.objectContaining({ workspaceId: 'workspace-1', entry }),
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      300_000
    );
  });
});
