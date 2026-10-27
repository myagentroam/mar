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
  run(input: RunInput): ExecutionHandle;
  plan(input: RunInput): ExecutionHandle;
  steer(input: SteerInput): Promise<SteerResult>;
  compact(input?: CompactInput): ExecutionHandle;
  cancel(executionId: string): Promise<void>;
}
export interface Agent {
  extensionDiagnostics(): readonly import('../extensions/contracts.js').ExtensionDiagnostic[];
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  openSession(sessionId: string): Promise<AgentSession>;
  listSessions(input?: SessionListInput): Promise<AgentSessionPage>;
  getSession(sessionId: string): Promise<AgentSessionSummary & { automaticTitlePending: boolean }>;
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
