import type { NodeAgentSession } from '../database.js';
import type { NodeConversationItem } from '../runtime-model.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import { isPlainRecord, isTerminalRunStatus } from '../util/node-operation-parsers.js';

interface PublicActivity {
  readonly name: string;
  readonly state: string;
  readonly summary: string;
  readonly at: number | null;
  readonly runId: string | null;
  readonly truncated: boolean;
}
type LatestActivity = PublicActivity & { kind: 'tool' | 'message' };

/** Projects only already-observed, process-local public facts. Never reads native history. */
function activity(runtime: NodeRuntimeState, sessionId: string) {
  const candidate = runtime.activeSessionRun(sessionId);
  const run = candidate && !isTerminalRunStatus(candidate.status) ? candidate : undefined;
  const turns = runtime.conversationTail(sessionId);
  let sleeping = false;
  let latestActivity: LatestActivity | null = null;
  let latestMessage: {
    text: string;
    state: string;
    at: number | null;
    runId: string | null;
    truncated: boolean;
  } | null = null;
  const recentTools: PublicActivity[] = [];
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const turn = turns[t]!;
    if (run && turn.runId !== run.id) continue;
    for (let i = turn.items.length - 1; i >= 0; i -= 1) {
      const item = turn.items[i]!;
      if (item.parentItemId !== null) continue;
      const payload = isPlainRecord(item.payload) ? item.payload : {};
      const at = time(item);
      const isLatest = isNewerActivity(
        latestActivity,
        at,
        item.kind === 'assistant_message' ? 'message' : 'tool'
      );
      if (
        item.kind === 'assistant_message' &&
        (latestMessage === null || isLatest) &&
        typeof payload.text === 'string' &&
        payload.text.trim()
      ) {
        if (latestMessage === null) {
          const text = clip(payload.text, 300);
          latestMessage = {
            text: text.text,
            state: item.status,
            at,
            runId: item.runId,
            truncated: text.truncated
          };
        }
        if (isLatest) {
          const summary = clip(payload.text, 100);
          latestActivity = {
            state: item.status,
            at,
            runId: item.runId,
            kind: 'message',
            name: 'assistant',
            summary: summary.text,
            truncated: summary.truncated
          };
        }
      }
      if (!['tool_call', 'command_execution', 'file_change'].includes(item.kind)) continue;
      const presentation = isPlainRecord(payload.toolPresentation) ? payload.toolPresentation : {};
      if (
        run?.status === 'RUNNING' &&
        item.status === 'IN_PROGRESS' &&
        presentation.kind === 'SLEEP' &&
        typeof presentation.startedAt === 'string'
      )
        sleeping = true;
      if (recentTools.length === 3 && !isLatest) continue;
      const tool = projectTool(item, payload, presentation);
      if (recentTools.length < 3) recentTools.push(tool);
      if (isLatest) latestActivity = { ...tool, kind: 'tool' };
    }
  }
  return {
    status:
      run === undefined
        ? ('IDLE' as const)
        : sleeping
          ? ('SLEEPING' as const)
          : ('RUNNING' as const),
    runId: run?.id ?? null,
    latestActivity,
    latestMessage,
    recentTools,
    observedAt: Math.max(latestActivity?.at ?? 0, run?.updatedAt ?? 0) || null
  };
}

export function marctlSessionProgress(runtime: NodeRuntimeState, sessionId: string) {
  const { latestActivity: _latest, ...progress } = activity(runtime, sessionId);
  return { ...progress, ...pendingApprovals(runtime, sessionId) };
}

/** Summarizes current approval facts without exposing tool input or native payloads. */
function pendingApprovals(runtime: NodeRuntimeState, sessionId: string) {
  const run = runtime.activeSessionRun(sessionId);
  const executionId = run && runtime.currentExecutionId(run.id);
  const approvals =
    run && !isTerminalRunStatus(run.status)
      ? runtime
          .listApprovals(run.id)
          .filter(
            (approval) =>
              approval.status === 'PENDING' &&
              (approval.runId === run.id || approval.runId === executionId)
          )
      : [];
  return {
    pendingApprovals: approvals.slice(0, 20).map((approval) => {
      const payload = isPlainRecord(approval.payload) ? approval.payload : {};
      const name = clip(typeof payload.toolName === 'string' ? payload.toolName : 'Approval', 128);
      const summary = clip(
        typeof payload.reason === 'string' ? payload.reason : 'Approval required',
        100
      );
      return {
        runId: run!.id,
        approvalId: approval.id,
        name: name.text,
        summary: summary.text,
        truncated: name.truncated || summary.truncated
      };
    }),
    pendingApprovalsTruncated: approvals.length > 20
  };
}

function identity(session: NodeAgentSession) {
  return {
    id: session.id,
    title: session.customTitle ?? session.runnerTitle ?? 'Untitled session',
    runner: session.runner
  };
}

export function marctlSessionSummary(runtime: NodeRuntimeState, session: NodeAgentSession) {
  const { status, runId, latestActivity } = activity(runtime, session.id);
  if (latestActivity === null) return { ...identity(session), status, runId, latestActivity: null };
  const { runId: _activityRun, ...value } = latestActivity;
  return { ...identity(session), status, runId, latestActivity: value };
}

export function marctlSessionDetail(
  runtime: NodeRuntimeState,
  session: NodeAgentSession,
  queuedCount: number
) {
  const { status, runId, latestMessage, recentTools } = activity(runtime, session.id);
  return {
    ...identity(session),
    status,
    runId,
    model: session.model,
    effort: session.effort,
    queuedCount,
    latestMessage,
    recentTools,
    ...pendingApprovals(runtime, session.id)
  };
}

function time(item: NodeConversationItem): number | null {
  return item.updatedAt ?? item.completedAt ?? item.startedAt;
}

function isNewerActivity(
  current: LatestActivity | null,
  at: number | null,
  kind: LatestActivity['kind']
): boolean {
  return (
    current === null ||
    (at ?? 0) > (current.at ?? 0) ||
    (at === current.at && kind === 'tool' && current.kind !== 'tool')
  );
}

function projectTool(
  item: NodeConversationItem,
  payload: Record<string, unknown>,
  presentation: Record<string, unknown>
): PublicActivity {
  const name = clip(typeof payload.toolName === 'string' ? payload.toolName : item.kind, 128);
  let summary = '';
  if (presentation.kind === 'SLEEP') {
    summary =
      typeof presentation.elapsedMs === 'number'
        ? 'Slept for ' +
          presentation.elapsedMs +
          ' ms' +
          (typeof presentation.wakeReason === 'string'
            ? '; wake reason: ' + presentation.wakeReason
            : '')
        : typeof presentation.durationMs === 'number'
          ? 'Sleep for up to ' + presentation.durationMs + ' ms'
          : 'Sleep';
  } else if (item.kind === 'command_execution') {
    summary =
      typeof payload.title === 'string'
        ? payload.title
        : typeof payload.command === 'string'
          ? payload.command
          : '';
    if (typeof payload.exitCode === 'number') summary += '; exit code ' + payload.exitCode;
  } else if (item.kind === 'file_change' && Array.isArray(payload.changes)) {
    summary = payload.changes
      .filter(isPlainRecord)
      .map((change) => (typeof change.path === 'string' ? change.path : ''))
      .join(', ');
  } else {
    summary = [
      item.status === 'IN_PROGRESS' ? payload.progressLabel : undefined,
      payload.title ?? payload.toolName,
      payload.errorCode
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' · ');
  }
  const bounded = clip(summary.replace(/\s+/gu, ' ').trim(), 100);
  return {
    name: name.text,
    state: item.status,
    summary: bounded.text,
    at: time(item),
    runId: item.runId,
    truncated: name.truncated || bounded.truncated || payload.truncated === true
  };
}

function clip(value: string, limit: number): { text: string; truncated: boolean } {
  const chars: string[] = [];
  for (const char of value) {
    if (chars.length === limit) return { text: chars.join(''), truncated: true };
    chars.push(char);
  }
  return { text: chars.join(''), truncated: false };
}
