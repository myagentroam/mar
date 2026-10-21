import type { ComputerUseCapability, ConversationHostingCapability } from '@myagentroam/protocol';
import type { RunnerUsage, RunnerUsageName } from '../service/RunnerUsageService.js';

export interface NodeDetailsHostingState {
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly hint: string;
  readonly changing: boolean;
}

export interface NodeDetailsRunnerCapability {
  readonly available?: boolean;
  readonly version?: string;
}

export interface NodeDetailsData {
  readonly id: string;
  readonly label: string;
  readonly registeredAddress?: string | undefined;
  readonly platform?: string | undefined;
  readonly architecture?: string | undefined;
  readonly nodeAppVersion?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly metadata?:
    | (Readonly<Record<string, unknown>> & {
        readonly osRelease?: string;
        readonly upgrade?: {
          readonly state?: 'WAITING_FOR_RUNS' | 'READY_TO_RESTART' | 'FAILED';
          readonly activeRunCount?: number;
          readonly errorCode?: string;
        };
        readonly runtimeCommands?: readonly unknown[];
      })
    | undefined;
  readonly connected?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly manageable?: boolean | undefined;
  readonly secretManageable?: boolean | undefined;
  readonly capabilities?:
    | {
        readonly codex?: NodeDetailsRunnerCapability;
        readonly claudeCode?: NodeDetailsRunnerCapability;
        readonly openCode?: NodeDetailsRunnerCapability;
        readonly conversationHosting?: ConversationHostingCapability;
        readonly computerUse?: ComputerUseCapability;
      }
    | undefined;
}

export interface WorkspaceDetailsData {
  readonly preserveGitConfig?: boolean | undefined;
  readonly id: string;
  readonly label: string;
  readonly path?: string | undefined;
  readonly kind?: 'DIRECTORY' | 'GIT_WORKSPACE' | undefined;
  readonly gitSummary?: { readonly branch: string | null } | undefined;
}

export interface NodeDetailsUpgradeState {
  readonly label: string;
  readonly canUpgrade: boolean;
  readonly waitingForRuns: boolean;
  readonly canCancelUpgrade: boolean;
}

export interface NodeDetailsProps {
  nodeOpen: boolean;
  workspaceOpen: boolean;
  usageOpen: boolean;
  node?: NodeDetailsData | undefined;
  workspace?: WorkspaceDetailsData | undefined;
  workspaceNodeId?: string | undefined;
  workspaceNodeLabel?: string | undefined;
  workspaceSecretManageable?: boolean | undefined;
  workspaceNodeConnected?: boolean | undefined;
  workspaceGitManageable?: boolean | undefined;
  usage?: RunnerUsage | undefined;
  usageLoading?: RunnerUsageName | undefined;
  usageDisabledReason: (runner: RunnerUsageName) => string;
  ownershipTypeLabel?: string | undefined;
  ownershipTypeTag?: 'info' | 'primary' | undefined;
  ownerLabel?: string | undefined;
  secretWritable?: boolean;
  nodeRefreshable?: boolean;
  nodeRefreshing?: boolean;
  upgrade?: NodeDetailsUpgradeState | undefined;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}
