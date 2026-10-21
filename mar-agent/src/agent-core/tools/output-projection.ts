import { MarAgentError } from '../error.js';
import { parseApplyPatchResult, parseApplyPatchPartialResult } from './shared/patch-result.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import { countModelTokens, countTextLines, truncateModelText } from '../runtime/token-budget.js';
import type { SubagentTaskSnapshot, SubagentManyOutput } from '../subagent/contracts.js';
import type {
  ApplyPatchResult,
  ApplyPatchPartialResult,
  CodeCellEventData,
  ExecResult,
  MarAgentToolArtifact,
  ToolExecutionResult,
  ReadEventData,
  ViewImageResult
} from './contracts.js';
import { TOOL_EXECUTION_LIMITS } from './execution-limits.js';
import type { BatchReadResult } from './local/read.js';
import type { ToolRuntimeImage } from './runtime-context.js';
import type { SleepResult } from './agent/sleep.js';
import { publicToolMetadata, type PublicToolMetadata } from './public-metadata.js';
export function currentExecutionImages(
  modelInputImages:
    readonly { readonly mimeType: string; readonly dataBase64: string }[] | undefined,
  toolImages: readonly ToolRuntimeImage[]
): ToolRuntimeImage[] {
  return [
    ...(modelInputImages ?? []).map((image) => ({
      mimeType: image.mimeType,
      data: Buffer.from(image.dataBase64, 'base64')
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
  | SubagentTaskSnapshot
  | SubagentManyOutput
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
    toolName === 'agent_wait' &&
    (value.mode === 'any' || value.mode === 'all') &&
    (value.waitFor === 'completion' || value.waitFor === 'message') &&
    ['snapshot', 'message', 'completion', 'timeout', 'interrupted'].includes(
      String(value.waitOutcome)
    ) &&
    Array.isArray(value.agents) &&
    value.agents.length > 0 &&
    value.agents.length <= TOOL_EXECUTION_LIMITS.agentWaitMaxAgents &&
    value.agents.every((agent) => isRecord(agent) && isSubagentTaskSnapshot(agent)) &&
    Array.isArray(value.pendingAgentIds) &&
    value.pendingAgentIds.every(
      (id) =>
        typeof id === 'string' &&
        (value.agents as SubagentTaskSnapshot[]).some((agent) => agent.agentId === id)
    )
  )
    return value as unknown as SubagentManyOutput;
  if (
    (toolName === 'code_exec' || toolName === 'code_exec_wait') &&
    typeof value.cellId === 'string' &&
    ['running', 'completed', 'failed', 'cancelled'].includes(String(value.status))
  )
    return {
      cellId: value.cellId,
      status: value.status as CodeCellEventData['status'],
      cached: value.cached === true,
      ...(['snapshot', 'completion', 'timeout', 'yield', 'interrupted'].includes(
        String(value.waitOutcome)
      )
        ? { waitOutcome: value.waitOutcome as NonNullable<CodeCellEventData['waitOutcome']> }
        : {}),
      ...(value.waitOutcome === 'interrupted' && value.reason === 'steer'
        ? { reason: 'steer' as const }
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
                [
                  'apply_patch',
                  'todo_read',
                  'todo_write',
                  'agent_start',
                  'agent_wait',
                  'agent_message',
                  'agent_cancel'
                ].includes(String(entry.toolName))
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
                [
                  'apply_patch',
                  'todo_read',
                  'todo_write',
                  'agent_start',
                  'agent_wait',
                  'agent_message',
                  'agent_cancel'
                ].includes(String(entry.source.toolName))
            ) as NonNullable<CodeCellEventData['observations']>
          }
        : {})
    };
  if (
    (toolName === 'agent_start' ||
      toolName === 'agent_wait' ||
      toolName === 'agent_message' ||
      toolName === 'agent_cancel') &&
    isSubagentTaskSnapshot(value)
  )
    return value;
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
        (result.error === undefined ||
          (isRecord(result.error) &&
            typeof result.error.code === 'string' &&
            typeof result.error.message === 'string'))
    )
  ) {
    const result = value as unknown as BatchReadResult;
    return {
      mode: 'batch',
      truncated: result.truncated,
      results: result.results.map((item) => ({
        path: item.path,
        ...('startLine' in item && item.startLine !== undefined
          ? { startLine: item.startLine }
          : {}),
        ...('endLine' in item && item.endLine !== undefined ? { endLine: item.endLine } : {}),
        ...('error' in item ? { error: { ...item.error } } : {})
      }))
    };
  }
  if (
    toolName === 'view_image' &&
    typeof value.path === 'string' &&
    (value.mimeType === 'image/png' ||
      value.mimeType === 'image/jpeg' ||
      value.mimeType === 'image/webp') &&
    isNonnegativeInteger(value.bytes) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  )
    return value as unknown as ViewImageResult;
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

/** Partial patch facts are allowlisted; arbitrary error details never become public event data. */
export function structuredToolFailureData(
  toolName: string,
  error: unknown
): ApplyPatchPartialResult | undefined {
  return toolName === 'apply_patch' &&
    error instanceof MarAgentError &&
    error.code === 'MAR_AGENT_PATCH_PARTIAL'
    ? parseApplyPatchPartialResult(error.details)
    : undefined;
}

export function structuredToolArtifacts(
  value: readonly MarAgentToolArtifact[] | undefined
): readonly MarAgentToolArtifact[] | undefined {
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
    throw new MarAgentError('MAR_AGENT_TOOL_OUTPUT_INVALID', 'Tool image artifact is invalid.');
  return value.map((artifact) => ({ ...artifact }));
}

/** Shared result contract for model, programmatic, and native API callers. */
export function validateToolResult(value: ToolExecutionResult): ToolExecutionResult {
  if (!value || typeof value.content !== 'string')
    throw new MarAgentError(
      'MAR_AGENT_TOOL_OUTPUT_INVALID',
      'Tool result must contain string content.'
    );
  const artifacts = structuredToolArtifacts(value.artifacts);
  return artifacts === undefined ? value : { ...value, artifacts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSubagentTaskSnapshot(value: Record<string, unknown>): value is SubagentTaskSnapshot {
  return (
    typeof value.agentId === 'string' &&
    value.agentId.length > 0 &&
    value.agentId.length <= 128 &&
    typeof value.description === 'string' &&
    value.description.length > 0 &&
    value.description.length <= TOOL_EXECUTION_LIMITS.subagentDescriptionMaxCharacters &&
    (value.status === 'queued' ||
      value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'interrupted') &&
    (value.modelId === undefined || typeof value.modelId === 'string') &&
    (value.modelName === undefined || typeof value.modelName === 'string') &&
    (value.reasoningEffort === undefined ||
      (typeof value.reasoningEffort === 'string' &&
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort))) &&
    (value.waitOutcome === undefined ||
      value.waitOutcome === 'snapshot' ||
      value.waitOutcome === 'message' ||
      value.waitOutcome === 'completion' ||
      value.waitOutcome === 'timeout' ||
      value.waitOutcome === 'interrupted') &&
    (value.latestMessage === undefined ||
      (isRecord(value.latestMessage) &&
        typeof value.latestMessage.itemId === 'string' &&
        typeof value.latestMessage.turnId === 'string' &&
        (value.latestMessage.phase === 'commentary' ||
          value.latestMessage.phase === 'final_answer') &&
        typeof value.latestMessage.text === 'string' &&
        typeof value.latestMessage.timestamp === 'string' &&
        typeof value.latestMessage.truncated === 'boolean')) &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.changedFiles === undefined ||
      (Array.isArray(value.changedFiles) &&
        value.changedFiles.every((path) => typeof path === 'string'))) &&
    (value.verification === undefined ||
      (Array.isArray(value.verification) &&
        value.verification.every((item) => typeof item === 'string'))) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(
          (item) =>
            isRecord(item) &&
            typeof item.path === 'string' &&
            (item.startLine === undefined ||
              (typeof item.startLine === 'number' &&
                Number.isInteger(item.startLine) &&
                item.startLine >= 1)) &&
            (item.endLine === undefined ||
              (typeof item.endLine === 'number' &&
                Number.isInteger(item.endLine) &&
                item.endLine >= 1))
        ))) &&
    (value.errorCode === undefined || typeof value.errorCode === 'string')
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
