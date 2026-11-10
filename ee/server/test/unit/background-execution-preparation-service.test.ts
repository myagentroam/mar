import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutionPreparationService } from '../../src/service/background-execution-preparation-service.js';

function fixture(searchBackendAvailable?: () => boolean) {
  const authorize = vi.fn(async () => true);
  const resolve = vi.fn(async () => ({ FRESH: 'current', MAR_USERNAME: 'member' }));
  const getInstructions = vi.fn(async () => ({ text: 'personal' }));
  const prepareModel = vi.fn(async () => ({ runtimeScopeId: 'scope', models: [] }));
  const issue = vi.fn(() => ({
    scopeId: '11111111-1111-4111-8111-111111111111',
    token: 'usage-token'
  }));
  const git = {
    credentials: [
      {
        id: 'git',
        name: 'fixture',
        protocol: 'HTTPS' as const,
        host: 'git.example.test',
        port: 443,
        pathPrefix: '',
        username: 'member',
        secret: 'fixture-token',
        commitName: '',
        commitEmail: ''
      }
    ]
  };
  const service = new BackgroundExecutionPreparationService({
    ...(searchBackendAvailable === undefined ? {} : { searchBackendAvailable }),
    authorize,
    secrets: { resolve },
    credentials: undefined,
    serverUrl: undefined,
    instructions: { get: getInstructions },
    git: { getRuntime: async () => git },
    runtimeModels: { prepare: prepareModel },
    usageGrants: { issue }
  });
  const request = {
    userId: 7,
    workspaceId: 'workspace',
    sessionId: 'session',
    runner: 'mar-agent' as const,
    modelId: 'selected'
  };
  const schedule = {
    executionResources: 1 as const,
    taskId: 'task',
    revision: 2,
    occurrenceId: 'occurrence',
    ownerUserId: 7,
    workspaceId: 'workspace',
    sessionId: 'session',
    runner: 'mar-agent' as const,
    modelId: 'selected'
  };
  return {
    service,
    authorize,
    resolve,
    getInstructions,
    prepareModel,
    issue,
    request,
    schedule,
    git
  };
}

describe('background execution preparation', () => {
  it('uses the same authorized preparation for execution and schedule requests', async () => {
    const f = fixture();
    const execution = await f.service.prepare('node', f.request);
    const schedule = await f.service.prepareSchedule('node', f.schedule);
    expect(schedule).toEqual(execution);
    expect(execution).toMatchObject({
      secretEnvironment: { FRESH: 'current', MAR_USERNAME: '' },
      personalInstructions: { text: 'personal' },
      marAgentRuntimeScopeId: 'scope',
      usageGrant: { scopeId: '11111111-1111-4111-8111-111111111111', token: 'usage-token' }
    });
    expect(f.authorize).toHaveBeenCalledWith(
      7,
      'node',
      'session.message',
      { workspaceId: 'workspace', sessionId: 'session' },
      'workspace'
    );
    expect(f.resolve).toHaveBeenCalledWith(7, 'node', 'workspace');
    expect(f.prepareModel).toHaveBeenCalledWith({
      userId: 7,
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session',
      selectedModelId: 'selected'
    });
    expect(f.issue).toHaveBeenCalledWith('node', 7, 'work');
  });

  it('projects search availability to both background preparation paths', async () => {
    const f = fixture(() => false);
    expect(await f.service.prepare('node', f.request)).toMatchObject({
      searchBackendAvailable: false
    });
    expect(await f.service.prepareSchedule('node', f.schedule)).toMatchObject({
      searchBackendAvailable: false
    });
  });

  it('denies access before reading execution resources or issuing a grant', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    await expect(f.service.prepare('node', f.request)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.getInstructions).not.toHaveBeenCalled();
    expect(f.prepareModel).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('keeps Git configuration out of legacy schedule responses', async () => {
    const f = fixture();
    expect(await f.service.prepareSchedule('node', f.schedule)).toHaveProperty(
      'gitConfiguration',
      f.git
    );
    const { executionResources: _version, ...legacy } = f.schedule;
    expect(await f.service.prepareSchedule('node', legacy)).not.toHaveProperty('gitConfiguration');
  });

  it('preserves caller-specific missing-model errors without issuing resources', async () => {
    const f = fixture();
    await expect(f.service.prepare('node', { ...f.request, modelId: null })).rejects.toThrow(
      'EXECUTION_MODEL_UNAVAILABLE'
    );
    await expect(
      f.service.prepareSchedule('node', { ...f.schedule, modelId: null })
    ).rejects.toThrow('SCHEDULE_MODEL_UNAVAILABLE');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('does not load MAR models for other Runners and propagates preparation failures', async () => {
    const f = fixture();
    await expect(
      f.service.prepare('node', { ...f.request, runner: 'codex', modelId: null })
    ).resolves.toMatchObject({ secretEnvironment: { FRESH: 'current' } });
    expect(f.prepareModel).not.toHaveBeenCalled();
    f.issue.mockClear();
    f.resolve.mockRejectedValue(new Error('SECRETS_UNAVAILABLE'));
    await expect(f.service.prepare('node', f.request)).rejects.toThrow('SECRETS_UNAVAILABLE');
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('validates the resulting context before returning it to the Node', async () => {
    const f = fixture();
    f.issue.mockReturnValue({ scopeId: '', token: '' });
    await expect(f.service.prepare('node', f.request)).rejects.toThrow();
  });
});
