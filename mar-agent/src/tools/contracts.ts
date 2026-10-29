import type { ExecutionMode } from '../runtime/contracts.js';
import type { ModelToolDefinition } from '../model/contracts.js';
import type { CodeModeStateEntry, CodeModeStateMutation } from '../session/code-state.js';
export type { CodeModeStateEntry, CodeModeStateMutation } from '../session/code-state.js';
export type { TodoItem, TodoSnapshot } from '../session/todo.js';

export type ToolCaller = 'direct' | 'programmatic';

export interface ClientToolDefinition extends ModelToolDefinition {
  /** Runtime-only result contract; never forwarded as an upstream tool field. */
  outputSchema?: Record<string, unknown>;
  /** Runtime-only policy. MCP defaults to both callers; other tools default to direct only. */
  allowedCallers?: readonly ToolCaller[];
  /** Runtime-only exposure override; retains both permitted entry points with Code Mode enabled. */
  codeModeExposure?: 'both';
  parallelSafety?: 'safe' | 'serial';
  /** Preserved business-schema eligibility after framework metadata projection. */
  parameterless?: boolean;
  /** Runtime-only Agent catalog scope; never forwarded as an upstream tool field. */
  agentScope?: 'ROOT_AND_SUBAGENTS' | 'ROOT_ONLY';
}
export interface ToolCall {
  name: string;
  arguments: unknown;
  callId?: string;
  /** Framework metadata for native invocations, never a business argument. */
  permission?: import('./permission-contract.js').ToolPermission | null;
}
export interface ToolExecutionContext {
  mode: ExecutionMode;
  signal: AbortSignal;
  waitInterrupt?: import('./wait.js').ToolWaitInterrupt | undefined;
  /** Live-only process output; does not consume the eventual tool result. */
  onOutput?: (output: ExecOutputSnapshot) => Promise<void>;
  sessionId: string;
  executionId: string;
  /** Current model identity for neutral Host-owned tool policies. */
  modelId?: string;
  recentImages?: readonly { readonly mimeType: string; readonly data: Buffer }[];
  codeMode?: {
    retainSession?(): Promise<() => Promise<void>>;
    onSettled?(result: CodeCellEventData): Promise<void>;
    supportsImages?: boolean;
    permissionStop?(): import('./permission-contract.js').PermissionStop | undefined;
    tools: readonly ClientToolDefinition[];
    state?: readonly CodeModeStateEntry[];
    commitState?(
      mutations: readonly CodeModeStateMutation[]
    ): Promise<readonly CodeModeStateEntry[]>;
    invoke(call: ToolCall, signal: AbortSignal): Promise<ToolExecutionResult>;
  };
}
export interface McpToolCatalogContext extends Pick<
  ToolExecutionContext,
  'sessionId' | 'executionId' | 'modelId'
> {
  executionScopeId?: string;
  claimExecutionScope?: boolean;
}
export interface McpToolCatalog {
  readonly revision: string;
  readonly servers: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly instructions?: string;
  }[];
  readonly tools: readonly McpCatalogTool[];
}
export interface McpCatalogTool {
  readonly definition: ClientToolDefinition;
  readonly serverId: string;
  readonly rawName: string;
  readonly sourceIdentity: string;
  readonly definitionRevision: string;
  readonly lifetime: 'session' | 'execution';
  readonly exposure: 'direct' | 'deferred';
  /** Untrusted MCP hints; never an authorization or parallel-safety decision. */
  readonly annotations?: Readonly<Record<string, unknown>>;
}
export interface McpToolCallContext extends Pick<
  ToolExecutionContext,
  'sessionId' | 'executionId'
> {
  readonly mode?: ExecutionMode;
  readonly expectedTool?: {
    readonly sourceIdentity: string;
    readonly definitionRevision: string;
  };
}
export interface AgentToolImageArtifact {
  kind: 'image';
  name: string;
  mimeType: 'image/png';
  byteSize: number;
  sha256: string;
  fileName: string;
}
export type AgentToolArtifact = AgentToolImageArtifact;
export interface ExecOutputSnapshot {
  processId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  displayOutput?: ExecDisplayOutput;
}

/** Bounded, non-consuming tail for public presentation, not model output. */
export interface ExecDisplayOutput {
  stdout: string;
  stderr: string;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
}

export interface ToolExecutionResult {
  calls?: readonly import('../session/code-observation-contract.js').CodeToolCallRecord[];
  content: string;
  observations?: readonly import('../session/code-observation-contract.js').CodeObservation[];
  /** Explicit, bounded public structured projection; never inferred from data. */
  eventData?: Readonly<Record<string, unknown>>;
  data?: unknown;
  /** Runtime-only definitions used to encode a Tool Search output. */
  toolSearchTools?: readonly ClientToolDefinition[];
  truncated?: boolean;
  images?: readonly import('../model/image-contract.js').ModelImage[];
  artifacts?: readonly AgentToolArtifact[];
  /** Host-facing evidence, excluded from model and programmatic guest results. */
  resultExtensions?: readonly import('./result-extension-contract.js').ToolResultExtension[];
}
export interface CodeCellEventData {
  permissionStop?: import('./permission-contract.js').PermissionStop;
  calls?: readonly import('../session/code-observation-contract.js').CodeToolCallRecord[];
  cellId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  waitOutcome?: import('./wait.js').ToolWaitOutcome;
  reason?: 'steer';
  cached?: boolean;
  truncated?: boolean;
  observations?: readonly import('../session/code-observation-contract.js').CodeObservation[];
}
export interface ExecResult {
  status: 'running' | 'completed' | 'cancelled';
  waitOutcome?: import('./wait.js').ToolWaitOutcome;
  reason?: 'steer';
  processId?: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  /** A terminal snapshot replay rather than new process output. */
  cached?: boolean;
  displayOutput?: ExecDisplayOutput;
}
export interface ApplyPatchFileResult {
  path: string;
  targetPath?: string;
  operation: 'added' | 'modified' | 'deleted' | 'moved';
  addedLines: number;
  deletedLines: number;
}
export interface ApplyPatchResult {
  files: ApplyPatchFileResult[];
  totals: { files: number; addedLines: number; deletedLines: number };
}
export interface ApplyPatchPartialResult extends ApplyPatchResult {
  failedFile: string;
  pendingFiles: string[];
}
export interface ReadEventData {
  mode: 'batch';
  results: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    error?: { code: string; message: string };
  }>;
  truncated: boolean;
}

export interface ViewImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewImageResult {
  /** The input source; transformations may produce a different output resource. */
  path?: string;
  resourceId?: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  region?: ViewImageRegion;
  sha256: string;
}

export interface SleepResult {
  durationMs: number;
  elapsedMs: number;
  wakeReason: 'elapsed' | 'steer' | 'subagent_message';
}
