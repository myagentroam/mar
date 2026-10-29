import type { RunnerName } from '@myagentroam/protocol';

const MAX_CONTENT_LENGTH = 20_000;
const RESOLVED_INSTRUCTIONS = Symbol('resolvedPersonalInstructions');

/** Carry Node-owned merged instructions across internal Session operations, never JSON input. */
export function resolvedPersonalInstructions(value: string): object {
  return { [RESOLVED_INSTRUCTIONS]: value };
}

export function normalizeSessionPrompt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length > MAX_CONTENT_LENGTH)
    throw new Error('SESSION_PROMPT_INVALID');
  return value.trim() || null;
}

export function withSessionPrompt(
  personalInstructions: string | undefined,
  sessionPrompt: string | null | undefined
): string | undefined {
  const merged = [personalInstructions, sessionPrompt].filter(Boolean).join('\n\n');
  return merged.length === 0 ? undefined : merged;
}

interface PersonalInstructionsPayload {
  readonly common: string;
  readonly codex: string;
  readonly claudeCode: string;
  readonly openCode: string;
  readonly marAgent: string;
}

export function personalInstructionsForRunner(
  value: unknown,
  runner: RunnerName
): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PERSONAL_INSTRUCTION_INVALID');
  if (RESOLVED_INSTRUCTIONS in value && typeof value[RESOLVED_INSTRUCTIONS] === 'string')
    return value[RESOLVED_INSTRUCTIONS] || undefined;
  const record = value as Record<string, unknown>;
  const instructions: PersonalInstructionsPayload = {
    common: content(record['common']),
    codex: content(record['codex']),
    claudeCode: content(record['claudeCode']),
    openCode: content(record['openCode']),
    marAgent: content(record['marAgent'])
  };
  const specialized =
    runner === 'codex'
      ? instructions.codex
      : runner === 'claude-code'
        ? instructions.claudeCode
        : runner === 'opencode'
          ? instructions.openCode
          : instructions.marAgent;
  const merged = [instructions.common, specialized].filter((item) => item.length > 0).join('\n\n');
  return merged.length === 0 ? undefined : merged;
}

function content(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('PERSONAL_INSTRUCTION_INVALID');
  const normalized = value.trim();
  if (normalized.length > MAX_CONTENT_LENGTH) throw new Error('PERSONAL_INSTRUCTION_INVALID');
  return normalized;
}
