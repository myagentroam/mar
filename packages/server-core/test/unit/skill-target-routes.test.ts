import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSkillTargetRoutes } from '../../src/skill-target-routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const app = Fastify();
  apps.push(app);
  const resources = {
    assertCanUseWorkspace: vi.fn(async () => undefined),
    assertCanManageWorkspace: vi.fn(async () => undefined),
    assertCanManageNode: vi.fn(async () => undefined)
  };
  const requestNode = vi.fn(async (_nodeId: string, operation: string, input: unknown) => {
    const data = input as { includeClaudeCompatibility?: boolean };
    const canonical = { name: 'review', description: operation, localStatus: 'UNKNOWN_VERSION' };
    return {
      skills:
        operation === 'workspace.skills.inspect' && data.includeClaudeCompatibility !== false
          ? [canonical, { name: 'claude-only', localStatus: 'PARTIAL' }]
          : [canonical]
    };
  });
  registerSkillTargetRoutes({
    app,
    database: {
      findCurrentUserSession: () => ({
        userId: 7,
        username: 'Owner',
        isAdmin: false,
        sessionHash: 'session-hash',
        mustChangePassword: false,
        csrfTokenHash: 'csrf-hash'
      }),
      authenticateNode: () => undefined
    },
    nodeControl: { requestNode },
    resources,
    favorites: {} as never,
    artifacts: {} as never,
    publicOrigin: undefined
  });
  await app.ready();
  return { app, resources, requestNode };
}

describe('Workspace Skill target routes', () => {
  it('requests only canonical skills for Loaded Skills and Composer, preserving Workspace precedence', async () => {
    const f = await fixture();
    const result = await f.app.inject({
      url: '/api/workspaces/workspace-one/effective-skills?nodeId=node-one',
      headers: { cookie: 'mar_user_session=test-session' }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      skills: [
        {
          name: 'review',
          description: 'workspace.skills.inspect',
          localStatus: 'UNKNOWN_VERSION',
          source: 'WORKSPACE'
        }
      ]
    });
    expect(f.resources.assertCanUseWorkspace).toHaveBeenCalledWith(7, 'node-one', 'workspace-one');
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-one',
      'node.skills.inspect',
      {},
      { userId: 7, sessionHash: 'session-hash' },
      undefined
    );
    expect(f.requestNode).toHaveBeenCalledWith(
      'node-one',
      'workspace.skills.inspect',
      { workspaceId: 'workspace-one', includeClaudeCompatibility: false },
      { userId: 7, sessionHash: 'session-hash', workspaceId: 'workspace-one' },
      undefined
    );
    expect(f.resources.assertCanManageWorkspace).not.toHaveBeenCalled();
  });

  it('keeps compatibility inspection in the separate management route', async () => {
    const f = await fixture();
    const result = await f.app.inject({
      url: '/api/workspaces/workspace-one/skills?nodeId=node-one',
      headers: { cookie: 'mar_user_session=test-session' }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().skills).toContainEqual({ name: 'claude-only', localStatus: 'PARTIAL' });
    expect(f.resources.assertCanManageWorkspace).toHaveBeenCalledWith(
      7,
      'node-one',
      'workspace-one'
    );
  });
});
