import { claudeContentBlocks } from './message-parsers.js';
import {
  compactRunnerText,
  compactRunnerValue,
  publicOutputSnapshot,
  publicToolOutput
} from '../normalization.js';
import { shellExecution } from '../execution-presentation.js';
import type {
  NativeTranscriptToolCall,
  NativeTranscriptSubagentResult
} from '../../native-transcript-model.js';
import {
  RunnerUsageTracker,
  usageToken,
  usageTokenSum,
  type RunnerUsageFact,
  type RunnerUsageValues
} from '../../service/runner-usage-tracker.js';

export class ClaudeUsageNormalizer {
  private readonly tracker: RunnerUsageTracker;
  private readonly messages = new Map<string, { id: string; values: RunnerUsageValues }>();
  constructor(identity: string, publish: (value: RunnerUsageFact) => void) {
    this.tracker = new RunnerUsageTracker(identity, publish);
  }
  observe(value: unknown): void {
    const envelope = record(value);
    if (!envelope) return;
    const parent =
      typeof envelope.parent_tool_use_id === 'string' ? envelope.parent_tool_use_id : '';
    const event = envelope.type === 'stream_event' ? record(envelope.event) : undefined;
    const message = record(envelope.type === 'assistant' ? envelope.message : event?.message);
    const previous = this.messages.get(parent);
    const id = typeof message?.id === 'string' ? message.id : previous?.id;
    if (!id || message?.model === '<synthetic>') return;
    const usage = record(message?.usage ?? event?.usage);
    let values: RunnerUsageValues = {
      ...(previous?.id === id ? previous.values : {}),
      purpose: 'conversation',
      agentRole: parent ? 'subagent' : 'root',
      ...(typeof message?.model === 'string' ? { actualModel: message.model } : {})
    };
    if (usage) {
      const input = usageToken(usage.input_tokens),
        read = usageToken(usage.cache_read_input_tokens),
        write = usageToken(usage.cache_creation_input_tokens),
        output = usageToken(usage.output_tokens);
      values = {
        ...values,
        ...(input === undefined
          ? {}
          : { inputTokens: usageTokenSum(input, read ?? '0', write ?? '0')! }),
        ...(output === undefined ? {} : { outputTokens: output }),
        ...(read === undefined ? {} : { cacheReadTokens: read }),
        ...(write === undefined ? {} : { cacheWriteTokens: write })
      };
    }
    this.messages.set(parent, { id, values });
    if (usage || event?.type === 'message_stop')
      this.tracker.snapshot(
        id,
        values,
        event?.type === 'message_stop' ||
          typeof record(event?.delta)?.stop_reason === 'string' ||
          typeof message?.stop_reason === 'string',
        'partial'
      );
  }
  finish(state: 'succeeded' | 'failed' | 'cancelled'): void {
    this.tracker.finish(state);
  }
}

export interface ClaudeToolResultMetadata {
  readonly agentId?: string;
  readonly task_id?: string;
  readonly task_type?: string;
}

export function claudeNativeToolResultMetadata(
  result: NativeTranscriptSubagentResult | undefined
): ClaudeToolResultMetadata | undefined {
  if (result === undefined) return undefined;
  return {
    ...(result.agentId === undefined ? {} : { agentId: result.agentId }),
    ...(result.taskId === undefined ? {} : { task_id: result.taskId }),
    ...(result.taskType === undefined ? {} : { task_type: result.taskType })
  };
}

export function restoreClaudeSubagentTitles(
  calls: readonly NativeTranscriptToolCall[]
): Map<string, string> {
  const titles = new Map<string, string>();
  for (const call of calls)
    claudeSubagentProjection(
      call.toolName,
      call.input,
      claudeNativeToolResultMetadata(call.subagentResult) ?? call.outputSummary,
      titles
    );
  return titles;
}

export function extractClaudeToolResults(message: Record<string, unknown>): readonly {
  readonly toolUseId: string;
  readonly output: string;
  readonly failed: boolean;
  readonly truncated: boolean;
  readonly claudeResult?: ClaudeToolResultMetadata;
}[] {
  // This ID describes the owning subagent, not the tool call producing the result.
  if (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null) return [];
  const blocks = claudeContentBlocks(message).filter(
    (block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string'
  );
  return blocks.map((block) => {
    const textBlocks = Array.isArray(block.content)
      ? block.content.flatMap((part) => {
          const value = record(part);
          return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
        })
      : [];
    const content =
      Array.isArray(block.content) && textBlocks.length === block.content.length
        ? textBlocks.join('\n')
        : block.content;
    const output = publicOutputSnapshot(content);
    // A message-level structured result cannot be assigned to multiple calls.
    const structured = blocks.length === 1 ? structuredRecord(message.tool_use_result) : undefined;
    const fields = structured ?? structuredRecord(block.content);
    const agentId = boundedId(fields?.agentId);
    const taskId = boundedId(fields?.task_id);
    const taskType = boundedId(fields?.task_type);
    const claudeResult: ClaudeToolResultMetadata = {
      ...(agentId === undefined ? {} : { agentId }),
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(taskType === undefined ? {} : { task_type: taskType })
    };
    return {
      toolUseId: block.tool_use_id as string,
      output: output.text,
      failed: block.is_error === true,
      truncated: output.truncated,
      ...(Object.keys(claudeResult).length === 0 ? {} : { claudeResult })
    };
  });
}

export function normalizeClaudeTool(
  toolName: string,
  input: unknown,
  output: string | null,
  failed: boolean,
  truncated: boolean,
  knownSubagents: Map<string, string> = new Map(),
  resultMetadata?: ClaudeToolResultMetadata,
  sourceOutputTruncated = output === null ? false : truncated,
  sourceInputTruncated = output === null ? truncated : false,
  outputDirection?: 'HEAD' | 'SOURCE'
): { kind: 'command_execution' | 'file_change' | 'tool_call'; payload: Record<string, unknown> } {
  const values = record(input);
  const normalizedToolName = compactRunnerText(toolName, 128) || 'unknown';
  const subagent = claudeSubagentProjection(
    toolName,
    input,
    resultMetadata ?? output,
    knownSubagents
  );
  if (isCommandTool(toolName))
    return {
      kind: 'command_execution',
      payload: {
        toolName: normalizedToolName,
        command: compactRunnerText(
          typeof values?.command === 'string' ? values.command : normalizedToolName,
          10_000
        ),
        cwd: null,
        exitCode: null,
        durationMs: null,
        ...(output === null || output === undefined
          ? {}
          : {
              output: publicToolOutput(
                output,
                outputDirection ?? (sourceOutputTruncated ? 'SOURCE' : undefined),
                'COMBINED'
              )
            }),
        toolPresentation: shellExecution(
          sourceInputTruncated ||
            (typeof values?.command === 'string' && values.command.length > 10_000)
        )
      }
    };
  if (isFileTool(toolName)) {
    const path =
      typeof values?.file_path === 'string'
        ? values.file_path
        : typeof values?.path === 'string'
          ? values.path
          : typeof values?.notebook_path === 'string'
            ? values.notebook_path
            : null;
    const normalizedPath = path === null ? null : compactRunnerText(path, 4_096);
    return {
      kind: 'file_change',
      payload: {
        changes:
          normalizedPath === null || normalizedPath.length === 0
            ? []
            : [
                {
                  path: normalizedPath,
                  change: 'MODIFIED',
                  additions: null,
                  deletions: null
                }
              ]
      }
    };
  }
  return {
    kind: 'tool_call',
    payload: {
      namespace: 'claude-code',
      toolName: normalizedToolName,
      title: compactRunnerText(toolName, 500) || normalizedToolName,
      inputSummary: compactRunnerValue(input, 10_000).text || null,
      outputSummary: null,
      ...(output === null
        ? {}
        : {
            output: publicToolOutput(
              output,
              outputDirection ?? (sourceOutputTruncated ? 'SOURCE' : undefined)
            )
          }),
      progressLabel: null,
      errorCode: failed ? 'TOOL_EXECUTION_FAILED' : null,
      ...(sourceInputTruncated || compactRunnerValue(input, 10_000).truncated
        ? { inputTruncated: true }
        : {}),
      ...(toolName === 'Read'
        ? {
            toolPresentation: {
              kind: 'READ',
              paths:
                typeof values?.file_path === 'string' && values.file_path.length > 0
                  ? [compactRunnerText(values.file_path, 4096)]
                  : []
            }
          }
        : {}),
      ...subagent
    }
  };
}

function isCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'bash' || name === 'Shell';
}

function isFileTool(name: string): boolean {
  return name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function claudeSubagentProjection(
  toolName: string,
  input: unknown,
  output: unknown,
  knownSubagents: Map<string, string>
): Record<string, unknown> | undefined {
  const normalizedName = toolName.toLowerCase();
  const operation =
    normalizedName === 'agent'
      ? 'START'
      : normalizedName === 'taskoutput'
        ? 'STATUS'
        : normalizedName === 'taskstop'
          ? 'CANCEL'
          : normalizedName === 'sendmessage'
            ? 'MESSAGE'
            : undefined;
  if (operation === undefined) return undefined;
  const inputData = structuredRecord(input);
  const outputData = structuredRecord(output);
  const subagentId =
    normalizedName === 'agent'
      ? boundedId(outputData?.agentId)
      : normalizedName === 'sendmessage'
        ? boundedId(inputData?.to)
        : (boundedId(inputData?.task_id) ?? boundedId(outputData?.task_id));
  if (normalizedName === 'taskoutput' || normalizedName === 'taskstop') {
    const taskType = outputData?.task_type;
    if (typeof taskType === 'string') {
      if (taskType !== 'local_agent' && taskType !== 'remote_agent') return undefined;
    } else if (subagentId === undefined || !knownSubagents.has(subagentId)) return undefined;
  }
  const title =
    normalizedName === 'agent' && typeof inputData?.description === 'string'
      ? compactRunnerText(inputData.description, 500)
      : subagentId === undefined
        ? ''
        : (knownSubagents.get(subagentId) ?? '');
  if (subagentId !== undefined && normalizedName === 'agent') knownSubagents.set(subagentId, title);
  return {
    subagentOperation: operation,
    subagentId: subagentId === '*' ? null : (subagentId ?? null),
    ...(operation === 'STATUS' ? { subagentWait: inputData?.block === true } : {}),
    ...(title.length === 0 ? {} : { title })
  };
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
