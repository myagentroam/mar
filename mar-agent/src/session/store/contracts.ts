import type { SessionModelMessage as ModelMessage } from '../model-request.js';
import type { ExtensionCheckpoint, ExtensionJsonValue } from '../extension-checkpoint.js';
import type { ModelUsage } from '../../model/contracts.js';
import type { EnvironmentContextState } from '../../runtime/context/contracts.js';
import type { CodeModeStateEntry } from '../code-state.js';
import type { AvailableToolResultResource } from '../../tools/result-extension-contract.js';
import type { AgentSessionPage, AgentSessionSummary } from '../summary.js';
import type { ContextGcCheckpointDraft } from '../context-gc-contract.js';
import type { SessionResource } from '../resource-contract.js';
import type { ToolResultResourceInput, ToolResultResourcePage } from '../tool-result-resources.js';
import type { SessionListInput, SessionSource, SessionTitleUpdateInput } from '../types.js';
import type { AgentSessionRollbackInput } from '../rollback.js';
import type {
  CompactHistoryMessage,
  RestoredSessionInputImage,
  SessionExecutionState,
  SessionInputImage,
  SessionInputImageData,
  SessionInputImageMetadata,
  SessionRecord
} from './types.js';

export type {
  CompactHistoryMessage,
  CompactUserInput,
  RestoredSessionInputImage,
  SessionExecutionState,
  SessionInputImage,
  SessionInputImageData,
  SessionInputImageMetadata,
  SessionRecord
} from './types.js';
export type { CodeModeStateEntry } from '../code-state.js';
export type { SessionResource } from '../resource-contract.js';
export type { TodoSnapshot, TodoItem } from '../todo.js';
export type { CodeToolCallRecord, CodeObservation } from '../code-observation-contract.js';
export type { SessionModelMessage as ModelMessage } from '../model-request.js';
export type {
  ModelUsage,
  ModelInputMetadata,
  ModelTextBlock,
  ModelContextualBlock
} from '../../model/contracts.js';
export type { EnvironmentContextState } from '../../runtime/context/contracts.js';
export type {
  ContextGcCheckpointDraft,
  ContextGcBase,
  ContextGcPlatform,
  ContextGcEconomicsPolicy,
  ContextGcMetrics,
  ContextGcReplacement,
  ContextGcTarget,
  ContextGcReadItemReplacement
} from '../context-gc-contract.js';
export type { ContextGcWebToolName, ContextGcSubagentToolName } from '../context-gc-contract.js';
export type { AvailableToolResultResource } from '../../tools/result-extension-contract.js';

/** Logical Session identity, without a physical index or recovery layout. */
export interface SessionStoreSession {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  lastActivityAt: string;
  source?: SessionSource | undefined;
}

export interface SessionRecordInput {
  type: string;
  payload: unknown;
  executionId?: string;
  turnId?: string;
  timestamp?: string;
}

export interface SessionStoreCompactInput {
  summary: string;
  replacementHistory?: readonly CompactHistoryMessage[];
  retainedModelContext?: readonly ModelMessage[];
  inlineMediaState?: import('../inline-media.js').InlineMediaState;
  pendingInputs?: readonly SessionRecord[];
  snapshotRecordId?: string;
  snapshotMessageCount?: number;
  environment?: EnvironmentContextState;
  automatic?: boolean;
  modelId?: string;
  contextWindowTokens?: number;
  usage?: ModelUsage;
  executionId?: string;
  turnId?: string;
}

/** Store-issued ownership spanning SDK cleanup and the final durable mutation. */
export interface SessionStoreMaintenance {
  readonly sessionIds: readonly string[];
  /** Idempotent; releases maintenance only, never another owner's Execution/retained references. */
  release(): Promise<void>;
}

/**
 * Session persistence port. Implementations preserve record order, committed-resource
 * visibility and the existing per-Session writer/checkpoint atomic boundaries.
 * Owned handles are closed by their creator; injected instances are borrowed.
 */
export interface SessionStore {
  createSession(input: {
    title?: string;
    workspace: string;
    source?: SessionSource;
  }): Promise<SessionStoreSession>;
  getSession(sessionId: string): Promise<AgentSessionSummary & { automaticTitlePending: boolean }>;
  list(input?: SessionListInput): Promise<AgentSessionPage>;
  listSubagentChildren(parentSessionId: string): Promise<
    Array<
      AgentSessionSummary & {
        source: Extract<SessionSource, { type: 'subagent' }>;
      }
    >
  >;
  executionConfiguration(sessionId: string): Promise<
    | {
        readonly modelId: string;
        readonly modelName?: string;
        readonly reasoningEffort?: string;
      }
    | undefined
  >;
  firstUserMessagePreview(sessionId: string): Promise<string | undefined>;
  sessionTree(sessionId: string): Promise<readonly string[]>;
  updateTitle(
    sessionId: string,
    title: string,
    input?: SessionTitleUpdateInput,
    owner?: object
  ): Promise<boolean>;
  append(
    sessionId: string,
    input: SessionRecordInput,
    options?: { readonly signal?: AbortSignal }
  ): Promise<SessionRecord>;
  read(sessionId: string): Promise<SessionRecord[]>;
  readPage(
    sessionId: string,
    input?: { limit?: number; beforeSequence?: number }
  ): Promise<{
    records: SessionRecord[];
    previousBeforeSequence?: number;
  }>;
  readExecutionState(sessionId: string): Promise<SessionExecutionState>;
  userTurnCount(sessionId: string): Promise<number>;
  readContextualWorldState(sessionId: string): Promise<unknown | undefined>;
  writeContextualWorldState(sessionId: string, state: unknown): Promise<void>;
  readCodeModeState(sessionId: string): Promise<CodeModeStateEntry[]>;
  commitCodeModeState(
    sessionId: string,
    mutations: unknown,
    input: {
      readonly executionId: string;
      readonly turnId: string;
      readonly expectedState?: readonly CodeModeStateEntry[];
    }
  ): Promise<CodeModeStateEntry[]>;
  readExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string
  ): Promise<ExtensionCheckpoint>;
  writeExtensionCheckpoint(
    sessionId: string,
    extensionId: string,
    key: string,
    value: ExtensionJsonValue | undefined,
    expectedRevision: number | undefined,
    input: {
      owner: object;
      signal: AbortSignal;
      executionId?: string;
      turnId?: string;
    }
  ): Promise<ExtensionCheckpoint>;
  compact(
    sessionId: string,
    input: SessionStoreCompactInput,
    options?: {
      readonly signal?: AbortSignal;
    }
  ): Promise<SessionRecord>;
  commitContextGc(
    sessionId: string,
    draft: ContextGcCheckpointDraft,
    planningRecords?: readonly SessionRecord[]
  ): Promise<SessionRecord>;
  persistInputImages(
    sessionId: string,
    images: readonly SessionInputImage[]
  ): Promise<SessionInputImageMetadata[]>;
  persistResource(
    sessionId: string,
    image: import('../../model/image.js').ModelImage
  ): Promise<SessionResource>;
  setResourceUrl(
    sessionId: string,
    resourceId: string,
    published: { url: string; urlExpiresAt: number }
  ): Promise<SessionResource>;
  readResource(
    sessionId: string,
    resourceId: string
  ): Promise<{ mimeType: string; dataBase64: string } | undefined>;
  readInputImages(sessionId: string, value: unknown): Promise<RestoredSessionInputImage[]>;
  readInputImage(
    sessionId: string,
    input: {
      readonly sequence: number;
      readonly imageIndex: number;
    }
  ): Promise<SessionInputImageData | undefined>;
  writeToolResultResource(sessionId: string, text: string): Promise<AvailableToolResultResource>;
  readToolResultResource(
    sessionId: string,
    input: ToolResultResourceInput
  ): Promise<ToolResultResourcePage>;
  /** One main Execution per Session; an owner may reuse its healthy retained writer. */
  acquireSessionLease(sessionId: string, owner?: object): Promise<() => Promise<void>>;
  /** Native writes join the same owner's writer, without admitting another Execution. */
  acquireSessionWriteLease(sessionId: string, owner: object): Promise<() => Promise<void>>;
  /** Retention requires the originating owner to hold an active Execution lease. */
  retainSessionLease(sessionId: string, owner: object): Promise<() => Promise<void>>;
  hasRetainedSessionLease(sessionId: string, owner: object): boolean;
  /** Conflicts fail before cleanup; delete admits only the explicit members, or the given Session. */
  acquireSessionMaintenance(
    sessionId: string,
    kind: 'clear' | 'delete',
    owner?: object,
    members?: readonly string[]
  ): Promise<SessionStoreMaintenance>;
  forkSession(
    sessionId: string,
    input: {
      readonly boundaryTurnId: string | null;
      readonly title: string;
    }
  ): Promise<SessionStoreSession>;
  rollbackSession(
    sessionId: string,
    input: AgentSessionRollbackInput
  ): Promise<AgentSessionSummary>;
  clearSession(
    sessionId: string,
    maintenance?: SessionStoreMaintenance
  ): Promise<AgentSessionSummary>;
  delete(
    sessionId: string,
    maintenance?: SessionStoreMaintenance
  ): Promise<{ readonly deleted: boolean }>;
  /** Stop using the handle and release its leases before closing it. Never preempts other owners. */
  close(): Promise<void>;
}
