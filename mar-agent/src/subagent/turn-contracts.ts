import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ExecutionResult } from '../runtime/contracts.js';
import type { AgentEvent } from '../runtime/events.js';
import type { SubagentTaskInput, SubagentTaskSnapshot } from './contracts.js';

export interface SubagentModelOption {
  readonly id: string;
  readonly name: string;
  readonly conversationModel?: boolean;
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
  readonly defaultReasoningEffort: AgentReasoningEffort;
}

export interface SubagentTurnHandle extends AsyncIterable<AgentEvent> {
  readonly executionId: string;
  readonly turnId: string;
  /** True only after the child terminal event was durably appended. */
  readonly persistedEvents?: boolean;
  result(): Promise<ExecutionResult>;
  cancel(): void;
  enqueueMessage(message: string, delivery?: SubagentMessageDelivery): boolean;
}

/** Caller-owned correlation is opaque to Subagent; the adapter restores it at delivery. */
export interface SubagentOrigin {
  readonly signal: AbortSignal;
  readonly correlation: unknown;
}

export interface SubagentMessageDelivery {
  readonly messageId: string;
  readonly origin?: SubagentOrigin;
  readonly signal?: AbortSignal;
  applied(): void;
  settled?(status: 'cancelled' | 'failed'): void;
}

export interface SubagentMailboxMessage {
  readonly text: string;
  readonly delivery?: SubagentMessageDelivery;
}

export interface SubagentParentExecution {
  readonly executionId: string;
  readonly modelId: string;
  readonly reasoningEffort: AgentReasoningEffort;
  readonly models: ReadonlyMap<string, SubagentModelOption>;
  emitTerminal(snapshot: SubagentTaskSnapshot): Promise<void>;
  startTurn(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly modelId: string;
    readonly reasoningEffort: AgentReasoningEffort;
    readonly role: SubagentTaskInput['role'];
    readonly initialMailbox: readonly SubagentMailboxMessage[];
    readonly turnId: string;
    readonly delivery?: SubagentMessageDelivery;
    readonly origin?: SubagentOrigin;
  }): Promise<SubagentTurnHandle>;
}

/** A native operation has its own provenance even when no parent Execution is active. */
export interface SubagentParentOperation extends Omit<SubagentParentExecution, 'executionId'> {
  readonly operationId: string;
  readonly executionId?: string;
  readonly ownerInstanceId?: string;
  readonly extensionId?: string;
  readonly signal: AbortSignal;
  readonly origin?: SubagentOrigin;
}

export type SubagentParentContext = SubagentParentExecution | SubagentParentOperation;
