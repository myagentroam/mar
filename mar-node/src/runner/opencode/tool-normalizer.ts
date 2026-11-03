import { compactRunnerText, compactRunnerValue, publicToolOutput } from '../normalization.js';
import { shellExecution } from '../execution-presentation.js';

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
        toolName: publicToolName,
        command: compactRunnerText(
          typeof input?.command === 'string'
            ? input.command
            : typeof input?.cmd === 'string'
              ? input.cmd
              : publicToolName,
          10_000
        ),
        cwd: typeof input?.cwd === 'string' ? compactRunnerText(input.cwd, 4_096) : null,
        exitCode: typeof state?.exitCode === 'number' ? state.exitCode : null,
        durationMs: null,
        ...(typeof state?.output === 'string'
          ? { output: publicToolOutput(state.output, undefined, 'COMBINED') }
          : {}),
        toolPresentation: shellExecution(
          (typeof input?.command === 'string' && input.command.length > 10_000) ||
            (typeof input?.cmd === 'string' && input.cmd.length > 10_000) ||
            (typeof input?.cwd === 'string' && input.cwd.length > 4_096)
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
      outputSummary: null,
      progressLabel: null,
      errorCode: status === 'FAILED' ? 'OPENCODE_TOOL_FAILED' : null,
      ...(compactRunnerValue(state?.input, 10_000).truncated ? { inputTruncated: true } : {}),
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
      ...(normalizedName === 'webfetch' && typeof input?.url === 'string'
        ? {
            toolPresentation: {
              kind: 'WEB_FETCH',
              detailOnly: true,
              requestUrl: compactRunnerText(input.url, 8192)
            }
          }
        : normalizedName === 'websearch' && typeof input?.query === 'string'
          ? {
              toolPresentation: {
                kind: 'WEB_SEARCH',
                detailOnly: true,
                query: compactRunnerText(input.query, 500)
              }
            }
          : {}),
      ...(typeof state?.output === 'string' ? { output: publicToolOutput(state.output) } : {}),
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
      : {
          outputSummary: null,
          output: publicToolOutput(nativeResult.result)
        })
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
