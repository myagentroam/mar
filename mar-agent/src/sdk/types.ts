import type { AgentHost } from '../host/contracts.js';
import type { ExtensionSource, AgentExtension } from '../extensions/contracts.js';
import type { AgentModelConfiguration } from '../model/configuration.js';
import type { RunInput } from '../runtime/contracts.js';
import type { CompactInput, ExecutionHandle } from '../runtime/execution-handle.js';
import type { AgentSessionPage, AgentSessionSummary } from '../session/catalog.js';
import type { SessionListInput, SessionSource, SessionTitleUpdateInput } from '../session/types.js';

export interface CreateSessionInput {
  workspace: string;
  title?: string;
  /** Optional creation relationship; authorization and depth are owned by the Host. */
  parentSessionId?: string;
  /** Optional provenance snapshot; it cannot contradict the creation relationship. */
  source?: SessionSource;
}

export type { SessionTitleUpdateInput } from '../session/types.js';

export type {
  HostExecutionExtensions,
  HostSessionResourceSnapshot,
  HostSkill,
  AgentHost
} from '../host/contracts.js';
export type {
  ExecutionMode,
  ExecutionResult,
  AgentImageMetadata,
  RunInput,
  RunInputImage
} from '../runtime/contracts.js';
export type { AgentEvent, AgentEventBase } from '../runtime/events.js';
export type { CompactInput, ExecutionHandle } from '../runtime/execution-handle.js';
export type {
  CodeCellEventData,
  ExecOutputSnapshot,
  AgentToolArtifact,
  AgentToolImageArtifact,
  McpCatalogTool,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../tools/contracts.js';

export interface SteerInput {
  readonly expectedExecutionId: string;
  readonly prompt: string;
  readonly modelText?: string;
  readonly clientMessageId: string;
  readonly images?: RunInput['images'];
}
export type SteerResult =
  | {
      readonly status: 'accepted';
      readonly entry: Extract<
        import('../session/catalog.js').AgentSessionHistoryEntry,
        { kind: 'user' }
      >;
    }
  | { readonly status: 'handled' }
  | { readonly status: 'notAccepted' };
/** A persisted Session permits one active main execution at a time. */
export interface AgentSession {
  readonly id: string;
  /** Subscribe to future events and atomically capture the currently active Execution, if any. */
  subscribe(listener: (event: import('../runtime/events.js').AgentEvent) => void): {
    readonly activeExecutionId?: string;
    /** Terminal fact already published by the still-admitted Execution, if any. */
    readonly terminalEvent?: Extract<
      import('../runtime/events.js').AgentEvent,
      { type: 'execution.completed' | 'execution.failed' | 'execution.cancelled' }
    >;
    unsubscribe(): void;
  };
  run(input: RunInput): ExecutionHandle;
  plan(input: RunInput): ExecutionHandle;
  steer(input: SteerInput): Promise<SteerResult>;
  compact(input?: CompactInput): ExecutionHandle;
  cancel(executionId: string): Promise<void>;
  /** Join a currently owned Execution after its cleanup, without cancelling it. */
  joinExecution(
    executionId: string
  ): Promise<import('../runtime/contracts.js').ExecutionResult> | undefined;
}
/** A Session already owned by this Agent, with no history opening or replay. */
export interface AgentLiveSession {
  readonly id: string;
  readonly workspace: string;
  readonly source: SessionSource;
  readonly subscribe: AgentSession['subscribe'];
}
export interface Agent {
  extensionDiagnostics(): readonly import('../extensions/contracts.js').ExtensionDiagnostic[];
  /** Atomically subscribe to future admitted Executions and snapshot currently admitted Sessions. */
  observeSessionExecutions(listener: (session: AgentLiveSession) => void): {
    readonly sessions: readonly AgentLiveSession[];
    unsubscribe(): void;
  };
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  openSession(sessionId: string): Promise<AgentSession>;
  listSessions(input?: SessionListInput): Promise<AgentSessionPage>;
  getSession(sessionId: string): Promise<AgentSessionSummary & { automaticTitlePending: boolean }>;
  /** Read persisted Session history without opening or starting an Execution. */
  sessionHistory: import('../session/catalog.js').AgentSessionCatalog['history'];
  sessionInputReceipt: import('../session/catalog.js').AgentSessionCatalog['inputReceipt'];
  /** Check an unfinished persisted Execution under the Session's exclusive writer admission. */
  sessionExecutionWasInterrupted(
    sessionId: string,
    executionId: string,
    input?: { readonly signal?: AbortSignal }
  ): Promise<boolean>;
  setSessionTitle(
    sessionId: string,
    title: string,
    input?: SessionTitleUpdateInput
  ): Promise<boolean>;
  clearSession(sessionId: string): Promise<void>;
  /** Updates future execution snapshots only; undefined clears the Host instruction extension. */
  setSystemInstruction(systemInstruction?: string): void;
  /** Rebinds future main executions only; running subagents keep their captured model providers. */
  reconfigureModels(input: {
    readonly models: readonly AgentModelConfiguration[];
    readonly defaultModelId?: string;
  }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Deletes the explicit members under one maintenance admission; never infers descendants. */
  deleteSessions(sessionIds: readonly string[]): Promise<void>;
  /** Joins executions/reconfiguration, closes owned resources, and releases borrowed Store leases. */
  dispose(): Promise<void>;
}
export interface CreateAgentOptions {
  /** Ready-to-use borrowed Store. The caller closes it after all Agent/Catalog users finish. */
  sessionStore?: import('../session/store/contracts.js').SessionStore;
  mode: 'normal' | 'node';
  host: AgentHost;
  models: readonly AgentModelConfiguration[];
  defaultModelId?: string;
  systemInstruction?: string;
  workspaceMapping?: {
    readonly logicalPath: string;
    readonly physicalPath: string;
  };
  /** Trusted extensions or an extension source to compose into this Agent. */
  extensions?: readonly AgentExtension[] | ExtensionSource;
}

export type { AgentSessionSummary, SessionListInput, SessionSource };
