import { forEachJsonlRecord, readJsonlWindow } from '../../native-jsonl-reader.js';
import { locateNativeSessionPath } from '../../native-session-history.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const CLAUDE_CONTEXT_USAGE_READ_BYTES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
export interface NativeClaudeContextUsage {
  readonly model: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
}

const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_CONTEXT_WINDOW_ENV = 'MAR_CLAUDE_CONTEXT_WINDOW_TOKENS';

export async function readClaudeNativeContextUsage(
  workspacePath: string,
  externalSessionId: string,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly settingsPath?: string;
  } = {}
): Promise<NativeClaudeContextUsage | undefined> {
  const path = await locateNativeSessionPath('claude-code', workspacePath, externalSessionId);
  if (path === undefined) return undefined;
  const latest = await readLatestClaudeContextUsage(path);
  if (latest === undefined) return undefined;
  return {
    ...latest,
    maxTokens: await claudeContextWindowTokens(options)
  };
}
async function readLatestClaudeContextUsage(
  path: string
): Promise<{ readonly model: string; readonly usedTokens: number } | undefined> {
  for (const tailBytes of CLAUDE_CONTEXT_USAGE_READ_BYTES) {
    const window = await readJsonlWindow(path, { tailBytes });
    if (window === undefined) return undefined;
    let latest: { readonly model: string; readonly usedTokens: number } | undefined;
    forEachJsonlRecord(window.content, (record) => {
      const usage = claudeContextUsage(record);
      if (usage !== undefined) latest = usage;
    });
    if (latest !== undefined) return latest;
    if (!window.truncated) return undefined;
  }
  return undefined;
}

export async function claudeContextWindowTokens(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly settingsPath?: string;
  } = {}
): Promise<number> {
  const environment = options.environment ?? process.env;
  const direct = positiveInteger(environment[CLAUDE_CONTEXT_WINDOW_ENV]);
  if (direct !== undefined) return direct;
  try {
    const settings: unknown = JSON.parse(
      await readFile(options.settingsPath ?? join(homedir(), '.claude', 'settings.json'), 'utf8')
    );
    if (isRecord(settings) && isRecord(settings.env)) {
      const configured = positiveInteger(settings.env[CLAUDE_CONTEXT_WINDOW_ENV]);
      if (configured !== undefined) return configured;
    }
  } catch {
    // Missing or malformed optional Claude settings use the stable default.
  }
  return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS;
}

function claudeContextUsage(
  value: Record<string, unknown>
): { readonly model: string; readonly usedTokens: number } | undefined {
  if (value.type !== 'assistant' || !isRecord(value.message)) return undefined;
  const model = value.message.model;
  const usage = value.message.usage;
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    model === '<synthetic>' ||
    !isRecord(usage)
  )
    return undefined;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const cacheCreationTokens = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheReadTokens = optionalNonNegativeInteger(usage.cache_read_input_tokens);
  if (
    inputTokens === undefined ||
    cacheCreationTokens === undefined ||
    cacheReadTokens === undefined
  )
    return undefined;
  return { model, usedTokens: inputTokens + cacheCreationTokens + cacheReadTokens };
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? 0 : nonNegativeInteger(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
