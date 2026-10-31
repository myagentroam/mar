import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import * as authorization from '../../src/scheduled-run-authorization-channel.js';
const { resolveScheduledRunAuthorization } = authorization;

describe('execution preparation channel', () => {
  const execution = {
    userId: 7,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    runner: 'mar-agent' as const,
    modelId: 'selected'
  };
  it('passes only business identifiers from the authenticated Node to preparation', async () => {
    const context = { secretEnvironment: { FRESH: 'current-secret' } };
    const authorize = vi.fn(async () => context);
    const respond = vi.fn();
    await authorization.resolveExecutionPreparation({
      nodeId: 'authenticated-node',
      envelope: createEnvelope('execution.prepare', execution),
      isCurrentConnection: () => true,
      authorize,
      respond
    });
    expect(authorize).toHaveBeenCalledWith('authenticated-node', execution);
    expect(respond).toHaveBeenCalledWith({ context });
  });
  it.each(['revoked', 'replaced', 'malformed'] as const)(
    'does not release resources for %s execution',
    async (mode) => {
      let current = true;
      const authorize = vi.fn(async () => {
        if (mode === 'revoked') throw new Error('WORKSPACE_ACCESS_DENIED');
        current = false;
        return { secretEnvironment: { FRESH: 'private-secret' } };
      });
      const respond = vi.fn();
      await authorization.resolveExecutionPreparation({
        nodeId: 'node',
        envelope: createEnvelope(
          'execution.prepare',
          mode === 'malformed'
            ? { ...execution, secretEnvironment: { OLD: 'do-not-accept' } }
            : execution
        ),
        isCurrentConnection: () => current,
        authorize,
        respond
      });
      const code =
        mode === 'revoked'
          ? 'WORKSPACE_ACCESS_DENIED'
          : mode === 'replaced'
            ? 'EXECUTION_SERVER_UNAVAILABLE'
            : 'EXECUTION_AUTH_REQUEST_INVALID';
      expect(respond).toHaveBeenCalledWith({ error: expect.objectContaining({ code }) });
      expect(JSON.stringify(respond.mock.calls)).not.toContain('private-secret');
      if (mode === 'malformed') expect(authorize).not.toHaveBeenCalled();
    }
  );
});

const request = {
  taskId: 'task-1',
  revision: 1,
  occurrenceId: 'task-1:1000',
  ownerUserId: 7,
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  runner: 'codex' as const,
  modelId: null
};

describe('scheduled run authorization channel', () => {
  it('does not expose a dedicated restart authorization API or accept its retired request', async () => {
    expect(authorization).not.toHaveProperty('resolveRestartRunAuthorization');
    const restart = {
      handoffId: 'handoff',
      ownerUserId: 7,
      workspaceId: 'workspace',
      sessionId: 'session',
      runner: 'mar-agent',
      modelId: 'model'
    };
    const authorize = vi.fn(async () => {
      throw new Error('WORKSPACE_ACCESS_DENIED');
    });
    const respond = vi.fn();
    await resolveScheduledRunAuthorization({
      nodeId: 'node',
      envelope: createEnvelope('restart.authorize', restart),
      isCurrentConnection: () => true,
      authorize,
      respond
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'SCHEDULE_AUTH_REQUEST_INVALID' })
    });
    for (const runner of ['codex', 'claude-code', 'opencode']) {
      authorize.mockClear();
      await resolveScheduledRunAuthorization({
        nodeId: 'node',
        envelope: createEnvelope('restart.authorize', { ...restart, runner }),
        isCurrentConnection: () => true,
        authorize,
        respond
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith({
        error: expect.objectContaining({ code: 'SCHEDULE_AUTH_REQUEST_INVALID' })
      });
    }
  });

  it('never releases scheduled credentials to a superseded Node connection', async () => {
    let current = true;
    const respond = vi.fn();
    await resolveScheduledRunAuthorization({
      nodeId: 'node',
      envelope: createEnvelope('schedule.authorize', request),
      isCurrentConnection: () => current,
      respond,
      authorize: async () => {
        current = false;
        return { secretEnvironment: { SECRET: 'private-value' } };
      }
    });
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'SCHEDULE_SERVER_UNAVAILABLE' })
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain('private-value');
  });
  it('returns authorized context only while the authenticated Node connection remains current', async () => {
    const respond = vi.fn();
    let current = true;
    const authorize = vi.fn(async () => {
      current = false;
      return { secretEnvironment: { TOKEN: 'secret' } };
    });
    await resolveScheduledRunAuthorization({
      nodeId: 'node-1',
      envelope: createEnvelope('schedule.authorize', request),
      isCurrentConnection: () => current,
      authorize,
      respond
    });
    expect(authorize).toHaveBeenCalledWith('node-1', request);
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'SCHEDULE_SERVER_UNAVAILABLE' })
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain('secret');
  });

  it('rejects malformed requests before authorization', async () => {
    const authorize = vi.fn();
    const respond = vi.fn();
    await resolveScheduledRunAuthorization({
      nodeId: 'node-1',
      envelope: createEnvelope('schedule.authorize', { ...request, ownerUserId: -1 }),
      isCurrentConnection: () => true,
      authorize,
      respond
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'SCHEDULE_AUTH_REQUEST_INVALID' })
    });
  });
});
