import type { WorkspaceTarget } from '../model/workbench.js';
import { nextTick, watch, type Ref } from 'vue';
import type { RunnerDefaultConfiguration, RunnerProfile, Session } from '../model/workbench.js';
import { translate } from './LocalePreferenceService.js';
import { defaultEffortForModel } from './RunnerProfileService.js';

interface RunnerProfileDomain {
  load(
    nodeId: string
  ): Promise<
    { readonly profiles: readonly RunnerProfile[]; readonly defaultsChanged: boolean } | undefined
  >;
  defaultFor(nodeId: string | undefined, runner: Session['runner']): RunnerDefaultConfiguration;
  save(nodeId: string, configuration: RunnerDefaultConfiguration): void;
}

export function createWorkbenchComposerController(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSession: Ref<Session | undefined>;
  readonly sessions: Ref<Session[]>;
  readonly profiles: Ref<readonly RunnerProfile[]>;
  readonly draftOpen: Ref<boolean>;
  readonly loading: Ref<boolean>;
  readonly configurationAvailable?: () => boolean;
  readonly runner: Ref<Session['runner']>;
  readonly model: Ref<string>;
  readonly effort: Ref<string>;
  readonly access: Ref<string>;
  readonly modelEffortSelection: Ref<string | undefined>;
  readonly codexFastEnabled: Ref<boolean>;
  readonly profileService: RunnerProfileDomain;
  readonly normalize: () => void;
  readonly apply: (configuration: RunnerDefaultConfiguration) => void;
  readonly ensureDraftSupported: (profiles?: readonly RunnerProfile[]) => void;
  readonly clearRunnerCommand: () => void;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly notice: (value: string) => void;
  readonly errorMessage: (error: unknown) => string;
  readonly retryDelay?: (delayMs: number) => Promise<void>;
}) {
  let updateSequence = 0;
  let profileRecoverySequence = 0;
  let repairingSessionId: string | undefined;
  let authoritativeSession: { readonly nodeId: string; readonly sessionId: string } | undefined;
  if (options.configurationAvailable !== undefined)
    watch(options.configurationAvailable, (available) => {
      if (available) void repairUnsupportedSelectedModel();
    });
  async function tryLoadProfiles(nodeId = options.workspaceTarget.value?.nodeId): Promise<boolean> {
    if (nodeId === undefined || options.workspaceTarget.value?.nodeId !== nodeId) return false;
    const selection = options.workspaceTarget.value;
    const result = await options.profileService.load(nodeId);
    if (options.workspaceTarget.value !== selection) return false;
    if (result === undefined) {
      if (options.workspaceTarget.value === selection) options.codexFastEnabled.value = false;
      return false;
    }
    if (
      result.defaultsChanged &&
      options.draftOpen.value &&
      options.selectedSession.value === undefined
    )
      applyDefaults(options.runner.value);
    if (options.draftOpen.value && options.selectedSession.value === undefined)
      options.ensureDraftSupported(result.profiles);
    options.normalize();
    await repairUnsupportedSelectedModel();
    if (options.workspaceTarget.value !== selection) return false;
    if (
      result.profiles.some(
        (profile) =>
          profile.runner === 'codex' && profile.commands.some((command) => command.id === 'fast')
      )
    )
      void refreshCodexFastStatus(nodeId);
    else options.codexFastEnabled.value = false;
    return true;
  }

  async function loadProfiles(nodeId = options.workspaceTarget.value?.nodeId): Promise<void> {
    if (nodeId === undefined) return;
    const selection = options.workspaceTarget.value;
    const recoverySequence = ++profileRecoverySequence;
    const delays = [0, 500, 1_000, 2_000, 4_000] as const;
    for (const delayMs of delays) {
      if (
        recoverySequence !== profileRecoverySequence ||
        options.workspaceTarget.value !== selection
      )
        return;
      if (delayMs > 0)
        await (
          options.retryDelay ?? ((value) => new Promise((resolve) => setTimeout(resolve, value)))
        )(delayMs);
      if (
        recoverySequence !== profileRecoverySequence ||
        options.workspaceTarget.value !== selection
      )
        return;
      if (await tryLoadProfiles(nodeId)) return;
    }
  }

  async function refreshCodexFastStatus(nodeId: string): Promise<void> {
    const selection = options.workspaceTarget.value;
    try {
      const result = await options.request<{ enabled: boolean }>('/api/runner-commands', {
        method: 'POST',
        body: JSON.stringify({ nodeId, runner: 'codex', commandId: 'fast', input: '/fast status' })
      });
      if (options.workspaceTarget.value === selection)
        options.codexFastEnabled.value = result.enabled;
    } catch {
      if (options.workspaceTarget.value === selection) options.codexFastEnabled.value = false;
    }
  }

  function runnerDefaultFor(runner: Session['runner']): RunnerDefaultConfiguration {
    return options.profileService.defaultFor(options.workspaceTarget.value?.nodeId, runner);
  }
  function applyDefaults(runner: Session['runner']): void {
    options.apply(runnerDefaultFor(runner));
  }
  function normalize(): void {
    options.normalize();
  }
  function saveDefaults(): void {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId !== undefined)
      options.profileService.save(nodeId, {
        runner: options.runner.value,
        model: options.model.value,
        effort: options.effort.value,
        access: options.access.value
      });
  }
  function applyConfigurationState(session?: Session): void {
    if (session === undefined) return normalize();
    const fallback = runnerDefaultFor(session.runner);
    options.apply({
      runner: session.runner,
      model: session.model ?? fallback.model,
      effort: session.effort ?? fallback.effort,
      access: session.access ?? fallback.access
    });
  }
  function applyConfiguration(session?: Session, authoritative = true): void {
    applyConfigurationState(session);
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (session === undefined || nodeId === undefined || !authoritative) {
      authoritativeSession = undefined;
      return;
    }
    authoritativeSession = { nodeId, sessionId: session.id };
    void repairUnsupportedSelectedModel(session);
  }
  async function repairUnsupportedSelectedModel(
    session = options.selectedSession.value
  ): Promise<void> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (
      session === undefined ||
      session.runner !== 'mar-agent' ||
      nodeId === undefined ||
      options.draftOpen.value ||
      options.selectedSession.value?.id !== session.id ||
      authoritativeSession?.nodeId !== nodeId ||
      authoritativeSession.sessionId !== session.id ||
      repairingSessionId === session.id ||
      options.configurationAvailable?.() === false
    )
      return;
    const profile = options.profiles.value.find((candidate) => candidate.runner === session.runner);
    if (
      profile === undefined ||
      profile.models.length === 0 ||
      profile.models.some((candidate) => candidate.id === session.model)
    )
      return;
    const firstModel = profile.models[0]!;
    options.model.value = firstModel.id;
    options.effort.value = defaultEffortForModel(firstModel);
    repairingSessionId = session.id;
    try {
      await update();
    } finally {
      if (repairingSessionId === session.id) repairingSessionId = undefined;
    }
  }

  async function update(): Promise<void> {
    if (
      options.draftOpen.value ||
      options.workspaceTarget.value?.nodeId === undefined ||
      options.selectedSession.value === undefined
    )
      return normalize();
    const nodeId = options.workspaceTarget.value?.nodeId;
    const session = options.selectedSession.value;
    if (options.configurationAvailable?.() === false) return applyConfigurationState(session);
    await nextTick();
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.selectedSession.value?.id !== session.id
    )
      return;
    if (options.configurationAvailable?.() === false)
      return applyConfigurationState(options.selectedSession.value);
    normalize();
    const sequence = ++updateSequence;
    options.loading.value = true;
    try {
      const result = await options.request<{ session: Session }>(
        `/api/agent-sessions/${options.sessionPathId(session.id)}/config`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            nodeId,
            workspaceId: session.workspaceId,
            model: options.model.value,
            effort: options.effort.value,
            access: options.access.value
          })
        }
      );
      if (
        sequence !== updateSequence ||
        options.workspaceTarget.value?.nodeId !== nodeId ||
        options.selectedSession.value?.id !== session.id
      )
        return;
      options.sessions.value = options.sessions.value.map((session) =>
        session.id === result.session.id ? result.session : session
      );
    } catch (error) {
      if (
        sequence !== updateSequence ||
        options.workspaceTarget.value?.nodeId !== nodeId ||
        options.selectedSession.value?.id !== session.id
      )
        return;
      applyConfigurationState(session);
      options.notice(
        translate('generated.workbenchComposerController.unableToUpdateTheSessionConfiguration', {
          value0: options.errorMessage(error)
        })
      );
    } finally {
      if (sequence === updateSequence) options.loading.value = false;
    }
  }

  function selectEffort(effort: string, allowed: readonly string[]): void {
    if (!allowed.includes(effort)) return;
    options.effort.value = effort;
    void update();
    if (options.draftOpen.value) saveDefaults();
  }
  function selectModel(
    modelId: string,
    models: readonly {
      readonly id: string;
      readonly supportedEfforts: readonly string[];
      readonly defaultEffort?: string;
    }[]
  ): void {
    const model = models.find((candidate) => candidate.id === modelId);
    if (model === undefined) return;
    options.model.value = model.id;
    options.effort.value = defaultEffortForModel(model);
    void update();
    if (options.draftOpen.value) saveDefaults();
  }
  function selectAccess(accessId: string, accessOptions: readonly { readonly id: string }[]): void {
    if (!accessOptions.some((item) => item.id === accessId)) return;
    options.access.value = accessId;
    void update();
    if (options.draftOpen.value) saveDefaults();
  }
  function selectRunner(value: unknown): void {
    if (
      value !== 'mar-agent' &&
      value !== 'codex' &&
      value !== 'claude-code' &&
      value !== 'opencode'
    )
      return;
    if (
      !options.profiles.value.some(
        (profile) => profile.runner === value && profile.capabilities.includes('turn.start')
      )
    )
      return;
    applyDefaults(value);
    options.clearRunnerCommand();
    options.modelEffortSelection.value = undefined;
    void update();
  }
  function selectModelEffort(
    value: unknown,
    selectEffortValue: (value: string) => void,
    selectModelValue: (value: string) => void
  ): void {
    const selected = Array.isArray(value) ? value.at(-1) : value;
    if (typeof selected !== 'string') return;
    if (selected.startsWith('effort:')) selectEffortValue(selected.slice(7));
    else if (selected.startsWith('model:')) selectModelValue(selected.slice(6));
    else return;
    void nextTick(() => {
      options.modelEffortSelection.value = undefined;
    });
  }

  return {
    loadProfiles,
    runnerDefaultFor,
    applyDefaults,
    normalize,
    saveDefaults,
    applyConfiguration,
    update,
    selectEffort,
    selectModel,
    selectAccess,
    selectRunner,
    selectModelEffort
  };
}
