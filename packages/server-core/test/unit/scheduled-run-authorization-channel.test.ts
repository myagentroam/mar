import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import {
  resolveScheduledRunAuthorization,
  resolveRestartRunAuthorization
} from '../../src/scheduled-run-authorization-channel.js';

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
  it('authorizes a MAR Agent restart with its own request identity and preserves denial codes', async () => {
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
    await resolveRestartRunAuthorization({
      nodeId: 'node',
      envelope: createEnvelope('restart.authorize', restart),
      isCurrentConnection: () => true,
      authorize,
      respond
    });
    expect(authorize).toHaveBeenCalledWith('node', restart);
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'WORKSPACE_ACCESS_DENIED' })
    });
    for (const runner of ['codex', 'claude-code', 'opencode']) {
      authorize.mockClear();
      await resolveRestartRunAuthorization({
        nodeId: 'node',
        envelope: createEnvelope('restart.authorize', { ...restart, runner }),
        isCurrentConnection: () => true,
        authorize,
        respond
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith({
        error: expect.objectContaining({ code: 'RESTART_AUTH_REQUEST_INVALID' })
      });
    }
  });

  it('never releases fresh restart credentials to a superseded Node connection', async () => {
    let current = true;
    const respond = vi.fn();
    await resolveRestartRunAuthorization({
      nodeId: 'node',
      envelope: createEnvelope('restart.authorize', {
        handoffId: 'handoff',
        ownerUserId: 7,
        workspaceId: 'workspace',
        sessionId: 'session',
        runner: 'mar-agent',
        modelId: 'model'
      }),
      isCurrentConnection: () => current,
      respond,
      authorize: async () => {
        current = false;
        return { secretEnvironment: { SECRET: 'private-value' } };
      }
    });
    expect(respond).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'RESTART_SERVER_UNAVAILABLE' })
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
