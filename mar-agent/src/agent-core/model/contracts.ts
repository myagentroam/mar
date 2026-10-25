import type { ClientToolDefinition } from '../tools/contracts.js';
import type { ModelImage } from './image.js';
import type {
  MarAgentModelConfiguration,
  MarAgentReasoningEffort,
  ModelCredentialAcquireReason
} from './configuration.js';
export type { ClientToolDefinition, ToolCaller } from '../tools/contracts.js';

export interface ModelTextBlock {
  readonly text: string;
  readonly cache?: true;
}

export interface ModelInputMetadata {
  source: 'user' | 'parent_agent' | 'extension';
  recordId?: string;
  extensionId?: string;
  truncated?: true;
  smartCompaction?: true;
}

/** SDK-owned provenance. Text labels never grant instruction authority. */
export interface ModelContextualBlock {
  id: string;
  kind: string;
  source: 'sdk' | 'host' | 'extension' | 'runtime';
  authority: 'instruction' | 'context';
  revision: string;
  operation: 'replace' | 'remove';
}

export interface ModelMessage {
  /** Model-facing tool-result status; independent of the actual execution outcome. */
  isError?: boolean;
  calls?: readonly import('../tools/code-mode/observations.js').CodeToolCallRecord[];
  role: 'user' | 'assistant' | 'tool' | 'tool_call' | 'provider';
  content: string;
  textBlocks?: readonly ModelTextBlock[];
  contextKind?: 'environment' | 'private' | 'contextual' | 'summary' | 'compact_control';
  contextualBlock?: ModelContextualBlock;
  /** Input provenance and local truncation state; never serialized to a Provider. */
  metadata?: ModelInputMetadata;
  callId?: string;
  name?: string;
  arguments?: unknown;
  /** Definitions returned by a successful Tool Search output. */
  toolSearchTools?: readonly ClientToolDefinition[];
  inputMode?: 'json' | 'freeform';
  provider?: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES';
  providerModelId?: string;
  item?: Record<string, unknown>;
  images?: readonly ModelImage[];
  observations?: readonly import('../tools/code-mode/observations.js').CodeObservation[];
  /** Runtime-only location used by the GC evidence adapter, never a Provider call. */
  observationId?: string;
}
export interface ModelAttemptDiagnostic {
  protocol: MarAgentModelConfiguration['protocol'];
  transport: 'HTTP' | 'WEBSOCKET';
  state: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  attempt: number;
  maxAttempts: number;
  continuation: boolean;
  credentialReason: ModelCredentialAcquireReason;
  semanticEventObserved?: boolean;
  firstSemanticEventType?: ModelEvent['type'];
  connectionId?: string;
  connectionReused?: boolean;
  proxyType?: 'DIRECT' | 'SOCKS5';
  /** Item count of the lowered full logical request, not just a continuation suffix. */
  requestInputItems?: number;
  /** Actual serialized WebSocket request size, including inline image Base64. */
  requestBytes?: number;
  imageCount?: number;
  /** Decoded byte count of inline input images; external URLs do not add bytes. */
  imageBytes?: number;
  requestFrameCount?: number;
  sentFrameCount?: number;
  webSocketPhase?: 'CONNECT' | 'SEND' | 'RECEIVE';
  webSocketCloseCode?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  causeCode?: string;
  reason?: string;
  retryable?: boolean;
  willRetry?: boolean;
  retryDelayMs?: number;
  retryReason?: 'INVALID_CONTINUATION' | 'UNAUTHORIZED' | 'STREAM';
}
export interface ModelRetryState {
  attempts: number;
  readonly maxAttempts?: number;
  retryDelayMs?: number;
}

export interface ModelRequest {
  /** Metering identity and sink are local only, never serialized upstream. */
  usageRequestId?: string;
  onModelUsage?: (usage: import('./usage-observer.js').ModelRequestUsage) => Promise<void> | void;
  onModelUsageFailure?: () => void;
  /** Shared local attempt accounting across Adapter retries and Runtime continuation. Never sent upstream. */
  retryState?: ModelRetryState;
  system: string;
  systemBlocks?: readonly ModelTextBlock[];
  /** Retain the automatic cache boundary of an actual captured prefix, excluding a fork tail. */
  cachePrefixMessages?: number;
  messages: readonly ModelMessage[];
  tools: readonly ClientToolDefinition[];
  /** Optional per-request cap; adapters never exceed their configured output ceiling. */
  outputLimit?: number;
  allowTools?: boolean;
  /** Neutral capability intersection; excludes provider-executed tools when false. */
  allowHostedTools?: boolean;
  /** Preserve the visible tool catalog while controlling whether the model may call it. */
  toolChoice?: 'auto' | 'none';
  reasoningEffort?: MarAgentReasoningEffort;
  /** Stable request-level effort while native configuration updates select the current effort. */
  requestReasoningEffort?: MarAgentReasoningEffort;
  promptCacheKey?: string;
  images?: readonly ModelImage[];
  onAttemptDiagnostic?: (diagnostic: ModelAttemptDiagnostic) => Promise<void> | void;
}
export interface ModelUsage {
  /** Normalized total input including cache; distinct from protocol-native inputTokens. */
  totalInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  inputTokens?: number | undefined;
  contextInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  rolloutBudgetUnits?: number | undefined;
  hostedSearches?: number | undefined;
  hostedFetches?: number | undefined;
}
export type ModelStopReason = 'completed' | 'tool_use' | 'pause' | 'max_output' | 'cancelled';
export type ModelEvent =
  | { type: 'response.started'; responseId: string; modelId?: string }
  | { type: 'output.started' }
  | { type: 'output.delta' }
  | { type: 'output.paused' }
  | { type: 'output.completed' }
  | { type: 'output.reset' }
  | {
      type: 'response.item';
      provider: 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES';
      contextKind?: ModelMessage['contextKind'];
      item: Record<string, unknown>;
    }
  | { type: 'text.delta'; itemId: string; phase: 'commentary' | 'final_answer'; delta: string }
  | {
      type: 'text.completed';
      itemId: string;
      phase?: 'commentary' | 'final_answer';
      text: string;
    }
  | {
      type: 'reasoning.completed';
      itemId: string;
      representation: 'summary' | 'visible_thinking' | 'unspecified';
      text: string;
    }
  | {
      type: 'client_tool.call';
      callId: string;
      name: string;
      arguments: unknown;
      argumentError?: string;
      inputMode?: 'json' | 'freeform';
    }
  | {
      type: 'hosted_tool';
      itemId: string;
      kind: 'WEB_SEARCH' | 'WEB_FETCH';
      status: 'RUNNING' | 'COMPLETED' | 'FAILED';
      toolName?: string;
      input?: Record<string, unknown>;
      output?: unknown;
      truncated?: boolean;
      summary: {
        query?: string | undefined;
        url?: string | undefined;
        title?: string | undefined;
        sources?:
          | readonly { url: string; title?: string | undefined; snippet?: string | undefined }[]
          | undefined;
        sourcesTruncated?: boolean | undefined;
      };
    }
  | {
      type: 'citation';
      citation: {
        id: string;
        url: string;
        title?: string | undefined;
        start?: number | undefined;
        end?: number | undefined;
      };
    }
  | { type: 'usage'; usage: ModelUsage; final?: boolean }
  | { type: 'unknown'; nativeType: string }
  | { type: 'completed'; reason: ModelStopReason };

export interface ModelAdapter {
  readonly configuration: MarAgentModelConfiguration;
  start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  createTurnSession?(): ModelTurnSession;
  /**
   * Prepares an equivalent model rebind without mutating live state.
   * The returned commit callback must be synchronous and non-throwing.
   */
  prepareReconfigure?(configuration: MarAgentModelConfiguration): (() => void) | undefined;
  close?(): Promise<void>;
}

export interface ModelTurnSession {
  start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** Drops incremental response state after a local context replacement. */
  resetContinuation?(): void;
  close(): Promise<void>;
}
