import type { MarAgentHost } from '../host/contracts.js';
import type { CoreExtensionSource, CoreRuntimeExtension } from '../extensions/contracts.js';
import type { MarAgentModelConfiguration } from '../model/configuration.js';
import type { ExecutionResult, RolloutBudgetOptions, RunInput } from '../runtime/contracts.js';
import type { MarAgentEvent } from '../runtime/events.js';
import type { MarAgentSessionPage, MarAgentSessionSummary } from '../session/catalog.js';
import type { SessionListInput, SessionSource, SessionTitleUpdateInput } from '../session/types.js';

export interface CreateSessionInput {
  workspace: string;
  title?: string;
}

export type { SessionTitleUpdateInput } from '../session/types.js';

export type {
  HostExecutionExtensions,
  HostSessionResourceSnapshot,
  HostSkill,
  MarAgentHost
} from '../host/contracts.js';
export type {
  AccessMode,
  ExecutionMode,
  ExecutionResult,
  MarAgentImageMetadata,
  RolloutBudgetOptions,
  RunInput,
  RunInputImage
} from '../runtime/contracts.js';
export type { MarAgentEvent, MarAgentEventBase } from '../runtime/events.js';
export type {
  CodeCellEventData,
  MarAgentToolArtifact,
  MarAgentToolImageArtifact,
  McpCatalogTool,
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../tools/contracts.js';

/** A live execution exposes streamed events separately from its terminal result. */
export interface ExecutionHandle extends AsyncIterable<MarAgentEvent> {
  readonly executionId: string;
  result(): Promise<ExecutionResult>;
  /** Signals abort; await result() to observe the terminal status and cleanup. */
  cancel(): void;
}
export type CompactInput = Partial<RunInput> & { readonly async?: boolean };
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
        import('../session/catalog.js').MarAgentHistoryEntry,
        { kind: 'user' }
      >;
    }
  | { readonly status: 'handled' }
  | { readonly status: 'notAccepted' };
/** A persisted Session permits one active main execution at a time. */
export interface MarAgentSession {
  readonly id: string;
  run(input: RunInput): ExecutionHandle;
  plan(input: RunInput): ExecutionHandle;
  steer(input: SteerInput): Promise<SteerResult>;
  compact(input?: CompactInput): ExecutionHandle;
  cancel(executionId: string): Promise<void>;
}
export interface MarAgent {
  extensionDiagnostics(): readonly import('../extensions/contracts.js').CoreExtensionDiagnostic[];
  createSession(input: CreateSessionInput): Promise<MarAgentSession>;
  openSession(sessionId: string): Promise<MarAgentSession>;
  listSessions(input?: SessionListInput): Promise<MarAgentSessionPage>;
  getSession(
    sessionId: string
  ): Promise<MarAgentSessionSummary & { automaticTitlePending: boolean }>;
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
    readonly models: readonly MarAgentModelConfiguration[];
    readonly defaultModelId?: string;
  }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Joins executions/reconfiguration, closes owned resources, and releases borrowed Store leases. */
  dispose(): Promise<void>;
}
export interface CreateMarAgentOptions {
  /** Ready-to-use borrowed Store. The caller closes it after all Agent/Catalog users finish. */
  sessionStore?: import('../session/store/contracts.js').SessionStore;
  mode: 'normal' | 'node';
  host: MarAgentHost;
  models: readonly MarAgentModelConfiguration[];
  defaultModelId?: string;
  systemInstruction?: string;
  workspaceMapping?: {
    readonly logicalPath: string;
    readonly physicalPath: string;
  };
  /** @deprecated Accepted for source compatibility and otherwise ignored. */
  rolloutBudget?: false | RolloutBudgetOptions;
  runtimeExtensions?: readonly CoreRuntimeExtension[] | CoreExtensionSource;
}

export type { MarAgentSessionSummary, SessionListInput, SessionSource };
