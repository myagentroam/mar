import type { MarAgentRuntimeModelConfiguration } from '@myagentroam/protocol';
import type { LocalProcessExecutor, WorkspacePathMount } from '@myagentroam/agent/host';
import type { ResolvedMcpServer } from '../mcp/model.js';

export interface HostedConversationRuntimeEvent {
  readonly kind: 'RUN' | 'ITEM' | 'DELTA';
  readonly executionId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly payload: unknown;
}

export interface HostedConversationRuntimeRun {
  readonly id: string;
  readonly status: 'RUNNING';
  readonly startedAt: number;
  readonly completedAt: null;
}

export interface HostedConversationRuntimeHandle {
  readonly steer?: (input: {
    readonly prompt: string;
    readonly modelText: string;
    readonly clientMessageId: string;
    readonly modelId?: string;
    readonly runtimeScopeId?: string;
  }) => Promise<import('@myagentroam/agent').SteerResult>;
  readonly run: HostedConversationRuntimeRun;
  readonly completion: Promise<{
    readonly status: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
    readonly completedAt: number;
    readonly title?: string;
  }>;
  /** User interruption preserves the independent title task; shutdown releases it. */
  readonly cancel: (reason?: 'interrupt' | 'shutdown') => boolean;
}

export interface HostedConversationRuntimeSessionInput {
  readonly conversationId: string;
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
  readonly systemInstruction: string;
  readonly defaultModelId: string;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtimeScopeId?: string;
  readonly pathMounts: readonly WorkspacePathMount[];
  readonly processExecutor: LocalProcessExecutor;
}

export interface HostedConversationRuntimeHistoryInput {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly homeDirectory: string;
  readonly modelId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface HostedConversationRuntimeHistoryPage {
  readonly turns: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface HostedConversationRuntimeRollbackInput extends HostedConversationRuntimeHistoryInput {
  readonly boundaryTurnId: string | null;
  readonly beforeInput?: { readonly turnId: string; readonly clientMessageId: string };
}

export interface HostedConversationRuntimeRunInput {
  readonly onModelUsage?: import('@myagentroam/agent').ModelUsageObserver;
  readonly compact?: unknown;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
  readonly userPrompt: string;
  readonly prompt: string;
  readonly attachmentIds: readonly string[];
  readonly access: 'full-access';
  readonly modelId: string;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly runtimeScopeId?: string;
  readonly systemInstruction: string;
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
  readonly temporaryDirectory: string;
  readonly pathMounts: readonly WorkspacePathMount[];
  readonly processExecutor: LocalProcessExecutor;
  readonly mcpServers: readonly ResolvedMcpServer[];
  readonly webAccess: boolean;
  readonly onEvent?: (event: HostedConversationRuntimeEvent) => Promise<void> | void;
}

export interface HostedConversationRuntime {
  readToolResultResource?(
    input: {
      homeDirectory: string;
      sessionId: string;
    } & import('@myagentroam/protocol').ToolResultResourceInput
  ): Promise<import('@myagentroam/protocol').ToolResultResourcePage>;
  createSession(
    input: HostedConversationRuntimeSessionInput
  ): Promise<{ readonly sessionId: string }>;
  history(
    input: HostedConversationRuntimeHistoryInput
  ): Promise<HostedConversationRuntimeHistoryPage>;
  rollback(
    input: HostedConversationRuntimeRollbackInput
  ): Promise<{ readonly lastActivityAt: number }>;
  startRun(input: HostedConversationRuntimeRunInput): Promise<HostedConversationRuntimeHandle>;
  releaseSession(input: HostedConversationRuntimeHistoryInput): Promise<void>;
}
