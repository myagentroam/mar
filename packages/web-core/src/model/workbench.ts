export type RunnerId = 'codex' | 'claude-code' | 'opencode' | 'mar-agent';

/** The only foreground selection identity in Work mode. */
export interface WorkspaceTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
}

export interface WorkspaceTab {
  readonly id: string;
  readonly nodeId: string;
  readonly nodeLabel?: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly lastActiveAt: number;
  readonly selectedSessionId?: string;
  readonly pinned?: boolean;
}

export type { NodeSummary } from './node.js';

export interface Workspace {
  readonly id: string;
  readonly displayName?: string;
  readonly groupName?: string | null;
  readonly path: string;
  readonly kind: 'DIRECTORY' | 'GIT_WORKSPACE';
  readonly manageable?: boolean;
  readonly gitSummary?: { readonly branch: string | null };
}

export interface RunnerCommandState {
  readonly commandId: string;
  readonly active: boolean;
  readonly label: string;
  readonly detail: string | null;
  readonly closable: boolean;
  readonly closeInput: string | null;
  readonly goal?: {
    readonly id: string;
    readonly objective: string;
    readonly revision: number;
    readonly status: 'active' | 'completed' | 'blocked';
    readonly turns?: number;
  };
  readonly continuation?: { readonly label: string; readonly prompt: string } | null;
}

export interface GoalExitSummary {
  readonly status: 'removed' | 'stopped';
  readonly elapsedWallMs: number;
  readonly turns: number;
}

export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly runner: RunnerId;
  readonly externalSessionId?: string | null;
  readonly nativeControl?: 'MAR_MANAGED' | 'EXTERNAL';
  readonly customTitle?: string | null;
  readonly sessionPrompt?: string | null;
  readonly runnerTitle?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly access?: string | null;
  readonly lastActivityAt?: number;
  readonly pinOrder?: number | null;
  readonly pinnedAt?: number | null;
  readonly schedule?: { readonly enabled: boolean; readonly nextRunAt: number | null } | null;
  readonly canMovePinUp?: boolean;
  readonly canMovePinDown?: boolean;
  readonly externalDiscovered?: boolean;
  readonly activity?: 'MANAGED_ACTIVE' | 'IDLE';
  readonly control?: { readonly level?: string; readonly capabilities?: readonly string[] };
  readonly runtime?: { readonly capabilities?: readonly string[] };
  readonly commandStates?: readonly RunnerCommandState[];
}

export interface RunnerCommand {
  readonly id: string;
  readonly runner: Session['runner'];
  readonly label: string;
  readonly stateLabel?: string;
  readonly description: string;
  readonly inputHint: string;
  readonly source: 'CODEX_APP_SERVER' | 'CLAUDE_AGENT_SDK' | 'OPENCODE_SERVER' | 'MAR_RUNTIME';
  readonly interaction:
    'RUNNER_TEXT' | 'IMMEDIATE_ACTION' | 'DESTRUCTIVE_ACTION' | 'TOGGLE' | 'VALUE';
  readonly available: boolean;
  readonly reasonCode: string | null;
}

export interface QuickPrompt {
  readonly id: string;
  readonly phrase: string;
  readonly prompt: string;
  readonly updatedAt: number;
}

export interface RunnerProfile {
  readonly runner: Session['runner'];
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly supportedEfforts: readonly string[];
    readonly isDefault?: boolean;
    readonly defaultEffort?: string;
  }[];
  readonly accessOptions: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly commands: readonly RunnerCommand[];
  readonly capabilities: readonly string[];
}

export interface RunnerDefaultConfiguration {
  readonly runner: Session['runner'];
  readonly model: string;
  readonly effort: string;
  readonly access: string;
}

export interface AgentRun {
  readonly id: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly status: string;
  readonly recoveryState: string;
  readonly clientMessageId: string;
  readonly version?: number;
  readonly createdAt?: number;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
}

export interface RunEvent {
  readonly runId?: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly status?: AgentRun['status'];
  readonly createdAt?: number;
}

export interface WorkspaceQueueItem {
  readonly queueItemId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runner: Session['runner'];
  readonly clientMessageId: string;
  readonly sessionTitle: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface WorkspaceQueue {
  readonly version: number;
  readonly paused: boolean;
  readonly items: readonly WorkspaceQueueItem[];
}

export interface ConversationItem {
  readonly processGroup?: { readonly id: string; readonly isStart?: true | undefined };
  readonly parentItemId?: string | null;
  readonly permissionStop?: import('@myagentroam/protocol').PermissionStop;
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: unknown;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly segmentId?: string;
  readonly segmentIndex?: number;
}

export interface ConversationTurn {
  readonly id: string;
  /** Original protocol Turn ID when this Web projection represents one Segment. */
  readonly turnId?: string;
  readonly segmentIndex?: number;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly status: string;
  readonly rewind?: { readonly before: string | null; readonly after: string };
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly items: readonly ConversationItem[];
}

export interface ConversationSegmentPage {
  readonly unit?: 'SEGMENT';
  readonly segments: Array<{
    readonly id: string;
    readonly turnId: string;
    readonly sessionId: string;
    readonly runId: string | null;
    readonly index: number;
    readonly status: string;
    readonly rewind?: { readonly before: string | null; readonly after: string };
    readonly items: readonly ConversationItem[];
    readonly startedAt?: number | null;
    readonly completedAt?: number | null;
  }>;
  readonly nextCursor: string | null;
  readonly snapshotSequence?: number;
  readonly source?: 'official' | 'native' | 'runtime';
  readonly readAt?: number;
  readonly latestVisibleAt?: number;
  readonly deferredOlderHistory?: boolean;
}

export interface ConversationTurnPage {
  readonly turns: ConversationTurn[];
  readonly nextCursor: string | null;
  readonly snapshotSequence?: number;
  readonly source?: 'official' | 'native' | 'runtime';
  readonly readAt?: number;
  readonly latestVisibleAt?: number;
  readonly deferredOlderHistory?: boolean;
}

export interface Approval {
  readonly id: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  readonly payload: unknown;
  readonly expiresAt: number;
  readonly createdAt?: number;
  readonly decidedAt?: number | null;
}

export interface ComposerAttachment {
  readonly id: string;
  readonly file: File;
  readonly previewUrl: string | null;
  readonly nodeId: string;
  readonly workspaceId: string;
  uploadId?: string;
  receivedBytes: number;
  status: 'UPLOADING' | 'COMPLETED' | 'FAILED';
  transport?: 'DIRECT' | 'SERVER';
  directFallback?: boolean;
  error?: string;
}

export interface CachedSessionDetail {
  readonly sessionId: string;
  runs: readonly AgentRun[];
  turns: readonly ConversationTurn[];
  nextCursor: string | null;
  contextUsage:
    | {
        readonly model: string | null;
        readonly usedTokens: number;
        readonly maxTokens: number;
        readonly percentage: number;
      }
    | null
    | undefined;
  lastAccessedAt: number;
}

export interface WorkspaceViewCache {
  readonly nodeId: string;
  readonly workspaceId: string;
  sessions: readonly Session[];
  selectedSessionId?: string;
  /** Composer text and configuration for the current Workspace; its tab state owns attachments and uploads. */
  draft?: {
    readonly input: string;
    readonly skillTokens: readonly ComposerSkillToken[];
    readonly references?: readonly import('@myagentroam/protocol').ComposerFileReference[];
    readonly runner: RunnerId;
    readonly model: string;
    readonly effort: string;
    readonly access: string;
  };
  /** Stores only safely restorable inspector views, excluding file body blobs and incomplete uploads. */
  inspector?: unknown;
  readonly queues: Map<string, WorkspaceQueue>;
  readonly sessionDetails: Map<string, CachedSessionDetail>;
}

export interface ComposerSkillToken {
  readonly name: string;
  readonly source: 'NODE_HOME' | 'WORKSPACE';
  readonly skillFilePath: string;
  readonly available: boolean;
}
export type { UserSessionSummary } from '../service/admin-auth-service.js';
export interface NodeWorkbenchManifest {
  readonly manifestVersion: number;
  readonly observedAt: number;
  readonly nodeGeneration?: string;
  readonly conversation: { readonly available: boolean; readonly reasonCode: string | null };
  readonly files?: { readonly available: boolean; readonly reasonCode: string | null };
  readonly directTransfer?: {
    readonly apiVersion: 2 | 3;
    readonly transport: boolean;
    readonly upload: boolean;
    readonly download: boolean;
    readonly range: boolean;
    readonly gitCommitBlob: boolean;
    readonly maxChunkBytes: number;
  };
  readonly terminalDirect?: { readonly apiVersion: 1; readonly transport: true };
  readonly git?: {
    readonly available: boolean;
    readonly reasonCode: string | null;
    readonly supportsHistory?: boolean;
  };
  readonly terminal?: {
    readonly available: boolean;
    readonly reasonCode: string | null;
    readonly supportsReplay: boolean;
    readonly supportsConPty: boolean;
    readonly supportsTakeover: boolean;
    readonly profiles: readonly {
      readonly id: string;
      readonly label: string;
      readonly isDefault: boolean;
    }[];
  };
}
