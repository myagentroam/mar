import { describe, expect, it, vi } from 'vitest';
import { prepareSessionExecutionContext } from '../../src/session-execution-context.js';
import { GitExecutionForwarding } from '../../src/git-execution-forwarding.js';

describe('shared execution preparation', () => {
  it('loads current user resources and the same Git configuration as manual forwarding', async () => {
    let revision = 1;
    const getRuntime = vi.fn(async (userId: number) => ({
      credentials: [
        {
          id: `git-${revision}`,
          name: 'Git',
          protocol: 'HTTPS' as const,
          host: 'git.example.test',
          port: 443,
          pathPrefix: '',
          username: `user-${userId}`,
          commitName: 'Test User',
          commitEmail: 'test@example.test',
          secret: `secret-${revision}`
        }
      ]
    }));
    const resolve = vi.fn(async () => ({ RESOURCE_SECRET: `resource-${revision}` }));
    const environment = vi.fn(async () => ({ MAR_CTL_USER_TOKEN: `delegation-${revision}` }));
    const get = vi.fn(async () => `instructions-${revision}`);
    const runtimeForUser = vi.fn(async (_userId: number, modelId: string) => ({
      id: modelId,
      credential: `model-${revision}`
    }));
    const options = {
      user: { userId: 7 },
      nodeId: 'node',
      workspaceId: 'workspace',
      serverUrl: 'https://server.example.test',
      secrets: { resolve },
      credentials: { environment } as never,
      instructions: { get },
      git: { getRuntime },
      model: {
        sessionId: 'session',
        selectedModelId: 'selected',
        marAgentModels: {
          runtimeForUser,
          runtimeConfigurationsForUser: async () => []
        }
      }
    };
    const first = await prepareSessionExecutionContext(options);
    revision++;
    const second = await prepareSessionExecutionContext(options);
    expect(first.secretEnvironment).toMatchObject({ RESOURCE_SECRET: 'resource-1' });
    expect(second).toMatchObject({
      secretEnvironment: { RESOURCE_SECRET: 'resource-2', MAR_CTL_USER_TOKEN: 'delegation-2' },
      personalInstructions: 'instructions-2',
      marAgentModel: { id: 'selected', credential: 'model-2' },
      gitConfiguration: { credentials: [{ id: 'git-2', secret: 'secret-2' }] }
    });
    expect(resolve).toHaveBeenLastCalledWith(7, 'node', 'workspace');
    expect(get).toHaveBeenLastCalledWith(7);
    expect(runtimeForUser).toHaveBeenLastCalledWith(7, 'selected');
    expect(environment).toHaveBeenLastCalledWith(
      { userId: 7 },
      options.serverUrl,
      { nodeId: 'node', workspaceId: 'workspace' },
      { type: 'delegation' },
      undefined
    );
    const forwarding = new GitExecutionForwarding({ getRuntime });
    expect(
      await forwarding.prepare('node', 'session.message', { sessionId: 'session' }, 7)
    ).toEqual({ sessionId: 'session', gitConfiguration: second.gitConfiguration });
  });

  it('does not substitute old resources when current preparation is denied', async () => {
    const getRuntime = vi.fn();
    await expect(
      prepareSessionExecutionContext({
        user: { userId: 7 },
        nodeId: 'node',
        workspaceId: 'workspace',
        serverUrl: undefined,
        secrets: {
          resolve: async () => {
            throw new Error('RESOURCE_ACCESS_DENIED');
          }
        },
        credentials: undefined,
        instructions: undefined,
        git: { getRuntime }
      })
    ).rejects.toThrow('RESOURCE_ACCESS_DENIED');
    expect(getRuntime).not.toHaveBeenCalled();
  });
});
