import type { ExecutionMode } from '../runtime/contracts.js';

export type ToolCaller = 'direct' | 'programmatic';

export interface ClientToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Runtime-only provider lowering hint; unsupported adapters fall back to a normal function tool. */
  nativeType?: 'tool_search';
  /** Runtime-only result contract; never forwarded as an upstream tool field. */
  outputSchema?: Record<string, unknown>;
  /** Runtime-only policy. MCP defaults to both callers; other tools default to direct only. */
  allowedCallers?: readonly ToolCaller[];
  /** Runtime-only exposure override; retains both permitted entry points with Code Mode enabled. */
  codeModeExposure?: 'both';
  inputMode?: 'json' | 'freeform';
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
  permission?: import('./permissions.js').ToolPermission | null;
}
export interface ToolExecutionContext {
  mode: ExecutionMode;
  signal: AbortSignal;
  waitInterrupt?: import('./wait.js').ToolWaitInterrupt | undefined;
  sessionId: string;
  executionId: string;
  /** Current model identity for neutral Host-owned tool policies. */
  modelId?: string;
  recentImages?: readonly { readonly mimeType: string; readonly data: Buffer }[];
  codeMode?: {
    retainSession?(): Promise<() => Promise<void>>;
    onSettled?(result: CodeCellEventData): Promise<void>;
    supportsImages?: boolean;
    permissionStop?(): import('./permissions.js').PermissionStop | undefined;
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
export interface MarAgentToolImageArtifact {
  kind: 'image';
  name: string;
  mimeType: 'image/png';
  byteSize: number;
  sha256: string;
  fileName: string;
}
export type MarAgentToolArtifact = MarAgentToolImageArtifact;
export interface ToolExecutionResult {
  calls?: readonly import('./code-mode/observations.js').CodeToolCallRecord[];
  content: string;
  observations?: readonly import('./code-mode/observations.js').CodeObservation[];
  data?: unknown;
  /** Runtime-only definitions used to encode a Tool Search output. */
  toolSearchTools?: readonly ClientToolDefinition[];
  truncated?: boolean;
  images?: readonly { mimeType: string; dataBase64: string }[];
  artifacts?: readonly MarAgentToolArtifact[];
  /** Host-facing evidence, excluded from model and programmatic guest results. */
  resultExtensions?: readonly import('./result-extensions.js').ToolResultExtension[];
}
export interface CodeCellEventData {
  permissionStop?: import('./permissions.js').PermissionStop;
  calls?: readonly import('./code-mode/observations.js').CodeToolCallRecord[];
  cellId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  waitOutcome?: import('./wait.js').ToolWaitOutcome;
  reason?: 'steer';
  cached?: boolean;
  observations?: readonly import('./code-mode/observations.js').CodeObservation[];
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

export interface ViewImageResult {
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  sha256: string;
}

export interface TodoItem {
  id: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoSnapshot {
  revision: number;
  items: TodoItem[];
}

export interface CodeModeStateEntry {
  readonly key: string;
  readonly value: unknown;
}

export type CodeModeStateMutation =
  | { readonly operation: 'set'; readonly key: string; readonly value: unknown }
  | { readonly operation: 'delete'; readonly key: string };
