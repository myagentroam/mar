import { AgentError } from '../error.js';
import { parseApplyPatchResult, parseApplyPatchPartialResult } from './shared/patch-result.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import { countModelTokens, countTextLines, truncateModelText } from '../runtime/token-budget.js';
import type {
  ApplyPatchResult,
  ApplyPatchPartialResult,
  CodeCellEventData,
  ExecResult,
  AgentToolArtifact,
  ToolExecutionResult,
  ReadEventData,
  ViewImageRegion,
  ViewImageResult
} from './contracts.js';
import { TOOL_EXECUTION_LIMITS } from './execution-limits.js';
import type { ToolRuntimeImage } from './runtime-context.js';
import type { SleepResult } from './agent/sleep.js';
import { publicToolMetadata, type PublicToolMetadata } from '../runtime/public-tool-metadata.js';
import type { ModelImage } from '../model/image.js';
/** Copy an explicitly public JSON object without exposing the full tool result. */
export function publicExtensionToolEventData(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') > 8192) return undefined;
    const copy: unknown = JSON.parse(json);
    return isRecord(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

export function currentExecutionImages(
  modelInputImages: readonly ModelImage[] | undefined,
  toolImages: readonly ToolRuntimeImage[]
): ToolRuntimeImage[] {
  return [
    ...(modelInputImages ?? [])
      .filter((image) => image.dataBase64 !== undefined)
      .map((image) => ({
        mimeType: image.mimeType,
        data: Buffer.from(image.dataBase64!, 'base64')
      })),
    ...toolImages
  ]
    .slice(-5)
    .map((image) => ({ mimeType: image.mimeType, data: Buffer.from(image.data) }));
}

export function boundedModelToolOutput(
  toolName: string,
  value: string,
  data: unknown
): { content: string; truncated: boolean } {
  if (
    (toolName === 'code_exec' || toolName === 'code_exec_wait') &&
    isRecord(data) &&
    Array.isArray(data.observations)
  )
    return { content: value, truncated: data.truncated === true };
  const execDiagnostics =
    (toolName === 'exec' || toolName === 'exec_wait') &&
    isRecord(data) &&
    typeof data.stdout === 'string' &&
    typeof data.stderr === 'string'
      ? {
          originalTokenCount: countModelTokens(data.stdout) + countModelTokens(data.stderr),
          totalLines: countTextLines(data.stdout) + countTextLines(data.stderr)
        }
      : undefined;
  const result = truncateModelText(
    value,
    AGENT_EXECUTION_POLICY.modelToolOutputTokens,
    'tool output',
    execDiagnostics
  );
  return { content: result.content, truncated: result.truncated };
}

/** The opted-in allowlist fails closed and never mutates the invocation arguments. */
export function publicToolEventInput(
  value: unknown,
  fields: readonly string[]
): Readonly<Record<string, unknown>> {
  try {
    if (!isRecord(value)) return {};
    const projected = Object.fromEntries(
      fields
        .filter(
          (key) =>
            Object.hasOwn(value, key) &&
            (typeof value[key] === 'string' ||
              typeof value[key] === 'boolean' ||
              (Array.isArray(value[key]) &&
                value[key].length <= 100 &&
                value[key].every((item: unknown) => typeof item === 'string')) ||
              (typeof value[key] === 'number' && Number.isFinite(value[key])) ||
              value[key] === null)
        )
        .map((key) => [key, value[key]])
    );
    return publicExtensionToolEventData(projected) ?? {};
  } catch {
    return {};
  }
}

/** Explicit observations are public, but their event projection must remain bounded. */
export function publicCodeObservations(
  values: unknown,
  data: CodeCellEventData
): CodeCellEventData {
  if (!Array.isArray(values)) return data;
  const retained = new Set<unknown>(data.observations ?? []);
  const selected: NonNullable<CodeCellEventData['observations']>[number][] = [];
  let displayedCount = 0;
  let remaining = 10_000;
  let truncated = false;
  let headTruncated = data.outputHeadTruncated === true;
  let sourceTruncated = data.outputSourceTruncated === true;
  const clip = (text: string) => {
    let start = Math.max(0, text.length - remaining);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start++;
    const result = text.slice(start);
    remaining -= result.length;
    truncated ||= start > 0;
    headTruncated ||= start > 0;
    return result;
  };
  for (let index = values.length - 1; index >= 0; index--) {
    const entry = values[index];
    if (!isRecord(entry)) continue;
    if (
      entry.type === 'value' &&
      typeof entry.value === 'string' &&
      typeof entry.id === 'string' &&
      (entry.format === 'text' || entry.format === 'json' || entry.format === 'image')
    ) {
      if (displayedCount >= 32) {
        truncated = true;
        headTruncated = true;
        continue;
      }
      displayedCount++;
      if (!data.outputSourceKnown && entry.truncated === true) sourceTruncated = true;
      truncated ||= entry.truncated === true;
      const value = clip(entry.value);
      selected.unshift({
        type: 'value',
        id: entry.id,
        format: entry.format,
        value,
        ...(entry.truncated === true || value.length < entry.value.length
          ? { truncated: true }
          : {})
      });
    } else if (entry.type === 'tool_result' && isRecord(entry.source) && isRecord(entry.result)) {
      const name = entry.source.toolName;
      if (name !== 'exec' && name !== 'exec_wait') {
        if (retained.has(entry)) {
          if (!data.outputSourceKnown && entry.result.truncated === true) sourceTruncated = true;
          selected.unshift(
            entry as unknown as NonNullable<CodeCellEventData['observations']>[number]
          );
        }
      } else if (
        (name === 'exec' || name === 'exec_wait') &&
        typeof entry.id === 'string' &&
        typeof entry.source.callId === 'string' &&
        (entry.outcome === 'completed' || entry.outcome === 'failed')
      ) {
        if (displayedCount >= 32) {
          truncated = true;
          headTruncated = true;
          continue;
        }
        displayedCount++;
        if (!data.outputSourceKnown && entry.result.truncated === true) sourceTruncated = true;
        truncated ||= entry.result.truncated === true;
        const resultData = isRecord(entry.result.data) ? entry.result.data : undefined;
        const stderr = typeof resultData?.stderr === 'string' ? clip(resultData.stderr) : undefined;
        const stdout = typeof resultData?.stdout === 'string' ? clip(resultData.stdout) : undefined;
        const content =
          stdout === undefined && stderr === undefined && typeof entry.result.content === 'string'
            ? clip(entry.result.content)
            : '';
        selected.unshift({
          type: 'tool_result',
          id: entry.id,
          source: { callId: entry.source.callId, toolName: name, input: null },
          outcome: entry.outcome,
          result: {
            content,
            ...(stdout === undefined && stderr === undefined ? {} : { data: { stdout, stderr } }),
            ...(entry.result.truncated === true || truncated ? { truncated: true } : {})
          }
        });
      }
    }
  }
  return {
    ...data,
    observations: selected,
    outputSourceKnown: true,
    ...(sourceTruncated ? { outputSourceTruncated: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(headTruncated ? { outputHeadTruncated: true } : {})
  };
}

/** Classify only facts about the public body, never model or summary limits. */
export function publicOutputTruncation(
  toolName: string,
  data: unknown
): 'HEAD' | 'SOURCE' | undefined {
  if (!isRecord(data)) return undefined;
  if (toolName === 'read' && data.mode === 'batch' && data.truncated === true) return 'SOURCE';
  if (toolName === 'code_exec' || toolName === 'code_exec_wait') {
    if (data.outputSourceTruncated === true) return 'SOURCE';
    if (data.outputHeadTruncated === true) return 'HEAD';
  }
  if (toolName === 'exec' || toolName === 'exec_wait') {
    const display = isRecord(data.displayOutput) ? data.displayOutput : undefined;
    if (display)
      return Number(display.stdoutDroppedBytes) > 0 || Number(display.stderrDroppedBytes) > 0
        ? 'HEAD'
        : undefined;
    if (data.truncated === true) return 'SOURCE';
  }
  return undefined;
}

/** Remove the internal display direction from published structured data. */
export function publicEventOutputData<T>(data: T): T {
  if (!isRecord(data)) return data;
  const {
    outputHeadTruncated: _head,
    outputSourceKnown: _known,
    outputSourceTruncated: _source,
    ...rest
  } = data;
  return rest as T;
}

export function liveOutputTruncation(
  output: import('./contracts.js').ExecOutputSnapshot
): 'HEAD' | 'SOURCE' | undefined {
  if (!output.truncated) return undefined;
  return output.displayOutput &&
    (output.displayOutput.stdoutDroppedBytes > 0 || output.displayOutput.stderrDroppedBytes > 0)
    ? 'HEAD'
    : 'SOURCE';
}

/** Project only known, validated tool result shapes into public structured events. */
export function structuredToolEventData(
  toolName: string,
  value: unknown
):
  | CodeCellEventData
  | ExecResult
  | ApplyPatchResult
  | ReadEventData
  | ViewImageResult
  | SleepResult
  | PublicToolMetadata
  | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = publicToolMetadata(toolName, value);
  if (metadata !== undefined) return metadata;
  if (
    toolName === 'sleep' &&
    typeof value.durationMs === 'number' &&
    Number.isInteger(value.durationMs) &&
    value.durationMs >= 1 &&
    value.durationMs <= TOOL_EXECUTION_LIMITS.sleepMaxDurationMs &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    (value.wakeReason === 'elapsed' ||
      value.wakeReason === 'steer' ||
      value.wakeReason === 'subagent_message')
  )
    return {
      durationMs: value.durationMs,
      elapsedMs: value.elapsedMs,
      wakeReason: value.wakeReason
    };
  if (
    (toolName === 'code_exec' || toolName === 'code_exec_wait') &&
    typeof value.cellId === 'string' &&
    ['running', 'completed', 'failed', 'cancelled'].includes(String(value.status))
  )
    return publicCodeObservations(value.observations, {
      cellId: value.cellId,
      ...(isRecord(value.executionSource) &&
      value.executionSource.kind === 'CODE' &&
      typeof value.executionSource.text === 'string'
        ? {
            executionSource: {
              kind: 'CODE' as const,
              text: value.executionSource.text.slice(0, 10_000),
              truncated:
                value.executionSource.truncated === true ||
                value.executionSource.text.length > 10_000
            }
          }
        : {}),
      status: value.status as CodeCellEventData['status'],
      ...(value.outputHeadTruncated === true ? { outputHeadTruncated: true } : {}),
      ...(value.outputSourceKnown === true ? { outputSourceKnown: true } : {}),
      ...(value.outputSourceTruncated === true ? { outputSourceTruncated: true } : {}),
      cached: value.cached === true,
      ...(['snapshot', 'completion', 'timeout', 'yield', 'interrupted'].includes(
        String(value.waitOutcome)
      )
        ? { waitOutcome: value.waitOutcome as NonNullable<CodeCellEventData['waitOutcome']> }
        : {}),
      ...(value.waitOutcome === 'interrupted' && value.reason === 'steer'
        ? { reason: 'steer' as const }
        : {}),
      ...(value.truncated === true ? { truncated: true } : {}),
      ...(isRecord(value.error) &&
      typeof value.error.code === 'string' &&
      value.error.code.length > 0 &&
      typeof value.error.message === 'string'
        ? {
            ...(value.error.code.length > 80 || value.error.message.length > 1000
              ? { truncated: true }
              : {}),
            error: {
              code: value.error.code.slice(0, 80).replace(/[\uD800-\uDBFF]$/u, ''),
              message: value.error.message.slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, '')
            }
          }
        : {}),
      ...(isRecord(value.permissionStop)
        ? {
            permissionStop: value.permissionStop as unknown as NonNullable<
              CodeCellEventData['permissionStop']
            >
          }
        : {}),
      ...(Array.isArray(value.calls)
        ? {
            calls: value.calls.filter(
              (entry) =>
                isRecord(entry) &&
                ['apply_patch', 'todo_read', 'todo_write'].includes(String(entry.toolName))
            ) as NonNullable<CodeCellEventData['calls']>
          }
        : {}),
      ...(Array.isArray(value.observations)
        ? {
            observations: value.observations.filter(
              (entry) =>
                isRecord(entry) &&
                entry.type === 'tool_result' &&
                isRecord(entry.source) &&
                ['apply_patch', 'todo_read', 'todo_write'].includes(String(entry.source.toolName))
            ) as NonNullable<CodeCellEventData['observations']>
          }
        : {})
    });
  if (
    toolName === 'read' &&
    value.mode === 'batch' &&
    Array.isArray(value.results) &&
    typeof value.truncated === 'boolean' &&
    value.results.every(
      (result) =>
        isRecord(result) &&
        typeof result.path === 'string' &&
        (result.startLine === undefined || isNonnegativeInteger(result.startLine)) &&
        (result.endLine === undefined || isNonnegativeInteger(result.endLine)) &&
        (result.empty === undefined || result.empty === true) &&
        (result.contentRange === undefined ||
          (isRecord(result.contentRange) &&
            isNonnegativeInteger(result.contentRange.start) &&
            isNonnegativeInteger(result.contentRange.end) &&
            result.contentRange.end >= result.contentRange.start)) &&
        (result.error === undefined ||
          (isRecord(result.error) &&
            typeof result.error.code === 'string' &&
            typeof result.error.message === 'string'))
    )
  ) {
    const result = value as unknown as ReadEventData;
    return {
      mode: 'batch',
      truncated: result.truncated,
      results: result.results.map((item) => ({
        path: item.path,
        ...('startLine' in item && item.startLine !== undefined
          ? { startLine: item.startLine }
          : {}),
        ...('endLine' in item && item.endLine !== undefined ? { endLine: item.endLine } : {}),
        ...(item.contentRange === undefined ? {} : { contentRange: { ...item.contentRange } }),
        ...(item.empty === true ? { empty: true as const } : {}),
        ...('error' in item ? { error: { ...item.error } } : {})
      }))
    };
  }
  if (toolName === 'view_image') return parseViewImageResult(value);
  if (
    (toolName === 'exec' || toolName === 'exec_wait') &&
    (value.status === 'running' || value.status === 'completed' || value.status === 'cancelled') &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.truncated === 'boolean' &&
    (value.processId === undefined || typeof value.processId === 'string') &&
    (value.exitCode === undefined ||
      value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))) &&
    isNonnegativeInteger(value.stdoutBytes) &&
    isNonnegativeInteger(value.stderrBytes) &&
    isNonnegativeInteger(value.stdoutDroppedBytes) &&
    isNonnegativeInteger(value.stderrDroppedBytes)
  )
    return value as unknown as ExecResult;
  if (toolName === 'apply_patch') return parseApplyPatchResult(value);
  return undefined;
}

function parseViewImageResult(value: Record<string, unknown>): ViewImageResult | undefined {
  if (
    !(
      (typeof value.path === 'string' && value.path.length > 0 && value.resourceId === undefined) ||
      (typeof value.resourceId === 'string' &&
        value.resourceId.length > 0 &&
        value.path === undefined)
    ) ||
    (value.mimeType !== 'image/png' &&
      value.mimeType !== 'image/jpeg' &&
      value.mimeType !== 'image/webp') ||
    !isPositiveSafeInteger(value.bytes) ||
    value.bytes > TOOL_EXECUTION_LIMITS.viewImageMaxBytes ||
    !isPositiveSafeInteger(value.width) ||
    !isPositiveSafeInteger(value.height) ||
    !withinImagePixelLimit(value.width, value.height) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    return undefined;

  const hasSourceWidth = Object.hasOwn(value, 'sourceWidth');
  const hasSourceHeight = Object.hasOwn(value, 'sourceHeight');
  if (hasSourceWidth !== hasSourceHeight) return undefined;
  if (
    hasSourceWidth &&
    (!isPositiveSafeInteger(value.sourceWidth) ||
      !isPositiveSafeInteger(value.sourceHeight) ||
      !withinImagePixelLimit(value.sourceWidth, value.sourceHeight) ||
      value.width > value.sourceWidth ||
      value.height > value.sourceHeight)
  )
    return undefined;

  let region: ViewImageRegion | undefined;
  if (Object.hasOwn(value, 'region')) {
    if (!isRecord(value.region)) return undefined;
    const candidate = value.region;
    if (
      Object.keys(candidate).some((key) => !['x', 'y', 'width', 'height'].includes(key)) ||
      !isNonnegativeSafeInteger(candidate.x) ||
      !isNonnegativeSafeInteger(candidate.y) ||
      !isPositiveSafeInteger(candidate.width) ||
      !isPositiveSafeInteger(candidate.height) ||
      !hasSourceWidth ||
      candidate.x > (value.sourceWidth as number) ||
      candidate.y > (value.sourceHeight as number) ||
      candidate.width > (value.sourceWidth as number) - candidate.x ||
      candidate.height > (value.sourceHeight as number) - candidate.y ||
      value.width > candidate.width ||
      value.height > candidate.height
    )
      return undefined;
    region = {
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height
    };
  }

  return {
    ...(typeof value.path === 'string'
      ? { path: value.path }
      : { resourceId: value.resourceId as string }),
    mimeType: value.mimeType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(hasSourceWidth
      ? { sourceWidth: value.sourceWidth as number, sourceHeight: value.sourceHeight as number }
      : {}),
    ...(region ? { region } : {}),
    sha256: value.sha256
  };
}

function withinImagePixelLimit(width: number, height: number): boolean {
  return width <= Math.floor(TOOL_EXECUTION_LIMITS.viewImageMaxPixels / height);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Partial patch facts are allowlisted; arbitrary error details never become public event data. */
export function structuredToolFailureData(
  toolName: string,
  error: unknown
): ApplyPatchPartialResult | undefined {
  return toolName === 'apply_patch' &&
    error instanceof AgentError &&
    error.code === 'MAR_AGENT_PATCH_PARTIAL'
    ? parseApplyPatchPartialResult(error.details)
    : undefined;
}

export function structuredToolArtifacts(
  value: readonly AgentToolArtifact[] | undefined
): readonly AgentToolArtifact[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value.some(
      (artifact) =>
        !artifact ||
        artifact.kind !== 'image' ||
        artifact.mimeType !== 'image/png' ||
        typeof artifact.name !== 'string' ||
        artifact.name.length === 0 ||
        typeof artifact.fileName !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.png$/u.test(artifact.fileName) ||
        !isNonnegativeInteger(artifact.byteSize) ||
        typeof artifact.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
  )
    throw new AgentError('MAR_AGENT_TOOL_OUTPUT_INVALID', 'Tool image artifact is invalid.');
  return value.map((artifact) => ({ ...artifact }));
}

/** Shared result contract for model, programmatic, and native API callers. */
export function validateToolResult(value: ToolExecutionResult): ToolExecutionResult {
  if (!value || typeof value.content !== 'string')
    throw new AgentError(
      'MAR_AGENT_TOOL_OUTPUT_INVALID',
      'Tool result must contain string content.'
    );
  const artifacts = structuredToolArtifacts(value.artifacts);
  return artifacts === undefined ? value : { ...value, artifacts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
