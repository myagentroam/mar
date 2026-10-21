import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { ref as reactiveRef } from 'vue';
import { createWorkbenchComposerController } from '../../src/service/WorkbenchComposerController.js';
import type {
  RunnerDefaultConfiguration,
  RunnerProfile,
  Session
} from '../../src/model/workbench.js';

function ref<T>(value: T): { value: T } {
  return { value };
}

const sessionA: Session = { id: 'session-a', workspaceId: 'workspace-a', runner: 'codex' };
const sessionB: Session = { id: 'session-b', workspaceId: 'workspace-a', runner: 'codex' };
const defaultConfiguration: RunnerDefaultConfiguration = {
  runner: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'medium',
  access: 'on-request'
};

describe('Workbench Composer Controller', () => {
  it('allows switching to a startable MAR Agent', () => {
    const apply = vi.fn();
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: ref<Session | undefined>(undefined) as never,
      sessions: ref<Session[]>([]) as never,
      profiles: ref([
        {
          runner: 'mar-agent',
          models: [],
          accessOptions: [],
          commands: [],
          capabilities: ['turn.start']
        }
      ]) as never,
      draftOpen: ref(true) as never,
      loading: ref(false) as never,
      runner: ref('codex') as never,
      model: ref('') as never,
      effort: ref('') as never,
      access: ref('') as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: {
        load: async () => undefined,
        defaultFor: () => ({
          runner: 'mar-agent',
          model: 'dev-coding',
          effort: 'medium',
          access: 'on-request'
        }),
        save: vi.fn()
      },
      normalize: vi.fn(),
      apply,
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: vi.fn(async () => ({})) as never,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String
    });

    controller.selectRunner('mar-agent');

    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ runner: 'mar-agent' }));
  });

  it('retries Runner Profile loading at controlled intervals and stops after recovery', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ profiles: [], defaultsChanged: false });
    const retryDelay = vi.fn(async () => undefined);
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: ref<Session | undefined>(undefined) as never,
      sessions: ref<Session[]>([]) as never,
      profiles: ref([]) as never,
      draftOpen: ref(true) as never,
      loading: ref(false) as never,
      runner: ref('codex') as never,
      model: ref('') as never,
      effort: ref('') as never,
      access: ref('') as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: { load, defaultFor: () => defaultConfiguration, save: vi.fn() },
      normalize: vi.fn(),
      apply: vi.fn(),
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: vi.fn(async () => ({})) as never,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String,
      retryDelay
    });

    await controller.loadProfiles('node-a');

    expect(load).toHaveBeenCalledTimes(3);
    expect(retryDelay).toHaveBeenNthCalledWith(1, 500);
    expect(retryDelay).toHaveBeenNthCalledWith(2, 1_000);
  });

  it.each(['loading', 'normalization'] as const)(
    'does not reset Composer flags after a same-host Workspace changes during %s',
    async (phase) => {
      const workspaceTarget = ref({ nodeId: 'node-a', workspaceId: 'workspace-a' });
      const fast = ref(true);
      let finish!: () => void;
      const load = vi.fn(
        () =>
          new Promise<{ profiles: readonly RunnerProfile[]; defaultsChanged: boolean } | undefined>(
            (resolve) => {
              finish = () =>
                resolve(phase === 'loading' ? undefined : { profiles: [], defaultsChanged: false });
            }
          )
      );
      let normalized!: () => void;
      const normalization = new Promise<void>((resolve) => {
        normalized = resolve;
      });
      const retryDelay = vi.fn(async () => undefined);
      const controller = createWorkbenchComposerController({
        workspaceTarget: workspaceTarget as never,
        selectedSession: ref<Session | undefined>(undefined) as never,
        sessions: ref<Session[]>([]) as never,
        profiles: ref([]) as never,
        draftOpen: ref(true) as never,
        loading: ref(false) as never,
        runner: ref('codex') as never,
        model: ref('') as never,
        effort: ref('') as never,
        access: ref('') as never,
        modelEffortSelection: ref<string | undefined>(undefined) as never,
        codexFastEnabled: fast as never,
        profileService: { load, defaultFor: () => defaultConfiguration, save: vi.fn() },
        normalize: vi.fn(normalized),
        apply: vi.fn(),
        ensureDraftSupported: vi.fn(),
        clearRunnerCommand: vi.fn(),
        request: vi.fn(async () => ({})) as never,
        sessionPathId: String,
        notice: vi.fn(),
        errorMessage: String,
        retryDelay
      });
      const pending = controller.loadProfiles('node-a');
      if (phase === 'normalization') {
        finish();
        await normalization;
      }
      workspaceTarget.value = { nodeId: 'node-a', workspaceId: 'workspace-b' };
      if (phase === 'loading') finish();
      await pending;
      expect(fast.value).toBe(true);
      expect(load).toHaveBeenCalledOnce();
      expect(retryDelay).not.toHaveBeenCalled();
    }
  );

  it.each(['save', 'busy', 'selection'] as const)(
    'rechecks configuration after nextTick: %s',
    async (change) => {
      const selectedSession = ref<Session | undefined>(sessionA);
      const sessions = ref<Session[]>([sessionA]);
      const notice = vi.fn();
      const updated = { ...sessionA, effort: 'high' };
      const configurationAvailable = reactiveRef(true);
      const request = vi.fn(async () => ({ session: updated }));
      const controller = createWorkbenchComposerController({
        workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
        configurationAvailable: () => configurationAvailable.value,
        selectedSession: selectedSession as never,
        sessions: sessions as never,
        profiles: ref([]) as never,
        draftOpen: ref(false) as never,
        loading: ref(false) as never,
        runner: ref('codex') as never,
        model: ref('gpt-5.6-sol') as never,
        effort: ref('high') as never,
        access: ref('full-access') as never,
        modelEffortSelection: ref<string | undefined>(undefined) as never,
        codexFastEnabled: ref(false) as never,
        profileService: {
          load: async () => undefined,
          defaultFor: () => defaultConfiguration,
          save: vi.fn()
        },
        normalize: vi.fn(),
        apply: vi.fn(),
        ensureDraftSupported: vi.fn(),
        clearRunnerCommand: vi.fn(),
        request: request as never,
        sessionPathId: String,
        notice,
        errorMessage: String
      });

      const pending = controller.update();
      if (change === 'busy') configurationAvailable.value = false;
      else if (change === 'selection') selectedSession.value = sessionB;
      await pending;

      expect(sessions.value).toEqual([change === 'save' ? updated : sessionA]);
      if (change === 'save') expect(request).toHaveBeenCalledOnce();
      else expect(request).not.toHaveBeenCalled();
      expect(notice).not.toHaveBeenCalled();
    }
  );

  it("switches to the target model's default reasoning effort even when the previous effort remains supported", () => {
    const model = ref('model-a');
    const effort = ref('high');
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: ref<Session | undefined>(undefined) as never,
      sessions: ref<Session[]>([]) as never,
      profiles: ref([]) as never,
      draftOpen: ref(true) as never,
      loading: ref(false) as never,
      runner: ref('codex') as never,
      model: model as never,
      effort: effort as never,
      access: ref('on-request') as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: {
        load: async () => undefined,
        defaultFor: () => defaultConfiguration,
        save: vi.fn()
      },
      normalize: vi.fn(),
      apply: vi.fn(),
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: vi.fn(async () => ({})) as never,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String
    });

    controller.selectModel('model-b', [
      {
        id: 'model-a',
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high'
      },
      {
        id: 'model-b',
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'low'
      },
      {
        id: 'model-c',
        supportedEfforts: [],
        defaultEffort: 'medium'
      }
    ]);

    expect(model.value).toBe('model-b');
    expect(effort.value).toBe('low');

    controller.selectModel('model-c', [
      {
        id: 'model-a',
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high'
      },
      {
        id: 'model-b',
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'low'
      },
      {
        id: 'model-c',
        supportedEfforts: [],
        defaultEffort: 'medium'
      }
    ]);

    expect(model.value).toBe('model-c');
    expect(effort.value).toBe('medium');
  });

  it('synchronizes Composer options after an external session configuration update', () => {
    const apply = vi.fn();
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: ref<Session | undefined>(sessionA) as never,
      sessions: ref<Session[]>([sessionA]) as never,
      profiles: ref([]) as never,
      draftOpen: ref(false) as never,
      loading: ref(false) as never,
      runner: ref('codex') as never,
      model: ref('gpt-5.6-sol') as never,
      effort: ref('high') as never,
      access: ref('read-only') as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: {
        load: async () => undefined,
        defaultFor: () => defaultConfiguration,
        save: vi.fn()
      },
      normalize: vi.fn(),
      apply,
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: vi.fn(async () => ({})) as never,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String
    });

    controller.applyConfiguration({ ...sessionA, access: 'full-access' });

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ runner: 'codex', access: 'full-access' })
    );
  });

  it.each([false, true])(
    'repairs an unsupported MAR Agent model only when configuration is available (initially busy: %s)',
    async (initiallyBusy) => {
      const configurationAvailable = reactiveRef(!initiallyBusy);
      const staleSession: Session = {
        id: 'session-mar',
        workspaceId: 'workspace-a',
        runner: 'mar-agent',
        model: 'revoked-model',
        effort: 'high',
        access: 'on-request'
      };
      const selectedSession = ref<Session | undefined>(staleSession);
      const sessions = ref<Session[]>([staleSession]);
      const availableProfiles: readonly RunnerProfile[] = [
        {
          runner: 'mar-agent',
          models: [
            {
              id: 'allowed-model',
              label: 'Allowed model',
              supportedEfforts: ['low']
            }
          ],
          accessOptions: [
            {
              id: 'on-request',
              label: 'On request'
            }
          ],
          commands: [],
          capabilities: ['turn.start']
        }
      ];
      const profiles = ref<readonly RunnerProfile[]>([]);
      const runner = ref<Session['runner']>('mar-agent');
      const model = ref('revoked-model');
      const effort = ref('high');
      const access = ref('on-request');
      const normalize = vi.fn(() => {
        const profile = profiles.value.find((candidate) => candidate.runner === runner.value);
        if (!profile?.models.some((candidate) => candidate.id === model.value))
          model.value = profile?.models[0]?.id ?? '';
        const selected = profile?.models.find((candidate) => candidate.id === model.value);
        if (selected !== undefined && !selected.supportedEfforts.includes(effort.value))
          effort.value = selected.supportedEfforts[0] ?? '';
      });
      const apply = vi.fn((configuration: RunnerDefaultConfiguration) => {
        runner.value = configuration.runner;
        model.value = configuration.model;
        effort.value = configuration.effort;
        access.value = configuration.access;
        normalize();
      });
      const updated = {
        ...staleSession,
        model: 'allowed-model',
        effort: 'low'
      };
      const request = vi.fn(async () => ({ session: updated }));
      const controller = createWorkbenchComposerController({
        workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
        selectedSession: selectedSession as never,
        sessions: sessions as never,
        profiles: profiles as never,
        configurationAvailable: () => configurationAvailable.value,
        draftOpen: ref(false) as never,
        loading: ref(false) as never,
        runner: runner as never,
        model: model as never,
        effort: effort as never,
        access: access as never,
        modelEffortSelection: ref<string | undefined>(undefined) as never,
        codexFastEnabled: ref(false) as never,
        profileService: {
          load: async () => {
            profiles.value = availableProfiles;
            return { profiles: availableProfiles, defaultsChanged: false };
          },
          defaultFor: () => ({
            runner: 'mar-agent',
            model: 'allowed-model',
            effort: 'low',
            access: 'on-request'
          }),
          save: vi.fn()
        },
        normalize,
        apply,
        ensureDraftSupported: vi.fn(),
        clearRunnerCommand: vi.fn(),
        request: request as never,
        sessionPathId: String,
        notice: vi.fn(),
        errorMessage: String
      });

      controller.applyConfiguration(staleSession);
      expect(request).not.toHaveBeenCalled();
      await controller.loadProfiles('node-a');

      if (initiallyBusy) {
        expect(request).not.toHaveBeenCalled();
        configurationAvailable.value = true;
      }

      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith('/api/agent-sessions/session-mar/config', {
          method: 'PATCH',
          body: JSON.stringify({
            nodeId: 'node-a',
            workspaceId: staleSession.workspaceId,
            model: 'allowed-model',
            effort: 'low',
            access: 'on-request'
          })
        })
      );
      await vi.waitFor(() => expect(sessions.value).toEqual([updated]));
    }
  );

  it('does not repair a MAR Agent model from a provisional session summary before authoritative details arrive', async () => {
    const provisionalSession: Session = {
      id: 'session-mar',
      workspaceId: 'workspace-a',
      runner: 'mar-agent',
      model: null,
      effort: null,
      access: 'full-access'
    };
    const authoritativeSession: Session = {
      ...provisionalSession,
      model: 'model-b',
      effort: 'high'
    };
    const selectedSession = ref<Session | undefined>(provisionalSession);
    const sessions = ref<Session[]>([provisionalSession]);
    const profiles = ref<readonly RunnerProfile[]>([]);
    const runner = ref<Session['runner']>('mar-agent');
    const model = ref('');
    const effort = ref('');
    const access = ref('full-access');
    const availableProfiles: readonly RunnerProfile[] = [
      {
        runner: 'mar-agent',
        models: [
          {
            id: 'model-a',
            label: 'Model A',
            supportedEfforts: ['medium']
          },
          {
            id: 'model-b',
            label: 'Model B',
            supportedEfforts: ['high']
          }
        ],
        accessOptions: [{ id: 'full-access', label: 'Full access' }],
        commands: [],
        capabilities: ['turn.start']
      }
    ];
    const normalize = vi.fn(() => {
      const profile = profiles.value.find((candidate) => candidate.runner === runner.value);
      if (!profile?.models.some((candidate) => candidate.id === model.value))
        model.value = profile?.models[0]?.id ?? model.value;
    });
    const apply = vi.fn((configuration: RunnerDefaultConfiguration) => {
      runner.value = configuration.runner;
      model.value = configuration.model;
      effort.value = configuration.effort;
      access.value = configuration.access;
      normalize();
    });
    const request = vi.fn(async () => ({ session: authoritativeSession }));
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: selectedSession as never,
      sessions: sessions as never,
      profiles: profiles as never,
      draftOpen: ref(false) as never,
      loading: ref(false) as never,
      runner: runner as never,
      model: model as never,
      effort: effort as never,
      access: access as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: {
        load: async () => {
          profiles.value = availableProfiles;
          return { profiles: availableProfiles, defaultsChanged: false };
        },
        defaultFor: () => ({
          runner: 'mar-agent',
          model: 'model-a',
          effort: 'medium',
          access: 'full-access'
        }),
        save: vi.fn()
      },
      normalize,
      apply,
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: request as never,
      sessionPathId: String,
      notice: vi.fn(),
      errorMessage: String
    });

    selectedSession.value = authoritativeSession;
    sessions.value = [authoritativeSession];
    controller.applyConfiguration(authoritativeSession, true);
    selectedSession.value = provisionalSession;
    sessions.value = [provisionalSession];
    controller.applyConfiguration(provisionalSession, false);
    await controller.loadProfiles('node-a');

    expect(request).not.toHaveBeenCalled();

    selectedSession.value = authoritativeSession;
    sessions.value = [authoritativeSession];
    controller.applyConfiguration(authoritativeSession, true);
    await Promise.resolve();

    expect(model.value).toBe('model-b');
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores configuration responses and failures after switching sessions instead of overwriting the new session's Composer", async () => {
    const selectedSession = ref<Session | undefined>(sessionA);
    const sessions = ref<Session[]>([sessionA, sessionB]);
    const loading = ref(false);
    let resolveRequest!: (value: unknown) => void;
    const requestResult = new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    });
    const apply = vi.fn();
    const notice = vi.fn();
    const controller = createWorkbenchComposerController({
      workspaceTarget: workspaceTargetRef(ref<string | undefined>('node-a')),
      selectedSession: selectedSession as never,
      sessions: sessions as never,
      profiles: ref([]) as never,
      draftOpen: ref(false) as never,
      loading: loading as never,
      runner: ref('codex') as never,
      model: ref('gpt-5.6-sol') as never,
      effort: ref('high') as never,
      access: ref('full-access') as never,
      modelEffortSelection: ref<string | undefined>(undefined) as never,
      codexFastEnabled: ref(false) as never,
      profileService: {
        load: async () => undefined,
        defaultFor: () => defaultConfiguration,
        save: vi.fn()
      },
      normalize: vi.fn(),
      apply,
      ensureDraftSupported: vi.fn(),
      clearRunnerCommand: vi.fn(),
      request: async <T>() => (await requestResult) as T,
      sessionPathId: String,
      notice,
      errorMessage: String
    });

    const pending = controller.update();
    await vi.waitFor(() => expect(loading.value).toBe(true));
    selectedSession.value = sessionB;
    resolveRequest({ session: { ...sessionA, effort: 'high' } });
    await pending;

    expect(sessions.value).toEqual([sessionA, sessionB]);
    expect(apply).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(loading.value).toBe(false);
  });
});
