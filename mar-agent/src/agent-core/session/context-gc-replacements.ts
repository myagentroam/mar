import { contextGcMarkup } from './context-gc-markup.js';
import {
  parseApplyPatchResult,
  parseApplyPatchPartialResult
} from '../tools/shared/patch-result.js';

const RAW_MODEL_CONTEXT_PREVIEW_CHARACTERS = 256;
const EXEC_INPUT_COMPLETE_CHARACTERS = 512;
const EXEC_INPUT_PREVIEW_CHARACTERS = 256;
const EXEC_OUTPUT_PREVIEW_CHARACTERS = 512;
const CODE_MODE_OUTPUT_PREVIEW_CHARACTERS = 512;

export type ContextGcWebToolName = 'web_search' | 'web_fetch';

export interface ContextGcCodeModeInput {
  readonly code: string;
  readonly inputMode: 'freeform' | 'json';
}

export function normalizeContextGcCodeModeInput(
  arguments_: unknown
): ContextGcCodeModeInput | undefined {
  if (typeof arguments_ === 'string' && arguments_.length > 0)
    return { code: arguments_, inputMode: 'freeform' };
  if (
    isRecord(arguments_) &&
    Object.keys(arguments_).length === 1 &&
    typeof arguments_.code === 'string' &&
    arguments_.code.length > 0
  )
    return { code: arguments_.code, inputMode: 'json' };
  return undefined;
}

export function contextGcCodeModeInputReplacement(
  input: ContextGcCodeModeInput,
  retainedInputs: readonly unknown[] = []
): unknown {
  const content = contextGcMarkup('completed_code_mode_input', {
    originalBytes: Buffer.byteLength(input.code),
    lines: lineCount(input.code),
    inputMode: input.inputMode,
    contextGc:
      'Completed Code Mode source was reclaimed after six successful rollouts. The paired output, images, completion evidence, and nested tool side effects remain in history.',
    retainedInputs
  });
  return input.inputMode === 'freeform' ? content : { code: content };
}

export function contextGcCodeModeOutputReplacement(
  originalContent: string,
  truncated: boolean
): string {
  const preview = unicodeHeadTail(originalContent, CODE_MODE_OUTPUT_PREVIEW_CHARACTERS);
  return JSON.stringify({
    originalBytes: Buffer.byteLength(originalContent),
    lines: lineCount(originalContent),
    truncated,
    preview,
    previewComplete: !truncated && preview === originalContent,
    contextGc:
      'Detailed Code Mode output was reclaimed after six successful rollouts. An incomplete preview is not the complete cell output. The source was not replayed and nested tool side effects were not changed.'
  });
}

export interface ContextGcPatchFile {
  readonly path: string;
  readonly targetPath?: string;
  readonly operation: 'added' | 'modified' | 'deleted' | 'moved';
  readonly addedLines: number;
  readonly deletedLines: number;
}

export interface ContextGcPatchResult {
  readonly files: readonly ContextGcPatchFile[];
  readonly totals: {
    readonly files: number;
    readonly addedLines: number;
    readonly deletedLines: number;
  };
}

export type ContextGcExecResult =
  | {
      readonly source: 'STRUCTURED';
      readonly status: 'running' | 'completed' | 'cancelled';
      readonly processId?: string;
      readonly exitCode?: number | null;
      readonly truncated: boolean;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutDroppedBytes: number;
      readonly stderrDroppedBytes: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly source: 'MODEL_CONTEXT_TRUNCATED';
      readonly status: 'completed' | 'cancelled';
      readonly processId?: string;
      readonly exitCode?: number | null;
      readonly truncated: boolean;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutDroppedBytes: number;
      readonly stderrDroppedBytes: number;
      readonly modelContextContent: string;
    };

export function contextGcPatchResultFromCompletedPayload(
  payload: unknown
): ContextGcPatchResult | undefined {
  if (!isRecord(payload) || payload.type !== 'tool.completed') return undefined;
  const result = parseApplyPatchResult(payload.data);
  return result?.files.length ? result : undefined;
}

export function contextGcPatchResultFromFailedPayload(
  payload: unknown
): ContextGcPatchResult | undefined {
  if (
    !isRecord(payload) ||
    payload.type !== 'tool.failed' ||
    payload.toolName !== 'apply_patch' ||
    payload.code !== 'MAR_AGENT_PATCH_PARTIAL'
  )
    return undefined;
  return parseApplyPatchPartialResult(payload.data);
}

export function contextGcApplyPatchInputReplacement(
  arguments_: unknown,
  result: ContextGcPatchResult
): string {
  const original = typeof arguments_ === 'string' ? arguments_ : stableJson(arguments_);
  const summary = result.files
    .map(
      (file) =>
        `${file.operation} ${file.path}${file.targetPath ? ` -> ${file.targetPath}` : ''} (+${
          file.addedLines
        }/-${file.deletedLines})`
    )
    .join('; ');
  return contextGcMarkup('successful_apply_patch_input', {
    formatVersion: 2,
    originalBytes: Buffer.byteLength(original),
    contextGc: `Applied successfully: ${summary}. Totals: ${result.totals.files} files, +${result.totals.addedLines}/-${result.totals.deletedLines}. The original patch body was reclaimed.`
  });
}

export function contextGcStaleReadReplacement(input: {
  readonly path: string;
  readonly content: string;
  readonly operation: Exclude<ContextGcPatchFile['operation'], 'added'>;
}): string {
  return contextGcMarkup('stale_read', {
    path: input.path,
    formatVersion: 2,
    originalBytes: Buffer.byteLength(input.content),
    operation: input.operation,
    contextGc:
      'This read predates a successful apply_patch. Re-read the path before relying on its contents.'
  });
}

export function contextGcWebOutputReplacement(
  toolName: ContextGcWebToolName,
  originalContent: string,
  truncated: boolean
): string {
  const preview = unicodeHeadTail(originalContent, EXEC_OUTPUT_PREVIEW_CHARACTERS);
  return JSON.stringify({
    toolName,
    originalBytes: Buffer.byteLength(originalContent),
    lines: lineCount(originalContent),
    truncated,
    preview,
    previewComplete: preview === originalContent,
    contextGc:
      'Detailed web tool output was reclaimed after six successful rollouts. An incomplete preview is not the complete search result or page, and GC did not access the network.'
  });
}

export function contextGcExecInputReplacement(
  arguments_: unknown,
  toolName: string = 'exec'
): unknown {
  if (!isRecord(arguments_))
    return contextGcMarkup('terminal_exec_input', {
      formatVersion: 3,
      originalBytes: Buffer.byteLength(stableJson(arguments_))
    });
  const action =
    typeof arguments_.action === 'string'
      ? arguments_.action
      : typeof arguments_.command === 'string'
        ? 'start'
        : toolName === 'exec_wait'
          ? 'poll'
          : 'unknown';
  const original = stableJson(arguments_);
  const retained: Record<string, unknown> = {
    action,
    contextGc: {
      kind: 'terminal_exec_input',
      formatVersion: 3,
      originalBytes: Buffer.byteLength(original)
    }
  };
  for (const key of ['cwd', 'processId', 'timeoutMs', 'yieldMs'] as const)
    if (arguments_[key] !== undefined) retained[key] = arguments_[key];
  if (typeof arguments_.command === 'string')
    retainExecText(retained, 'command', arguments_.command);
  if (typeof arguments_.data === 'string') retainExecText(retained, 'data', arguments_.data);
  return retained;
}

export function contextGcExecOutputReplacement(result: ContextGcExecResult): string {
  if (result.source === 'MODEL_CONTEXT_TRUNCATED')
    return JSON.stringify({
      status: result.status,
      ...(result.processId === undefined ? {} : { processId: result.processId }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      truncated: result.truncated,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutDroppedBytes: result.stdoutDroppedBytes,
      stderrDroppedBytes: result.stderrDroppedBytes,
      modelContextTruncated: true,
      modelContextBytes: Buffer.byteLength(result.modelContextContent),
      modelContextPreview: unicodeHeadTail(
        result.modelContextContent,
        RAW_MODEL_CONTEXT_PREVIEW_CHARACTERS
      ),
      contextGcFormatVersion: 3,
      contextGc:
        'The model-visible terminal result was truncated after execution and is no longer valid JSON. Detailed terminal input/output was reclaimed after the process reached a stable terminal state. Re-run the command if full output is required.'
    });
  const stdout = result.stdout;
  const stderr = result.stderr;
  const stdoutPreview = unicodeHeadTail(stdout, EXEC_OUTPUT_PREVIEW_CHARACTERS);
  const stderrPreview = unicodeHeadTail(stderr, EXEC_OUTPUT_PREVIEW_CHARACTERS);
  return JSON.stringify({
    status: result.status,
    ...(result.processId === undefined ? {} : { processId: result.processId }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    truncated: result.truncated === true,
    stdoutBytes: nonnegativeNumber(result.stdoutBytes) ?? Buffer.byteLength(stdout),
    stderrBytes: nonnegativeNumber(result.stderrBytes) ?? Buffer.byteLength(stderr),
    stdoutDroppedBytes: nonnegativeNumber(result.stdoutDroppedBytes) ?? 0,
    stderrDroppedBytes: nonnegativeNumber(result.stderrDroppedBytes) ?? 0,
    stdoutPreview,
    stderrPreview,
    stdoutLines: lineCount(stdout),
    stderrLines: lineCount(stderr),
    stdoutPreviewComplete:
      result.truncated === false &&
      result.stdoutDroppedBytes === 0 &&
      result.stdoutBytes === Buffer.byteLength(stdout) &&
      stdoutPreview === stdout,
    stderrPreviewComplete:
      result.truncated === false &&
      result.stderrDroppedBytes === 0 &&
      result.stderrBytes === Buffer.byteLength(stderr) &&
      stderrPreview === stderr,
    contextGcFormatVersion: 3,
    contextGc:
      'Detailed terminal input/output was reclaimed after the process reached a stable terminal state. An incomplete preview is not the complete result. Re-run the command if full output is required.'
  });
}

export function normalizeContextGcExecResult(
  modelContent: unknown,
  completedPayload: unknown
): ContextGcExecResult | undefined {
  const parsed = parseContextGcExecResult(modelContent);
  if (parsed) return parsed;
  if (
    typeof modelContent !== 'string' ||
    !isRecord(completedPayload) ||
    completedPayload.type !== 'tool.completed' ||
    (completedPayload.toolName !== 'exec' && completedPayload.toolName !== 'exec_wait') ||
    completedPayload.truncated !== true
  )
    return undefined;
  const data = completedPayload.data;
  if (!isRecord(data) || (data.status !== 'completed' && data.status !== 'cancelled'))
    return undefined;
  const metadata = parseContextGcExecMetadata(data);
  return metadata
    ? {
        source: 'MODEL_CONTEXT_TRUNCATED',
        ...metadata,
        status: data.status,
        modelContextContent: modelContent
      }
    : undefined;
}

export function parseContextGcExecResult(value: unknown): ContextGcExecResult | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      (parsed.status !== 'running' &&
        parsed.status !== 'completed' &&
        parsed.status !== 'cancelled') ||
      typeof parsed.stdout !== 'string' ||
      (parsed.stderr !== undefined && typeof parsed.stderr !== 'string') ||
      (parsed.truncated === true &&
        (parsed.stdoutBytes === undefined || parsed.stderrBytes === undefined))
    )
      return undefined;
    const stderr = parsed.stderr === undefined ? '' : parsed.stderr;
    // Native exec bodies omit only empty/default fields and exactly derivable byte counts.
    const defaults = {
      truncated: false,
      stdoutBytes: Buffer.byteLength(parsed.stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    };
    const metadata = parseContextGcExecMetadata({ ...defaults, ...parsed });
    return metadata
      ? {
          source: 'STRUCTURED',
          ...metadata,
          status: parsed.status,
          stdout: parsed.stdout,
          stderr
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseContextGcExecMetadata(value: Record<string, unknown>):
  | {
      readonly processId?: string;
      readonly exitCode?: number | null;
      readonly truncated: boolean;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutDroppedBytes: number;
      readonly stderrDroppedBytes: number;
    }
  | undefined {
  if (
    typeof value.truncated !== 'boolean' ||
    (value.processId !== undefined &&
      (typeof value.processId !== 'string' || value.processId.length === 0)) ||
    (value.exitCode !== undefined &&
      value.exitCode !== null &&
      (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))) ||
    !isNonnegativeInteger(value.stdoutBytes) ||
    !isNonnegativeInteger(value.stderrBytes) ||
    !isNonnegativeInteger(value.stdoutDroppedBytes) ||
    !isNonnegativeInteger(value.stderrDroppedBytes) ||
    value.stdoutDroppedBytes > value.stdoutBytes ||
    value.stderrDroppedBytes > value.stderrBytes
  )
    return undefined;
  return {
    ...(typeof value.processId === 'string' ? { processId: value.processId } : {}),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number | null }),
    truncated: value.truncated,
    stdoutBytes: value.stdoutBytes,
    stderrBytes: value.stderrBytes,
    stdoutDroppedBytes: value.stdoutDroppedBytes,
    stderrDroppedBytes: value.stderrDroppedBytes
  };
}

function unicodeHeadTail(value: string, count: number): string {
  const characters = [...value];
  if (characters.length <= count * 2) return value;
  return `${characters.slice(0, count).join('')}\n...[context GC omitted middle]...\n${characters
    .slice(-count)
    .join('')}`;
}

function retainExecText(
  retained: Record<string, unknown>,
  key: 'command' | 'data',
  value: string
): void {
  if ([...value].length <= EXEC_INPUT_COMPLETE_CHARACTERS) {
    retained[key] = value;
    return;
  }
  retained[`${key}Preview`] = unicodeHeadTail(value, EXEC_INPUT_PREVIEW_CHARACTERS);
  retained[`${key}Bytes`] = Buffer.byteLength(value);
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** A returned tool wait is not proof that its retained JavaScript cell finished. */
export function codeCellCompletionSequence(
  records: readonly import('./store/index.js').SessionRecord[],
  completed: import('./store/index.js').SessionRecord
): number | undefined {
  if (!isRecord(completed.payload)) return undefined;
  const data = completed.payload.data;
  if (!isRecord(data) || typeof data.cellId !== 'string') return undefined;
  if (data.status === 'completed') return completed.sequence;
  if (data.status !== 'running') return undefined;
  return records.findLast(
    (record) =>
      record.type === 'code.cell.completed' &&
      isRecord(record.payload) &&
      record.payload.cellId === data.cellId &&
      record.payload.status === 'completed'
  )?.sequence;
}
