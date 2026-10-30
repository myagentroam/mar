import type { RunnerName, RunnerProfile } from '@myagentroam/protocol';

type ProfileDefinition = Omit<RunnerProfile, 'capabilities'>;

const COMMON_COMMAND_DESCRIPTIONS = {
  compact: 'Compact the current session context.',
  plan: 'Toggle collaborative Plan Mode.',
  goal: 'Enter persistent Goal mode.'
} as const;

const CLAUDE_MODEL_ENVIRONMENT = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
} as const;

const OFFICIAL_ANTHROPIC_HOST = 'api.anthropic.com';

/**
 * Keep product-visible permission modes and slash commands in one Node-owned
 * definition. Codex models are supplied by App Server `model/list`; Claude
 * aliases are accepted by the Agent SDK and avoid coupling the UI to a vendor
 * version suffix.
 */
const definitions: Readonly<Record<RunnerName, ProfileDefinition>> = {
  codex: {
    runner: 'codex',
    models: [],
    accessOptions: [
      {
        id: 'on-request',
        label: 'On-request',
        description: 'Ask when additional permission is required.'
      },
      {
        id: 'workspace-write',
        label: 'Workspace write',
        description: 'Allow writes in the current Workspace.'
      },
      {
        id: 'full-access',
        label: 'Full access',
        description: 'Allow full access without individual confirmations.'
      },
      { id: 'read-only', label: 'Read-only', description: 'Restrict Codex to a read-only sandbox.' }
    ],
    commands: [
      {
        id: 'compact',
        label: '/compact',
        description: COMMON_COMMAND_DESCRIPTIONS.compact,
        inputHint: '/compact',
        interaction: 'IMMEDIATE_ACTION' as const
      },
      {
        id: 'plan',
        label: '/plan',
        stateLabel: 'Plan Mode',
        description: COMMON_COMMAND_DESCRIPTIONS.plan,
        inputHint: '/plan',
        interaction: 'TOGGLE' as const
      },
      {
        id: 'fast',
        label: '/fast',
        description: 'Toggle the fast service tier when supported.',
        inputHint: '/fast',
        interaction: 'TOGGLE' as const
      }
    ].map((command) => ({
      ...command,
      runner: 'codex' as const,
      source: 'CODEX_APP_SERVER' as const,
      available: true,
      reasonCode: null
    }))
  },
  'claude-code': {
    runner: 'claude-code',
    models: [
      {
        id: 'opus',
        label: 'Claude Opus',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        id: 'sonnet',
        label: 'Claude Sonnet',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      { id: 'haiku', label: 'Claude Haiku', supportedEfforts: ['low', 'medium'] }
    ],
    accessOptions: [
      { id: 'default', label: 'Default', description: 'Use Claude Code default confirmations.' },
      {
        id: 'accept-edits',
        label: 'Accept edits',
        description: 'Automatically accept edits in the current Workspace.'
      },
      {
        id: 'bypass',
        label: 'Bypass permissions',
        description: 'Bypass permission confirmations.'
      },
      { id: 'plan', label: 'Plan Mode', description: 'Run in Plan Mode without executing tools.' }
    ],
    commands: [
      {
        id: 'compact',
        runner: 'claude-code' as const,
        label: '/compact',
        description: COMMON_COMMAND_DESCRIPTIONS.compact,
        inputHint: '/compact',
        source: 'CLAUDE_AGENT_SDK' as const,
        interaction: 'IMMEDIATE_ACTION' as const,
        available: true,
        reasonCode: null
      },
      {
        id: 'plan',
        runner: 'claude-code' as const,
        label: '/plan',
        stateLabel: 'Plan Mode',
        description: COMMON_COMMAND_DESCRIPTIONS.plan,
        inputHint: '/plan',
        source: 'CLAUDE_AGENT_SDK' as const,
        interaction: 'TOGGLE' as const,
        available: true,
        reasonCode: null
      }
    ]
  },
  opencode: {
    runner: 'opencode',
    models: [],
    accessOptions: [
      {
        id: 'default',
        label: 'Default',
        description: 'Use OpenCode and Workspace permission configuration.'
      },
      {
        id: 'auto',
        label: 'Auto approve',
        description: 'Automatically allow requested tool permissions.'
      }
    ],
    commands: [
      {
        id: 'compact',
        runner: 'opencode' as const,
        label: '/compact',
        description: COMMON_COMMAND_DESCRIPTIONS.compact,
        inputHint: '/compact',
        source: 'OPENCODE_SERVER' as const,
        interaction: 'IMMEDIATE_ACTION' as const,
        available: true,
        reasonCode: null
      },
      {
        id: 'plan',
        runner: 'opencode' as const,
        label: '/plan',
        stateLabel: 'Plan Mode',
        description: COMMON_COMMAND_DESCRIPTIONS.plan,
        inputHint: '/plan',
        source: 'OPENCODE_SERVER' as const,
        interaction: 'TOGGLE' as const,
        available: true,
        reasonCode: null
      }
    ]
  },
  'mar-agent': {
    runner: 'mar-agent',
    models: [],
    accessOptions: [
      {
        id: 'on-request',
        label: 'On-request',
        description: 'Ask before tools with side effects. This is not an operating-system sandbox.'
      },
      {
        id: 'full-access',
        label: 'Full access',
        description:
          'Skip Agent approvals. Host validation still applies and no Agent sandbox is provided.'
      }
    ],
    commands: [
      {
        id: 'compact',
        runner: 'mar-agent',
        label: '/compact',
        description: COMMON_COMMAND_DESCRIPTIONS.compact,
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
        stateLabel: 'Plan Mode',
        description: COMMON_COMMAND_DESCRIPTIONS.plan,
        inputHint: '/plan',
        source: 'MAR_RUNTIME',
        interaction: 'TOGGLE',
        available: true,
        reasonCode: null
      },
      {
        id: 'review',
        runner: 'mar-agent',
        label: '/review',
        description: 'Review the selected workspace changes without modifying files.',
        inputHint: '/review',
        source: 'MAR_RUNTIME',
        interaction: 'IMMEDIATE_ACTION',
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
};

export function declaredRunnerProfiles(input: {
  readonly codexAvailable: boolean;
  readonly claudeCodeAvailable: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly openCodeAvailable?: boolean;
}): readonly RunnerProfile[] {
  return [
    withCapabilities(definitions.codex, input.codexAvailable),
    withCapabilities(claudeProfile(input.environment ?? process.env), input.claudeCodeAvailable),
    withCapabilities(definitions.opencode, input.openCodeAvailable === true)
  ];
}

export function supportsRunnerConfiguration(input: {
  readonly runner: RunnerName;
  readonly modelId: string;
  readonly effort: string;
  readonly access: string;
  readonly environment?: NodeJS.ProcessEnv;
}): boolean {
  const profile =
    input.runner === 'claude-code'
      ? claudeProfile(input.environment ?? process.env)
      : definitions[input.runner];
  const model = profile.models.find((candidate) => candidate.id === input.modelId);
  return (
    model !== undefined &&
    model.supportedEfforts.includes(input.effort) &&
    profile.accessOptions.some((candidate) => candidate.id === input.access)
  );
}

export function claudeDefaultModel(environment: NodeJS.ProcessEnv = process.env): string {
  const sonnet = configuredClaudeModel('sonnet', environment);
  if (sonnet !== undefined) return sonnet;
  if (usesThirdPartyEndpoint(environment)) {
    return (
      configuredClaudeModel('opus', environment) ??
      configuredClaudeModel('haiku', environment) ??
      'sonnet'
    );
  }
  return 'sonnet';
}

function claudeProfile(environment: NodeJS.ProcessEnv): ProfileDefinition {
  const profile = definitions['claude-code'];
  const thirdParty = usesThirdPartyEndpoint(environment);
  const models = profile.models.flatMap((model) => {
    const configured = configuredClaudeModel(model.id, environment);
    if (configured !== undefined) return [{ ...model, id: configured, label: configured }];
    return thirdParty ? [] : [model];
  });
  return {
    ...profile,
    models: models.filter(
      (model, index) => models.findIndex((candidate) => candidate.id === model.id) === index
    )
  };
}

/**
 * A custom `ANTHROPIC_BASE_URL` points Claude Code at a third-party gateway
 * where the built-in `opus`/`sonnet`/`haiku` aliases usually do not resolve;
 * only environment-declared model names are meaningful there. Unparsable
 * non-empty values are treated as custom endpoints.
 */
function usesThirdPartyEndpoint(environment: NodeJS.ProcessEnv): boolean {
  const raw = environment['ANTHROPIC_BASE_URL']?.trim();
  if (raw === undefined || raw.length === 0) return false;
  try {
    return new URL(raw).hostname.toLowerCase() !== OFFICIAL_ANTHROPIC_HOST;
  } catch {
    return true;
  }
}

function configuredClaudeModel(alias: string, environment: NodeJS.ProcessEnv): string | undefined {
  const environmentName = CLAUDE_MODEL_ENVIRONMENT[alias as keyof typeof CLAUDE_MODEL_ENVIRONMENT];
  return (
    validModelName(environmentName === undefined ? undefined : environment[environmentName]) ??
    (alias === 'sonnet' ? validModelName(environment['ANTHROPIC_MODEL']) : undefined)
  );
}

function validModelName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 && normalized.length <= 128
    ? normalized
    : undefined;
}

function withCapabilities(profile: ProfileDefinition, available: boolean): RunnerProfile {
  const goal = {
    id: 'goal',
    runner: profile.runner,
    label: '/goal',
    stateLabel: 'Goal',
    description: COMMON_COMMAND_DESCRIPTIONS.goal,
    inputHint: '/goal',
    source: 'MAR_RUNTIME' as const,
    interaction: 'TOGGLE' as const,
    available,
    reasonCode: available ? null : 'RUNNER_UNAVAILABLE'
  };
  return {
    ...profile,
    commands: [
      ...profile.commands.map((command) =>
        available ? command : { ...command, available: false, reasonCode: 'RUNNER_UNAVAILABLE' }
      ),
      goal
    ],
    capabilities: available
      ? ['history.read', 'events.live', 'turn.start', 'turn.queue', 'turn.interrupt']
      : []
  };
}
