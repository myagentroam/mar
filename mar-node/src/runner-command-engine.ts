import type { RunnerCommandDescriptor, RunnerCommandState } from '@myagentroam/protocol';

const CLAUDE_PLAN_TAG_OPEN = '<plan_mode>';
const CLAUDE_PLAN_TAG_CLOSE = '</plan_mode>';

/**
 * Claude Agent SDK has no mid-session collaboration mode switch. Plan Mode is
 * therefore declared as a fixed Node-owned instruction tag prepended to each
 * Runner-bound input while the command state is active. The tag never appears
 * in the user bubble; native history strips it again on read.
 */
export function withClaudePlanTag(input: string): string {
  return `${CLAUDE_PLAN_TAG_OPEN}
You are in Plan Mode. Perform only read-only analysis and planning. Do not create, modify, or delete files, and do not run commands with side effects. Wrap the complete final plan in <proposed_plan> and </proposed_plan> tags without repeating the plan outside those tags.
${CLAUDE_PLAN_TAG_CLOSE}

${input}`;
}

/** Removes one leading plan instruction tag from a native transcript user text. */
export function stripClaudePlanTag(text: string): string {
  if (!text.startsWith(CLAUDE_PLAN_TAG_OPEN)) return text;
  const close = text.indexOf(CLAUDE_PLAN_TAG_CLOSE);
  if (close === -1) return text;
  return text.slice(close + CLAUDE_PLAN_TAG_CLOSE.length).trimStart();
}

/** A deliberately small, Node-only command interaction boundary. */
export interface CommandDefinition {
  readonly descriptor: RunnerCommandDescriptor;
}

export interface CommandInvocation {
  readonly input: string;
  readonly argument: string;
}

export function parseCommandInvocation(
  definition: CommandDefinition,
  input: string
): CommandInvocation {
  const normalized = input.trim();
  const prefix = `/${definition.descriptor.id}`;
  if (
    !normalized.startsWith(prefix) ||
    (normalized.length > prefix.length && !/\s/.test(normalized[prefix.length]!))
  )
    throw new Error('RUNNER_COMMAND_INVALID');
  const argument = normalized.slice(prefix.length).trim();
  if (
    (definition.descriptor.interaction === 'IMMEDIATE_ACTION' ||
      definition.descriptor.interaction === 'DESTRUCTIVE_ACTION' ||
      definition.descriptor.id === 'plan') &&
    argument.length > 0
  )
    throw new Error('RUNNER_COMMAND_ARGUMENT_INVALID');
  return { input: normalized, argument };
}

export class CommandStateStore {
  private readonly states = new Map<string, Map<string, RunnerCommandState>>();

  list(sessionId: string): readonly RunnerCommandState[] {
    return [...(this.states.get(sessionId)?.values() ?? [])].filter(
      (state) => state.active || state.commandId === 'goal'
    );
  }

  set(sessionId: string, state: RunnerCommandState): readonly RunnerCommandState[] {
    const values = this.states.get(sessionId) ?? new Map<string, RunnerCommandState>();
    values.set(state.commandId, state);
    this.states.set(sessionId, values);
    return this.list(sessionId);
  }

  clear(sessionId: string, commandId: string): readonly RunnerCommandState[] {
    this.states.get(sessionId)?.delete(commandId);
    return this.list(sessionId);
  }

  removeSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  validateSessionIdentityPromotion(sessionId: string, nativeSessionId: string): void {
    if (sessionId === nativeSessionId) return;
    if (this.states.has(sessionId) && this.states.has(nativeSessionId))
      throw new Error('SESSION_ID_CONFLICT');
  }

  promoteSessionIdentity(sessionId: string, nativeSessionId: string): void {
    this.validateSessionIdentityPromotion(sessionId, nativeSessionId);
    if (sessionId === nativeSessionId) return;
    const values = this.states.get(sessionId);
    if (values === undefined) return;
    this.states.delete(sessionId);
    this.states.set(nativeSessionId, values);
  }

  get(sessionId: string, commandId: string): RunnerCommandState | undefined {
    return this.states.get(sessionId)?.get(commandId);
  }
}
