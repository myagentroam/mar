import type { WorkspaceTarget } from '../model/workbench.js';
import type { RunnerDefaultConfiguration, RunnerProfile, Session } from '../model/workbench.js';
import { watch } from 'vue';
import { localePreferenceService, translate } from './LocalePreferenceService.js';

interface RunnerProfileServiceOptions {
  readonly workspaceTarget: Readonly<ValueRef<WorkspaceTarget | undefined>>;
  readonly profiles: ValueRef<readonly RunnerProfile[]>;
  readonly loading: ValueRef<boolean>;
  readonly failed: ValueRef<boolean>;
  readonly request: (path: string, init?: RequestInit) => Promise<unknown>;
  readonly notice: (message: string) => void;
  readonly errorMessage: (error: unknown) => string;
  readonly supportsAuto?: (nodeId: string) => boolean;
}

interface ValueRef<T> {
  value: T;
}

const runnerPreference: Readonly<Record<Session['runner'], number>> = {
  'mar-agent': 0,
  codex: 1,
  'claude-code': 2,
  opencode: 3
};

function preferredProfiles(
  profiles: readonly RunnerProfile[],
  supportsAuto = false
): readonly RunnerProfile[] {
  return profiles
    .map((profile) => ({
      ...profile,
      accessOptions: profile.accessOptions
        .filter((option) => profile.runner !== 'mar-agent' || option.id !== 'auto' || supportsAuto)
        .map((option) => {
          const description = runnerProfileDescription(
            profile.runner,
            'access',
            option.id,
            option.description
          );
          return {
            ...option,
            label: runnerProfileLabel(profile.runner, 'access', option.id, option.label),
            ...(description === undefined ? {} : { description })
          };
        }),
      commands: profile.commands
        .filter(
          (command) =>
            command.id !== 'mission' && (command.id !== 'goal' || command.source === 'MAR_RUNTIME')
        )
        .map((command) => {
          const description = runnerProfileDescription(
            profile.runner,
            'command',
            command.id,
            command.description
          );
          return {
            ...command,
            ...(command.stateLabel === undefined
              ? {}
              : {
                  stateLabel: runnerProfileLabel(
                    profile.runner,
                    'state',
                    command.id,
                    command.stateLabel
                  )
                }),
            ...(description === undefined ? {} : { description })
          };
        })
    }))
    .sort((left, right) => runnerPreference[left.runner] - runnerPreference[right.runner]);
}

const runnerProfileDescriptionKeys: Readonly<Record<string, string>> = {
  'mar-agent:access:auto': 'runnerProfiles.marAgentAccessAuto',
  'mar-agent:access:full-access': 'runnerProfiles.marAgentAccessFull',
  'mar-agent:command:compact': 'runnerProfiles.marAgentCompact',
  'mar-agent:command:plan': 'runnerProfiles.marAgentPlan',
  'mar-agent:command:clear': 'runnerProfiles.marAgentClear',
  'mar-agent:command:goal': 'runnerProfiles.goal',
  'codex:access:on-request': 'runnerProfiles.codexAccessOnRequest',
  'codex:access:workspace-write': 'runnerProfiles.codexAccessWorkspaceWrite',
  'codex:access:full-access': 'runnerProfiles.codexAccessFull',
  'codex:access:read-only': 'runnerProfiles.codexAccessReadOnly',
  'codex:command:compact': 'runnerProfiles.codexCompact',
  'codex:command:plan': 'runnerProfiles.codexPlan',
  'codex:command:goal': 'runnerProfiles.goal',
  'codex:command:fast': 'runnerProfiles.codexFast',
  'claude-code:access:default': 'runnerProfiles.claudeAccessDefault',
  'claude-code:access:accept-edits': 'runnerProfiles.claudeAccessAcceptEdits',
  'claude-code:access:bypass': 'runnerProfiles.claudeAccessBypass',
  'claude-code:access:plan': 'runnerProfiles.claudeAccessPlan',
  'claude-code:command:compact': 'runnerProfiles.codexCompact',
  'claude-code:command:plan': 'runnerProfiles.codexPlan',
  'claude-code:command:goal': 'runnerProfiles.goal',
  'opencode:access:default': 'runnerProfiles.openCodeAccessDefault',
  'opencode:access:auto': 'runnerProfiles.openCodeAccessAuto',
  'opencode:command:compact': 'runnerProfiles.codexCompact',
  'opencode:command:plan': 'runnerProfiles.codexPlan',
  'opencode:command:goal': 'runnerProfiles.goal'
};

const runnerProfileLabelKeys: Readonly<Record<string, string>> = {
  'mar-agent:access:auto': 'runnerProfiles.marAgentAccessAutoLabel',
  'mar-agent:access:full-access': 'runnerProfiles.marAgentAccessFullLabel',
  'mar-agent:state:goal': 'goal.title',
  'codex:access:on-request': 'runnerProfiles.codexAccessOnRequestLabel',
  'codex:access:workspace-write': 'runnerProfiles.codexAccessWorkspaceWriteLabel',
  'codex:access:full-access': 'runnerProfiles.codexAccessFullLabel',
  'codex:access:read-only': 'runnerProfiles.codexAccessReadOnlyLabel',
  'codex:state:plan': 'runnerProfiles.planModeLabel',
  'codex:state:goal': 'goal.title',
  'claude-code:access:default': 'runnerProfiles.claudeAccessDefaultLabel',
  'claude-code:access:accept-edits': 'runnerProfiles.claudeAccessAcceptEditsLabel',
  'claude-code:access:bypass': 'runnerProfiles.claudeAccessBypassLabel',
  'claude-code:access:plan': 'runnerProfiles.planModeLabel',
  'claude-code:state:plan': 'runnerProfiles.planModeLabel',
  'claude-code:state:goal': 'goal.title',
  'opencode:access:default': 'runnerProfiles.openCodeAccessDefaultLabel',
  'opencode:access:auto': 'runnerProfiles.openCodeAccessAutoLabel',
  'opencode:state:plan': 'runnerProfiles.planModeLabel',
  'opencode:state:goal': 'goal.title'
};

function runnerProfileLabel(
  runner: Session['runner'],
  kind: 'access' | 'state',
  id: string,
  fallback: string
): string {
  const key = runnerProfileLabelKeys[`${runner}:${kind}:${id}`];
  return key === undefined ? fallback : translate(key);
}

function runnerProfileDescription(
  runner: Session['runner'],
  kind: 'access' | 'command',
  id: string,
  fallback: string | undefined
): string | undefined {
  const key = runnerProfileDescriptionKeys[`${runner}:${kind}:${id}`];
  return key === undefined ? fallback : translate(key);
}

export function createRunnerProfileService(options: RunnerProfileServiceOptions) {
  const profilesByNode = new Map<string, readonly RunnerProfile[]>();
  const defaultsByNode = new Map<
    string,
    ReadonlyMap<Session['runner'], RunnerDefaultConfiguration>
  >();
  const defaultsVersionByNode = new Map<string, number>();
  let requestVersion = 0;
  let defaultsSave = Promise.resolve();

  function has(nodeId: string): boolean {
    return profilesByNode.has(nodeId);
  }

  function cached(nodeId: string): readonly RunnerProfile[] {
    return preferredProfiles(profilesByNode.get(nodeId) ?? [], options.supportsAuto?.(nodeId));
  }

  function restore(nodeId: string): void {
    options.profiles.value = cached(nodeId);
  }

  async function load(nodeId: string): Promise<
    | {
        readonly profiles: readonly RunnerProfile[];
        readonly defaultsChanged: boolean;
      }
    | undefined
  > {
    const target = options.workspaceTarget.value;
    const workspaceId = target?.workspaceId;
    const current = () =>
      currentRequest === requestVersion &&
      options.workspaceTarget.value?.nodeId === nodeId &&
      options.workspaceTarget.value === target;
    const currentRequest = ++requestVersion;
    options.loading.value = true;
    options.failed.value = false;
    const defaultsVersion = defaultsVersionByNode.get(nodeId) ?? 0;
    let cached:
      | {
          readonly profiles: readonly RunnerProfile[];
          readonly defaultsChanged: boolean;
        }
      | undefined;
    try {
      const path = `/api/runner-profiles?nodeId=${encodeURIComponent(nodeId)}${workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`}&cacheOnly=true`;
      const cachedResult = (await options.request(path)) as {
        profiles?: RunnerProfile[];
        defaults?: readonly RunnerDefaultConfiguration[];
      };
      const apply = (result: {
        profiles?: RunnerProfile[];
        defaults?: readonly RunnerDefaultConfiguration[];
      }) => {
        if (!current()) return undefined;
        if (!Array.isArray(result.profiles)) throw new Error('RUNNER_PROFILES_INVALID');
        profilesByNode.set(nodeId, result.profiles);
        const profiles = preferredProfiles(result.profiles, options.supportsAuto?.(nodeId));
        options.profiles.value = profiles;
        const defaultsChanged = (defaultsVersionByNode.get(nodeId) ?? 0) === defaultsVersion;
        if (defaultsChanged)
          defaultsByNode.set(nodeId, normalizeDefaults(result.defaults, profiles));
        return { profiles, defaultsChanged };
      };
      cached = apply(cachedResult);
      return cached;
    } catch {
      if (current()) {
        restore(nodeId);
        options.failed.value = true;
      }
      return undefined;
    } finally {
      if (current()) options.loading.value = false;
    }
  }

  function defaultFor(nodeId: string | undefined, runner: Session['runner']) {
    const saved = nodeId === undefined ? undefined : defaultsByNode.get(nodeId)?.get(runner);
    return saved !== undefined && supports(saved, options.profiles.value)
      ? saved
      : defaultConfiguration(runner, options.profiles.value);
  }

  function save(nodeId: string, configuration: RunnerDefaultConfiguration): void {
    if (!supports(configuration, options.profiles.value)) return;
    const defaults = new Map(defaultsByNode.get(nodeId));
    defaults.set(configuration.runner, configuration);
    defaultsByNode.set(nodeId, defaults);
    defaultsVersionByNode.set(nodeId, (defaultsVersionByNode.get(nodeId) ?? 0) + 1);
    defaultsSave = defaultsSave
      .catch(() => undefined)
      .then(async () => {
        try {
          await options.request('/api/runner-defaults', {
            method: 'PUT',
            body: JSON.stringify({ nodeId, ...configuration })
          });
        } catch (error) {
          if (options.workspaceTarget.value?.nodeId === nodeId)
            options.notice(
              translate('generated.runnerProfileService.unableToSaveTheNodeDefaultSession', {
                value0: options.errorMessage(error)
              })
            );
        }
      });
  }

  {
    watch(
      () => options.workspaceTarget.value,
      () => {
        requestVersion += 1;
        options.loading.value = false;
        options.failed.value = false;
        const nodeId = options.workspaceTarget.value?.nodeId;
        if (nodeId !== undefined) restore(nodeId);
        else options.profiles.value = [];
      },
      { flush: 'sync' }
    );
  }

  watch(localePreferenceService().locale, () => {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId !== undefined) restore(nodeId);
  });

  return { has, cached, restore, load, defaultFor, save };
}

function defaultConfiguration(
  runner: Session['runner'],
  profiles: readonly RunnerProfile[]
): RunnerDefaultConfiguration {
  const profile = profiles.find((candidate) => candidate.runner === runner);
  const model =
    profile?.models.find((candidate) => candidate.isDefault === true) ?? profile?.models[0];
  return {
    runner,
    model: model?.id ?? '',
    effort: defaultEffortForModel(model),
    access: profile?.accessOptions[0]?.id ?? ''
  };
}

export function defaultEffortForModel(
  model:
    | {
        readonly supportedEfforts: readonly string[];
        readonly defaultEffort?: string;
      }
    | undefined
): string {
  return (
    (model?.defaultEffort !== undefined &&
    model.defaultEffort.length > 0 &&
    (model.supportedEfforts.length === 0 || model.supportedEfforts.includes(model.defaultEffort))
      ? model.defaultEffort
      : undefined) ??
    model?.supportedEfforts.find((effort) => effort === 'medium') ??
    model?.supportedEfforts[0] ??
    ''
  );
}

function supports(value: RunnerDefaultConfiguration, profiles: readonly RunnerProfile[]): boolean {
  const profile = profiles.find((item) => item.runner === value.runner);
  const model = profile?.models.find((item) => item.id === value.model);
  return (
    model !== undefined &&
    (model.supportedEfforts.length === 0
      ? value.effort.length > 0 && value.effort === model.defaultEffort
      : model.supportedEfforts.includes(value.effort)) &&
    profile?.accessOptions.some((option) => option.id === value.access) === true
  );
}

function normalizeDefaults(
  values: readonly RunnerDefaultConfiguration[] | undefined,
  profiles: readonly RunnerProfile[]
): ReadonlyMap<Session['runner'], RunnerDefaultConfiguration> {
  return new Map(
    (Array.isArray(values) ? values : [])
      .filter((value) => supports(value, profiles))
      .map((value) => [value.runner, value] as const)
  );
}
