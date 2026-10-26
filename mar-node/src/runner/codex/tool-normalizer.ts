import { compactRunnerText } from '../../util/node-operation-parsers.js';

export function normalizeCodexApproval(method: string) {
  return method === 'item/commandExecution/requestApproval'
    ? { toolName: 'command_execution', reason: 'Command execution requires approval.' }
    : { toolName: 'file_change', reason: 'File changes require approval.' };
}

export type CodexNormalizedTool = {
  readonly kind: 'command_execution' | 'file_change' | 'tool_call';
  readonly payload: Record<string, unknown>;
};

export function normalizeCodexTool(input: {
  readonly name: string;
  readonly namespace?: string;
  readonly rawInput?: unknown;
  readonly inputSummary?: string | null;
  readonly outputSummary?: string | null;
  readonly truncated?: boolean;
  readonly outputOnly?: boolean;
  readonly attachments?: readonly unknown[];
}): CodexNormalizedTool {
  const name = compactRunnerText(input.name, 128) || 'tool';
  const rawInput = input.rawInput;
  const attachments = input.attachments ?? [];
  const subagent = codexSubagentProjection(input.namespace, name, rawInput, input.outputSummary);
  if (isCommandTool(name)) {
    const outputPreview = compactRunnerText(input.outputSummary ?? '', 10_000);
    if (input.outputOnly === true)
      return {
        kind: 'command_execution',
        payload: {
          outputPreview,
          truncated: input.truncated === true || (input.outputSummary?.length ?? 0) > 10_000,
          ...(attachments.length === 0 ? {} : { attachments })
        }
      };
    const values = record(rawInput);
    const command =
      typeof rawInput === 'string'
        ? rawInput
        : typeof values?.cmd === 'string'
          ? values.cmd
          : typeof values?.command === 'string'
            ? values.command
            : input.inputSummary || name;
    return {
      kind: 'command_execution',
      payload: {
        command: compactRunnerText(command, 10_000),
        cwd: typeof values?.cwd === 'string' ? compactRunnerText(values.cwd, 4_096) : null,
        outputPreview,
        outputRef: null,
        exitCode: null,
        durationMs: null,
        truncated:
          input.truncated === true ||
          command.length > 10_000 ||
          (input.outputSummary?.length ?? 0) > 10_000,
        ...(attachments.length === 0 ? {} : { attachments })
      }
    };
  }
  if (input.outputOnly === true)
    return {
      kind: 'tool_call',
      payload: {
        outputSummary: input.outputSummary ?? null,
        ...subagent,
        ...(attachments.length === 0 ? {} : { attachments })
      }
    };
  return {
    kind: 'tool_call',
    payload: {
      title: name,
      namespace: compactRunnerText(input.namespace ?? 'codex', 128),
      toolName: name,
      inputSummary: input.inputSummary ?? null,
      outputSummary: input.outputSummary ?? null,
      progressLabel: null,
      errorCode: null,
      truncated: input.truncated === true,
      ...subagent,
      ...(attachments.length === 0 ? {} : { attachments })
    }
  };
}

function isCommandTool(name: string): boolean {
  return name === 'exec_command';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexSubagentProjection(
  namespace: string | undefined,
  toolName: string,
  input: unknown,
  output: unknown
): Record<string, unknown> | undefined {
  if (
    namespace !== undefined &&
    namespace.length > 0 &&
    !['codex', 'collaboration', 'multi_agent_v1', 'multi_agent_v2'].includes(
      namespace.toLowerCase()
    )
  )
    return undefined;
  const operation =
    toolName === 'spawn_agent'
      ? 'START'
      : toolName === 'wait_agent' || toolName === 'list_agents'
        ? 'STATUS'
        : toolName === 'close_agent' || toolName === 'interrupt_agent'
          ? 'CANCEL'
          : toolName === 'send_input' || toolName === 'send_message' || toolName === 'followup_task'
            ? 'MESSAGE'
            : toolName === 'resume_agent'
              ? 'RESUME'
              : undefined;
  if (operation === undefined) return undefined;
  const inputData = structuredRecord(input);
  const title =
    operation === 'START' && typeof inputData?.task_name === 'string'
      ? compactRunnerText(inputData.task_name, 500)
      : '';
  return {
    subagentOperation: operation,
    ...(toolName === 'wait_agent' ? { subagentWait: true } : {}),
    subagentId:
      Array.isArray(inputData?.targets) && inputData.targets.length > 1
        ? null
        : (codexSubagentId(input) ?? codexSubagentId(output) ?? null),
    ...(title.length === 0 ? {} : { title })
  };
}

function codexSubagentId(value: unknown): string | undefined {
  const data = structuredRecord(value);
  if (data === undefined) return undefined;
  for (const key of ['agentId', 'agent_id', 'target', 'id']) {
    const candidate = boundedId(data[key]);
    if (candidate !== undefined) return candidate;
  }
  if (Array.isArray(data.targets) && data.targets.length === 1) {
    for (const target of data.targets) {
      const candidate = boundedId(target);
      if (candidate !== undefined) return candidate;
    }
  }
  for (const key of ['data', 'result', 'output']) {
    const candidate = codexSubagentId(data[key]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function structuredRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value);
  const text = value.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}
