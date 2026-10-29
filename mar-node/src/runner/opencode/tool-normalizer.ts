import { compactRunnerText, compactRunnerValue } from '../normalization.js';
import { publicOutputSnapshot, shellExecution } from '../execution-presentation.js';

export function normalizeOpenCodeTool(
  toolName: string,
  state: Record<string, unknown> | undefined
): { kind: 'command_execution' | 'tool_call'; payload: Record<string, unknown> } {
  const status =
    state?.status === 'completed'
      ? 'COMPLETED'
      : state?.status === 'error'
        ? 'FAILED'
        : 'IN_PROGRESS';
  const input = record(state?.input);
  const normalizedName = toolName.toLowerCase();
  const publicToolName = compactRunnerText(toolName, 128) || 'unknown';
  const subagent = openCodeSubagentProjection(toolName, state?.input, state?.output);
  if (normalizedName === 'bash' || normalizedName === 'shell' || normalizedName === 'cmd')
    return {
      kind: 'command_execution',
      payload: {
        command: compactRunnerText(
          typeof input?.command === 'string'
            ? input.command
            : typeof input?.cmd === 'string'
              ? input.cmd
              : publicToolName,
          10_000
        ),
        cwd: typeof input?.cwd === 'string' ? compactRunnerText(input.cwd, 4_096) : null,
        outputPreview:
          typeof state?.output === 'string' ? compactRunnerText(state.output, 10_000) : '',
        outputRef: null,
        exitCode: typeof state?.exitCode === 'number' ? state.exitCode : null,
        durationMs: null,
        truncated: typeof state?.output === 'string' && state.output.length > 10_000,
        ...(typeof state?.output === 'string'
          ? { output: publicOutputSnapshot(state.output) }
          : {}),
        toolPresentation: shellExecution(
          typeof state?.output === 'string' ? state.output : undefined
        )
      }
    };
  return {
    kind: 'tool_call',
    payload: {
      namespace: 'opencode',
      toolName: publicToolName,
      title:
        compactRunnerText(typeof state?.title === 'string' ? state.title : toolName, 500) ||
        publicToolName,
      inputSummary: compactRunnerValue(state?.input, 10_000).text || null,
      outputSummary:
        typeof state?.output === 'string' ? compactRunnerText(state.output, 10_000) : null,
      progressLabel: null,
      errorCode: status === 'FAILED' ? 'OPENCODE_TOOL_FAILED' : null,
      truncated: false,
      ...(normalizedName === 'read'
        ? {
            toolPresentation: {
              kind: 'READ',
              paths:
                typeof input?.filePath === 'string' && input.filePath.length > 0
                  ? [compactRunnerText(input.filePath, 4096)]
                  : []
            }
          }
        : {}),
      ...subagent
    }
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function openCodeSubagentProjection(
  toolName: string,
  input: unknown,
  output: unknown
): Record<string, unknown> | undefined {
  if (toolName.toLowerCase() !== 'task') return undefined;
  const inputData = record(input);
  const taskId = boundedId(inputData?.task_id) ?? boundedId(inputData?.taskId);
  const nativeResult = openCodeTaskResult(output);
  const title =
    typeof inputData?.description === 'string' ? compactRunnerText(inputData.description, 500) : '';
  return {
    subagentOperation: taskId === undefined ? 'START' : 'RESUME',
    subagentId: taskId ?? nativeResult?.taskId ?? null,
    ...(title.length === 0 ? {} : { title }),
    ...(nativeResult === undefined
      ? {}
      : { outputSummary: compactRunnerText(nativeResult.result, 10_000) || null })
  };
}

function openCodeTaskResult(
  value: unknown
): { readonly taskId: string; readonly result: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match =
    /^<task\s+[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<task_result>([\s\S]*?)<\/task_result>[\s\S]*?<\/task>$/u.exec(
      value.trim()
    );
  const taskId = boundedId(match?.[1]);
  return taskId === undefined || match?.[2] === undefined
    ? undefined
    : { taskId, result: match[2].trim() };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}
