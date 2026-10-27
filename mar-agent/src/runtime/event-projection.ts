import type { ModelEvent, ModelUsage } from '../model/contracts.js';
import type { ExecResult } from '../tools/contracts.js';
import type { EventPayload, AgentEvent } from './events.js';
import { AGENT_EXECUTION_POLICY } from './execution-policy.js';
import { publicToolMetadata } from './public-tool-metadata.js';

/** Mark display-only clipping without changing tool output or model context. */
export function toolEventSummary(text: string): { summary: string; truncated: boolean } {
  const limit = AGENT_EXECUTION_POLICY.toolEventSummaryCharacters;
  if (text.length <= limit) return { summary: text, truncated: false };
  const marker = '... [tool event summary truncated]';
  const prefix = text.slice(0, limit - marker.length).replace(/[\uD800-\uDBFF]$/u, '');
  return { summary: prefix + marker, truncated: true };
}

/** Keep streaming deltas live-only; exec output has one durable copy in model context records. */
export function eventForPersistence(event: AgentEvent): AgentEvent | undefined {
  if (
    event.type === 'message.delta' ||
    event.type === 'tool.output' ||
    event.type === 'input.received' ||
    (event.type === 'context.compacting' && event.async !== true && event.stage === undefined) ||
    event.type === 'model.performance' ||
    event.type === 'message.performance'
  )
    return undefined;
  if (event.type !== 'tool.completed' || event.toolName !== 'exec' || !event.data) return event;
  const metadata = Object.fromEntries(
    Object.entries(event.data as ExecResult).filter(([key]) => key !== 'stdout' && key !== 'stderr')
  ) as Omit<ExecResult, 'stdout' | 'stderr'>;
  return { ...event, data: metadata };
}

export function publicModelUsage(usage: ModelUsage): Omit<ModelUsage, 'rolloutBudgetUnits'> {
  const { rolloutBudgetUnits, ...publicUsage } = usage;
  void rolloutBudgetUnits;
  return publicUsage;
}

/** Provider-hosted calls are ordinary public tools, never local execution requests. */
export function publicHostedToolEvents(
  event: Extract<ModelEvent, { type: 'hosted_tool' }>
): readonly EventPayload[] {
  const toolName = event.toolName ?? (event.kind === 'WEB_SEARCH' ? 'web_search' : 'web_fetch');
  const legacyInput = {
    ...(event.summary.query === undefined ? {} : { query: event.summary.query }),
    ...(event.summary.url === undefined ? {} : { url: event.summary.url })
  };
  const input = event.input ?? (Object.keys(legacyInput).length ? legacyInput : undefined);
  const legacyOutput = {
    ...(event.summary.title === undefined ? {} : { title: event.summary.title }),
    ...(event.summary.sources?.length ? { sources: event.summary.sources.slice(0, 20) } : {}),
    ...(event.summary.sourcesTruncated === true || (event.summary.sources?.length ?? 0) > 20
      ? { sourcesTruncated: true }
      : {})
  };
  const output = event.output ?? (Object.keys(legacyOutput).length ? legacyOutput : undefined);
  const text =
    typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output);
  const preview = toolEventSummary(text);
  const summary = preview.summary;
  const truncated =
    event.truncated === true || legacyOutput.sourcesTruncated === true || preview.truncated;
  const started: EventPayload = {
    type: 'tool.started',
    toolName,
    callId: event.itemId,
    data: {
      ...publicToolMetadata(
        event.kind === 'WEB_SEARCH' ? 'web_search' : 'web_fetch',
        event.summary
      ),
      hostedToolKind: event.kind
    },
    ...(input === undefined ? {} : { input }),
    ...(truncated ? { truncated: true } : {})
  };
  if (event.status === 'RUNNING') return [started];
  if (event.status === 'FAILED')
    return [
      started,
      {
        type: 'tool.failed',
        toolName,
        callId: event.itemId,
        code: 'HOSTED_TOOL_FAILED',
        message: summary || 'Hosted tool failed.',
        truncated
      }
    ];
  return [
    started,
    {
      type: 'tool.completed',
      toolName,
      callId: event.itemId,
      summary,
      truncated,
      data: started.data!
    }
  ];
}
