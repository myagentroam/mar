import type { MarAgentReasoningEffort } from '../model/configuration.js';

export interface SubagentTaskInput {
  description: string;
  prompt: string;
  role: 'general-purpose' | 'explore';
  modelId?: string;
  reasoningEffort?: MarAgentReasoningEffort;
  background?: boolean;
  parentSubagentId?: string;
}
export interface SubagentTaskResult {
  summary: string;
  changedFiles: string[];
  verification: string[];
  evidence: Array<{ path: string; startLine?: number; endLine?: number }>;
}
export interface SubagentLatestMessage {
  itemId: string;
  turnId: string;
  phase: 'commentary' | 'final_answer';
  text: string;
  timestamp: string;
  truncated: boolean;
}
export type SubagentLatestActivity =
  | {
      kind: 'message';
      timestamp: string;
      phase: 'commentary' | 'final_answer';
    }
  | {
      kind: 'tool';
      timestamp: string;
      toolName: string;
      status: 'started' | 'completed' | 'failed';
    };
export interface SubagentTaskSnapshot extends Record<string, unknown> {
  permissionStop?: import('../tools/permissions.js').PermissionStop;
  agentId: string;
  description: string;
  role?: SubagentTaskInput['role'];
  extensionId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  modelId?: string;
  modelName?: string;
  reasoningEffort?: MarAgentReasoningEffort;
  latestMessage?: SubagentLatestMessage;
  latestActivity?: SubagentLatestActivity;
  summary?: string;
  changedFiles?: string[];
  verification?: string[];
  evidence?: Array<{ path: string; startLine?: number; endLine?: number }>;
  errorCode?: string;
  errorMessage?: string;
  messageId?: string;
  turnId?: string;
  deliveryStatus?: 'accepted' | 'applied' | 'cancelled' | 'failed';
  waitOutcome?: SubagentWaitOutcome;
  reason?: 'steer';
}
export type SubagentWaitFor = 'completion' | 'message';
export type SubagentWaitOutcome = Exclude<import('../tools/wait.js').ToolWaitOutcome, 'yield'>;
export interface SubagentMessageOptions {
  delivery?: 'append' | 'replace';
  signal?: AbortSignal;
}
export interface SubagentRunOptions {
  turnSignal?: AbortSignal;
  waitFor?: 'start' | 'completion';
  signal?: AbortSignal;
  onCreated?: (task: SubagentTaskSnapshot) => Promise<void> | void;
}
export interface SubagentOutputOptions {
  waitInterrupt?: import('../tools/wait.js').ToolWaitInterrupt | undefined;
  untilSettled?: true;
  waitMs?: number;
  waitFor?: SubagentWaitFor;
  signal?: AbortSignal;
}
export type SubagentWaitMode = 'any' | 'all';
export interface SubagentManyOutputOptions extends Omit<SubagentOutputOptions, 'untilSettled'> {
  mode?: SubagentWaitMode;
}
export interface SubagentManyOutput {
  mode: SubagentWaitMode;
  waitFor: SubagentWaitFor;
  waitOutcome: SubagentWaitOutcome;
  reason?: 'steer';
  agents: SubagentTaskSnapshot[];
  pendingAgentIds: string[];
}

export interface SubagentHandledResult {
  readonly outcome: 'handled';
  readonly value?: unknown;
}
export type SubagentRunResult = SubagentTaskSnapshot | SubagentHandledResult;
export interface SubagentController {
  beginExecution?(
    runner: (task: SubagentTaskInput, signal: AbortSignal) => Promise<SubagentTaskResult>
  ): void;
  run(input: SubagentTaskInput, options?: SubagentRunOptions): Promise<SubagentRunResult>;
  output(agentId: string, options?: SubagentOutputOptions): Promise<SubagentTaskSnapshot>;
  outputAny(options?: SubagentOutputOptions): Promise<SubagentTaskSnapshot>;
  outputMany(
    agentIds: readonly string[],
    options?: SubagentManyOutputOptions
  ): Promise<SubagentManyOutput>;
  message(
    agentId: string,
    message: string,
    options?: SubagentMessageOptions
  ): Promise<SubagentTaskSnapshot>;
  cancel(agentId: string): Promise<SubagentTaskSnapshot>;
  listSessionResources(): readonly {
    agentId: string;
    status: SubagentTaskSnapshot['status'];
    description: string;
  }[];
  dispose(): Promise<void>;
}
