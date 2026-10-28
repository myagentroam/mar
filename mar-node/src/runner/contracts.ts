import type {
  RunnerName,
  NodeEnvelope,
  RunnerCommandDescriptor,
  RunnerCommandState,
  SessionActivityState
} from '@myagentroam/protocol';
import type { ExternalSessionActivationState, NodeAgentSession } from '../session/contracts.js';
import type { NodeWorkspace } from '../workspace/contracts.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { NativeTranscriptImageAttachment } from '../native-transcript-model.js';
import type { RunnerExecutionContext } from './execution-context.js';

export type RunnerExecutionStatus =
  'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export type ChannelDelivery = 'PENDING_RECEIPT' | 'STEERED' | 'QUEUED_NEXT_TURN' | 'REJECTED';
export interface RunnerSessionControl {
  readonly level: 'MANAGED';
  readonly capabilities: readonly (
    'history.read' | 'events.live' | 'turn.start' | 'turn.steer' | 'turn.interrupt'
  )[];
}

export type RegisteredRunnerName = RunnerName | 'fake';
export interface RunnerSteerInput {
  readonly expectedExecutionId: string;
  readonly prompt: string;
  readonly modelText: string;
  readonly clientMessageId: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly access: string | null;
  readonly collaborationMode: 'default' | 'plan';
  readonly images: readonly {
    readonly name: string;
    readonly mimeType: string;
    readonly dataBase64: string;
  }[];
}
export type RunnerSteerResult =
  | {
      readonly status: 'accepted';
      readonly item: {
        readonly itemId: string;
        readonly kind: 'user_message';
        readonly status: 'COMPLETED';
        readonly payload: Record<string, unknown>;
      };
    }
  | { readonly status: 'handled' | 'notAccepted' };

export interface RunnerCommandContext {
  readonly secretEnvironment: Readonly<Record<string, string>>;
  readonly mcpInstallations?: unknown;
  readonly executionContext?: RunnerExecutionContext;
  readonly initiatedByUserId?: number;
}
export type NativeSessionRemovalResult = boolean | 'MISSING';
export type RunnerHistoryImageRegistrar = (
  images: readonly NativeTranscriptImageAttachment[]
) => readonly Record<string, unknown>[];

export type RunnerCancellationIntent = 'CANCEL' | 'INTERRUPT';

export interface RunnerControl {
  steer?(input: RunnerSteerInput): Promise<RunnerSteerResult>;
  start(envelope: NodeEnvelope): void;
  cancel(runId: string, intent: RunnerCancellationIntent): boolean;
  decideApproval?(input: RunnerApprovalDecision): boolean;
  respondUserInput?(runId: string, requestId: string, answers: Record<string, unknown>): boolean;
}

export interface RunnerCommandControl {
  execute(
    session: NodeAgentSession,
    command: RunnerCommandDescriptor,
    input: string,
    context: RunnerCommandContext
  ): Promise<unknown>;
}

export interface RunnerApprovalDecision {
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
}

export interface RunnerDiscoveryContext {
  readonly cleanup?: boolean;
  readonly workspaces: readonly NodeWorkspace[];
  createProjection(input: {
    readonly workspace: NodeWorkspace;
    readonly runner: RunnerName;
    readonly externalSessionId: string;
    readonly cwd: string;
    readonly title?: string;
    readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW' | 'NATIVE';
    readonly lastActivityAt?: number;
  }): NodeAgentSession;
}

export interface ExternalResumeContext {
  readonly available: boolean;
  projectionFor(session: NodeAgentSession): NodeAgentSession | undefined;
  managedAliasFor(session: NodeAgentSession): NodeAgentSession | undefined;
  currentResumed(sessionId: string): NodeAgentSession | undefined;
  promote(sessionId: string): NodeAgentSession | undefined;
  ensureConfiguration(session: NodeAgentSession): NodeAgentSession;
  create(session: NodeAgentSession): NodeAgentSession;
  workspacePath(workspaceId: string): string | undefined;
  rememberManagedNative(nativeSessionId: string, sessionId: string): void;
}

export interface ExternalResumeResult {
  readonly session?: NodeAgentSession;
  readonly activity?: ExternalSessionActivationState;
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly messageFailureCode?: string;
}

export interface RunnerContextUsage {
  readonly model?: string | null;
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export interface RunnerProjectionTitleInput {
  readonly externalSessionId: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly titleOrigin?: 'OFFICIAL' | 'PREVIEW' | 'NATIVE';
}

export interface RunnerConversationPage {
  readonly turns: readonly NodeConversationTurn[];
  readonly nextCursor: string | null;
}

export type RunnerConversationHistorySource = 'native' | 'official';

export interface RunnerConversationHistoryReaders {
  readonly session?: NodeAgentSession;
  readonly native: () => Promise<RunnerConversationPage | undefined>;
  readonly official: () => Promise<RunnerConversationPage | undefined>;
}

export interface RunnerConversationHistoryPage extends RunnerConversationPage {
  readonly source: RunnerConversationHistorySource;
}

export interface RunnerConversationRewindInput {
  readonly session: Readonly<NodeAgentSession>;
  readonly turns: readonly NodeConversationTurn[];
  readonly managedActive: boolean;
  readonly firstPage: boolean;
  readonly readHistory: (input: {
    readonly limit: number;
  }) => Promise<RunnerConversationHistoryPage | undefined>;
}

export interface RunnerSessionPresentationContext {
  readonly managedActive: boolean;
  readonly commandStates: readonly RunnerCommandState[];
}

export interface RunnerSessionPresentation {
  readonly activity: SessionActivityState;
  readonly control: {
    readonly level: RunnerSessionControl['level'];
    readonly capabilities: RunnerSessionControl['capabilities'];
  };
  readonly runtime: {
    readonly level: RunnerSessionControl['level'];
    readonly capabilities: readonly string[];
    readonly reasonCode: string | null;
  };
  readonly commandStates: readonly RunnerCommandState[];
}
