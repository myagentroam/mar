import { describe, expect, it, vi } from 'vitest';
import { GitExecutionForwarding } from '../../src/git-execution-forwarding.js';
import { workbenchNodeOperationSchema } from '@myagentroam/protocol';

const configuration = {
  credentials: [
    {
      id: 'credential',
      name: 'credential',
      protocol: 'HTTPS' as const,
      host: 'git.example.test',
      port: 443,
      pathPrefix: '',
      username: 'alice',
      commitName: 'Alice',
      commitEmail: 'alice@example.test',
      secret: 'test-only-password'
    }
  ]
};

describe('Authenticated Git forwarding', () => {
  it('injects the actor configuration into current changes, diff and restore operations', async () => {
    const forwarding = new GitExecutionForwarding({ getRuntime: async () => configuration });
    for (const operation of [
      'workspace.changes.current',
      'workspace.git.fetch',
      'workspace.change.diff',
      'workspace.change.restore'
    ]) {
      expect(workbenchNodeOperationSchema.parse(operation)).toBe(operation);
      expect(await forwarding.prepare('node', operation, { workspaceId: 'workspace' }, 7)).toEqual({
        workspaceId: 'workspace',
        gitConfiguration: configuration
      });
    }
  });
  it('accepts fixed policy operations without loading or forwarding credentials', async () => {
    const getRuntime = vi.fn();
    const forwarding = new GitExecutionForwarding({ getRuntime });
    for (const operation of ['workspace.git.settings.get', 'workspace.git.settings.update']) {
      expect(workbenchNodeOperationSchema.parse(operation)).toBe(operation);
      expect(
        await forwarding.prepare(
          'node',
          operation,
          {
            workspaceId: 'workspace',
            gitConfiguration: 'forged'
          },
          7
        )
      ).toEqual({ workspaceId: 'workspace' });
    }
    expect(getRuntime).not.toHaveBeenCalled();
  });
  it('reads only the actor configuration on supported execution operations', async () => {
    const getRuntime = vi.fn(async () => configuration);
    const forwarding = new GitExecutionForwarding({ getRuntime });
    expect(
      await forwarding.prepare('node', 'terminal.open', { gitConfiguration: { userId: 9 } }, 7)
    ).toEqual({ gitConfiguration: configuration });
    expect(getRuntime).toHaveBeenCalledWith(7);
    expect(
      await forwarding.prepare(
        'node',
        'conversation.hosted.message',
        { gitConfiguration: configuration },
        7
      )
    ).toEqual({});
    expect(getRuntime).toHaveBeenCalledTimes(1);
  });
  it('does not infer Git capability from Node application version', async () => {
    const getRuntime = vi.fn(async () => configuration);
    const forwarding = new GitExecutionForwarding({ getRuntime });
    expect(await forwarding.prepare('node', 'session.message', {}, 1)).toEqual({
      gitConfiguration: configuration
    });
    expect(
      await forwarding.prepare('node', 'workspace.register', { preserveGitConfig: true }, 1)
    ).toEqual({ preserveGitConfig: true });
    expect(getRuntime).toHaveBeenCalledTimes(1);
  });
});
