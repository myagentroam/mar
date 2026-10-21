import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref as vueRef, shallowRef } from 'vue';
import { createRunnerProfileService } from '../../src/service/RunnerProfileService.js';
import { localePreferenceService, translate } from '../../src/service/LocalePreferenceService.js';
import { localizedRunnerCommandState } from '../../src/util/runner-presentation.js';
import type { RunnerProfile } from '../../src/model/workbench.js';

const codexProfile: RunnerProfile = {
  runner: 'codex',
  models: [
    {
      id: 'gpt-5.6-sol',
      label: 'Sol',
      supportedEfforts: ['low', 'medium'],
      isDefault: true,
      defaultEffort: 'low'
    }
  ],
  accessOptions: [{ id: 'on-request', label: 'On request', description: '' }],
  commands: [],
  capabilities: ['turn.start']
};

const openCodeProfile: RunnerProfile = {
  runner: 'opencode',
  models: [{ id: 'mar/coding-model', label: 'Coding model', supportedEfforts: ['medium'] }],
  accessOptions: [{ id: 'full-access', label: 'Full access', description: '' }],
  commands: [],
  capabilities: ['turn.start']
};

const claudeCodeProfile: RunnerProfile = {
  runner: 'claude-code',
  models: [
    {
      id: 'claude-sonnet-4',
      label: 'Claude Sonnet 4',
      supportedEfforts: ['medium'],
      isDefault: true,
      defaultEffort: 'medium'
    }
  ],
  accessOptions: [{ id: 'default', label: 'Default', description: '' }],
  commands: [],
  capabilities: ['turn.start']
};

const marAgentProfile: RunnerProfile = {
  runner: 'mar-agent',
  models: [
    {
      id: 'dev-coding',
      label: 'coding',
      supportedEfforts: [],
      defaultEffort: 'medium'
    }
  ],
  accessOptions: [{ id: 'full-access', label: 'Full access', description: '' }],
  commands: [],
  capabilities: ['turn.start']
};

function ref<T>(value: T): { value: T } {
  return { value };
}

describe('Runner Profile Domain Service', () => {
  it('retains Auto only when both Node feature and actual profile support it', async () => {
    for (const supportsAuto of [true, false]) {
      const profiles = shallowRef<readonly RunnerProfile[]>([]);
      const service = createRunnerProfileService({
        workspaceTarget: shallowRef({ nodeId: 'node-1', workspaceId: 'workspace-1' }),
        profiles,
        loading: shallowRef(false),
        failed: shallowRef(false),
        supportsAuto: () => supportsAuto,
        request: async () => ({
          profiles: [
            {
              ...marAgentProfile,
              accessOptions: [
                { id: 'auto', label: 'Auto', description: 'Auto' },
                { id: 'full-access', label: 'Full access', description: 'Full access' }
              ]
            }
          ],
          defaults: []
        }),
        notice: vi.fn(),
        errorMessage: String
      });
      await service.load('node-1');
      expect(profiles.value[0]?.accessOptions.some((option) => option.id === 'auto')).toBe(
        supportsAuto
      );
    }
  });
  it('uses Workspace context for reads while preserving the shared Node cache', async () => {
    const selectedNodeId = vueRef('node-a');
    const selectedWorkspaceId = vueRef<string | undefined>('workspace/a');
    const profiles = vueRef<readonly RunnerProfile[]>([]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [codexProfile] })
      .mockResolvedValueOnce({ profiles: [openCodeProfile] });
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
      profiles,
      loading: vueRef(false),
      failed: vueRef(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });
    await service.load('node-a');
    expect(request).toHaveBeenLastCalledWith(
      '/api/runner-profiles?nodeId=node-a&workspaceId=workspace%2Fa&cacheOnly=true'
    );
    selectedWorkspaceId.value = 'workspace-b';
    expect(profiles.value[0]?.runner).toBe('codex');
    expect(service.has('node-a')).toBe(true);
    expect(service.cached('node-a')[0]?.runner).toBe('codex');
    await service.load('node-a');
    expect(profiles.value[0]?.runner).toBe('opencode');
    selectedWorkspaceId.value = 'workspace/a';
    expect(service.has('node-a')).toBe(true);
    expect(profiles.value[0]?.runner).toBe('opencode');
    selectedWorkspaceId.value = undefined;
    expect(profiles.value).toEqual([]);
  });

  it('discards an in-flight profile response after switching Workspaces on the same Node', async () => {
    const selectedWorkspaceId = vueRef<string | undefined>('workspace-a');
    const profiles = vueRef<readonly RunnerProfile[]>([]);
    const loading = vueRef(false);
    let resolveRequest!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(vueRef('node-a'), selectedWorkspaceId),
      profiles,
      loading,
      failed: vueRef(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });
    const pending = service.load('node-a');
    selectedWorkspaceId.value = 'workspace-b';
    expect(loading.value).toBe(false);
    resolveRequest({ profiles: [codexProfile] });
    await expect(pending).resolves.toBeUndefined();
    expect(profiles.value).toEqual([]);
    expect(service.has('node-a')).toBe(false);
  });
  it('Localizes MAR Agent commands and permission options according to the current locale', async () => {
    localePreferenceService().setLocale('zh-CN');
    const profiles = ref<readonly RunnerProfile[]>([]);
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(ref<string>('node-a')),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request: vi.fn(() =>
        Promise.resolve({
          profiles: [
            {
              ...marAgentProfile,
              accessOptions: [
                {
                  id: 'full-access',
                  label: 'Full access',
                  description:
                    'Tools run without per-call Agent approval. Host validation remains active and no Agent sandbox is provided.'
                }
              ],
              commands: [
                {
                  id: 'compact',
                  runner: 'mar-agent',
                  label: '/compact',
                  description: 'Compact the current session context.',
                  inputHint: '/compact',
                  source: 'MAR_RUNTIME',
                  interaction: 'IMMEDIATE_ACTION',
                  available: true,
                  reasonCode: null
                },
                {
                  id: 'plan',
                  runner: 'mar-agent',
                  label: '/plan',
                  description: 'Toggle collaborative Plan Mode.',
                  inputHint: '/plan',
                  source: 'MAR_RUNTIME',
                  interaction: 'TOGGLE',
                  available: true,
                  reasonCode: null
                },
                {
                  id: 'clear',
                  runner: 'mar-agent',
                  label: '/clear',
                  description: 'Permanently clear this session history while keeping the session.',
                  inputHint: '/clear',
                  source: 'MAR_RUNTIME',
                  interaction: 'DESTRUCTIVE_ACTION',
                  available: true,
                  reasonCode: null
                }
              ]
            }
          ],
          defaults: []
        })
      ),
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');
    expect(service.defaultFor('node-a', 'mar-agent')).toMatchObject({
      model: 'dev-coding',
      effort: 'medium'
    });

    expect(
      profiles.value[0]?.accessOptions.map(({ label, description }) => [label, description])
    ).toEqual([
      [
        translate('runnerProfiles.marAgentAccessFullLabel'),
        translate('runnerProfiles.marAgentAccessFull')
      ]
    ]);
    expect(profiles.value[0]?.commands.map(({ id, description }) => [id, description])).toEqual([
      ['compact', translate('runnerProfiles.marAgentCompact')],
      ['plan', translate('runnerProfiles.marAgentPlan')],
      ['clear', translate('runnerProfiles.marAgentClear')]
    ]);

    localePreferenceService().setLocale('en-US');
    await nextTick();

    expect(
      profiles.value[0]?.accessOptions.map(({ label, description }) => [label, description])
    ).toEqual([
      [
        'Full access',
        'Run tools without per-call Agent approval. Host validation remains active, and no Agent sandbox is provided.'
      ]
    ]);
    expect(profiles.value[0]?.commands.map(({ id, description }) => [id, description])).toEqual([
      ['compact', 'Compact the current session context immediately.'],
      ['plan', 'Turn collaborative Plan Mode on or off.'],
      ['clear', 'Permanently clear this session history while keeping the session.']
    ]);
  });

  it('Uses the same localized Goal descriptions for all four Runners', async () => {
    localePreferenceService().setLocale('zh-CN');
    const command = (id: 'compact' | 'plan' | 'goal') => ({
      id,
      label: `/${id}`,
      description: `fallback-${id}`,
      inputHint: `/${id}`,
      interaction:
        id === 'plan'
          ? ('TOGGLE' as const)
          : id === 'goal'
            ? ('TOGGLE' as const)
            : ('IMMEDIATE_ACTION' as const),
      available: true,
      reasonCode: null
    });
    const profiles = ref<readonly RunnerProfile[]>([]);
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(ref<string>('node-a')),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request: vi.fn(() =>
        Promise.resolve({
          profiles: (['mar-agent', 'codex', 'claude-code', 'opencode'] as const).map((runner) => ({
            runner,
            models: [],
            accessOptions: [],
            commands: (runner === 'mar-agent'
              ? [command('goal')]
              : [command('compact'), command('plan'), command('goal')]
            ).map((item) => ({
              ...item,
              runner,
              source:
                item.id === 'goal' || runner === 'mar-agent'
                  ? ('MAR_RUNTIME' as const)
                  : runner === 'codex'
                    ? ('CODEX_APP_SERVER' as const)
                    : runner === 'claude-code'
                      ? ('CLAUDE_AGENT_SDK' as const)
                      : ('OPENCODE_SERVER' as const)
            })),
            capabilities: []
          })),
          defaults: []
        })
      ),
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');

    expect(
      profiles.value.map((profile) =>
        profile.commands.map(({ id, description }) => [id, description])
      )
    ).toEqual([
      [['goal', translate('runnerProfiles.goal')]],
      [
        ['compact', translate('runnerProfiles.marAgentCompact')],
        ['plan', translate('runnerProfiles.marAgentPlan')],
        ['goal', translate('runnerProfiles.goal')]
      ],
      [
        ['compact', translate('runnerProfiles.marAgentCompact')],
        ['plan', translate('runnerProfiles.marAgentPlan')],
        ['goal', translate('runnerProfiles.goal')]
      ],
      [
        ['compact', translate('runnerProfiles.marAgentCompact')],
        ['plan', translate('runnerProfiles.marAgentPlan')],
        ['goal', translate('runnerProfiles.goal')]
      ]
    ]);
    expect(
      localizedRunnerCommandState({
        commandId: 'goal',
        active: true,
        label: 'Goal',
        detail: null,
        closable: true,
        closeInput: '/goal --clear'
      }).label
    ).toBe(translate('goal.title'));
    expect(translate('goal.title')).toBe('目标');
    expect(translate('runnerProfiles.goal')).toBe('进入目标模式。');
  });

  it('hides legacy Mission commands and native Goal commands from incompatible Nodes', async () => {
    const profiles = ref<readonly RunnerProfile[]>([]);
    const command = (id: string, source: 'MAR_RUNTIME' | 'CODEX_APP_SERVER') => ({
      id,
      runner: 'codex' as const,
      label: `/${id}`,
      description: id,
      inputHint: `/${id}`,
      source,
      interaction: 'TOGGLE' as const,
      available: true,
      reasonCode: null
    });
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(ref<string>('node-a')),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request: vi.fn(() =>
        Promise.resolve({
          profiles: [
            {
              ...codexProfile,
              commands: [
                command('mission', 'MAR_RUNTIME'),
                command('goal', 'CODEX_APP_SERVER'),
                command('compact', 'CODEX_APP_SERVER')
              ]
            }
          ],
          defaults: []
        })
      ),
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');
    expect(profiles.value[0]?.commands.map((item) => item.id)).toEqual(['compact']);
    expect(service.cached('node-a')[0]?.commands.map((item) => item.id)).toEqual(['compact']);
  });

  it('Returns available Profiles in the recommended order: MAR Agent, Codex, Claude Code, OpenCode', async () => {
    const profiles = ref<readonly RunnerProfile[]>([]);
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(ref<string>('node-a')),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request: vi.fn(() =>
        Promise.resolve({
          profiles: [openCodeProfile, codexProfile, marAgentProfile, claudeCodeProfile],
          defaults: []
        })
      ),
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');

    expect(profiles.value.map((profile) => profile.runner)).toEqual([
      'mar-agent',
      'codex',
      'claude-code',
      'opencode'
    ]);
    expect(service.cached('node-a').map((profile) => profile.runner)).toEqual([
      'mar-agent',
      'codex',
      'claude-code',
      'opencode'
    ]);
    expect(service.defaultFor('node-a', 'codex')).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'low'
    });
  });

  it('Isolates Profiles by Node and ignores late results after a switch', async () => {
    const selectedNodeId = ref<string>('node-a');
    const profiles = ref<readonly RunnerProfile[]>([]);
    let resolveA!: (value: unknown) => void;
    const request = vi.fn((path: string) => {
      if (path.includes('node-a'))
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      return Promise.resolve({ profiles: [], defaults: [] });
    });
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });

    const pendingA = service.load('node-a');
    selectedNodeId.value = 'node-b';
    await service.load('node-b');
    resolveA({ profiles: [codexProfile], defaults: [] });
    await pendingA;

    expect(service.cached('node-a')).toEqual([]);
    expect(service.has('node-b')).toBe(true);
    expect(profiles.value).toEqual([]);
  });

  it('Restores the Web cache and reads the Node cache without waiting for Runner refreshes', async () => {
    const selectedNodeId = ref<string>('node-a');
    const profiles = ref<readonly RunnerProfile[]>([]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [codexProfile], defaults: [] })
      .mockResolvedValueOnce({ profiles: [openCodeProfile], defaults: [] });
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');
    selectedNodeId.value = 'node-b';
    profiles.value = [];
    selectedNodeId.value = 'node-a';
    service.restore('node-a');
    expect(profiles.value).toEqual([expect.objectContaining({ runner: 'codex' })]);

    const refreshing = service.load('node-a');
    expect(profiles.value).toEqual([expect.objectContaining({ runner: 'codex' })]);
    await refreshing;
    expect(request).toHaveBeenLastCalledWith(
      '/api/runner-profiles?nodeId=node-a&workspaceId=workspace&cacheOnly=true'
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(profiles.value).toEqual([expect.objectContaining({ runner: 'opencode' })]);
  });

  it('Keeps the Web cache when the Node cache read fails', async () => {
    const selectedNodeId = ref<string>('node-a');
    const profiles = ref<readonly RunnerProfile[]>([]);
    const failed = ref(false);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [codexProfile], defaults: [] })
      .mockRejectedValueOnce(new Error('NODE_REQUEST_TIMEOUT'));
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      profiles,
      loading: ref(false),
      failed,
      request,
      notice: vi.fn(),
      errorMessage: String
    });

    await service.load('node-a');
    await expect(service.load('node-a')).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    expect(profiles.value).toEqual([expect.objectContaining({ runner: 'codex' })]);
    expect(failed.value).toBe(true);
  });

  it('Does not apply a Node cache response after the selected Node changes', async () => {
    const selectedNodeId = ref<string>('node-a');
    const profiles = ref<readonly RunnerProfile[]>([]);
    let resolveRequest!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((resolve) => (resolveRequest = resolve)));
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });

    const loading = service.load('node-a');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    selectedNodeId.value = 'node-b';
    resolveRequest({ profiles: [codexProfile], defaults: [] });

    await expect(loading).resolves.toBeUndefined();
    expect(profiles.value).toEqual([]);
  });

  it('Locally saved defaults are not overwritten by an older in-flight load', async () => {
    const selectedNodeId = ref<string>('node-a');
    const profiles = ref<readonly RunnerProfile[]>([]);
    let resolveRequest!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    const service = createRunnerProfileService({
      workspaceTarget: workspaceTargetRef(selectedNodeId),
      profiles,
      loading: ref(false),
      failed: ref(false),
      request,
      notice: vi.fn(),
      errorMessage: String
    });

    const loading = service.load('node-a');
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    profiles.value = [codexProfile];
    service.save('node-a', {
      runner: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      access: 'on-request'
    });
    resolveRequest({ profiles: [codexProfile], defaults: [] });
    const result = await loading;

    expect(result?.defaultsChanged).toBe(false);
    expect(service.defaultFor('node-a', 'codex').model).toBe('gpt-5.6-sol');
  });
});
