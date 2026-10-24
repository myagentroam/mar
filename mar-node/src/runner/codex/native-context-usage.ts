import { forEachJsonlRecord, readJsonlWindow } from '../../native-jsonl-reader.js';
import { locateNativeSessionPath } from '../../native-session-history.js';
const CONTEXT_USAGE_READ_BYTES = 256 * 1024;
export interface NativeCodexContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export async function readCodexNativeContextUsage(
  workspacePath: string,
  externalSessionId: string
): Promise<NativeCodexContextUsage | undefined> {
  const path = await locateNativeSessionPath('codex', workspacePath, externalSessionId);
  if (path === undefined) return undefined;
  const window = await readJsonlWindow(path, { tailBytes: CONTEXT_USAGE_READ_BYTES });
  if (window === undefined) return undefined;
  let usage: NativeCodexContextUsage | undefined;
  forEachJsonlRecord(window.content, (record) => {
    const next = codexContextUsage(record);
    if (next !== undefined) usage = next;
  });
  return usage;
}
function codexContextUsage(value: unknown): NativeCodexContextUsage | undefined {
  if (!isRecord(value) || value.type !== 'event_msg' || !isRecord(value.payload)) return undefined;
  const payload = value.payload;
  if (payload.type !== 'token_count' || !isRecord(payload.info)) return undefined;
  const promptUsage = payload.info.last_token_usage;
  const maxTokens = payload.info.model_context_window;
  if (
    !isRecord(promptUsage) ||
    typeof promptUsage.input_tokens !== 'number' ||
    typeof maxTokens !== 'number'
  )
    return undefined;
  if (
    !Number.isFinite(promptUsage.input_tokens) ||
    !Number.isInteger(promptUsage.input_tokens) ||
    !Number.isFinite(maxTokens) ||
    !Number.isInteger(maxTokens) ||
    maxTokens <= 0 ||
    promptUsage.input_tokens < 0
  )
    return undefined;
  return { usedTokens: promptUsage.input_tokens, maxTokens };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
