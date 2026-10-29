import type { AgentEvent } from '@myagentroam/agent';

/** A bounded projection of one execution's public events, not an execution owner. */
export type ChildSnapshot = {
  summary?: string;
  summaryTruncated?: boolean;
  turnId?: string;
  changedFiles: string[];
  changedFilesTruncated?: boolean;
  latestMessage?: {
    itemId: string;
    turnId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
    timestamp: string;
    truncated: boolean;
  };
  latestActivity?:
    | { kind: 'message'; timestamp: string; phase: 'commentary' | 'final_answer' }
    | {
        kind: 'tool';
        timestamp: string;
        toolName: string;
        status: 'started' | 'completed' | 'failed';
      };
  verification?: string[];
  evidence?: Array<{ path: string; startLine?: number; endLine?: number }>;
};

export function boundedUtf8(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

export function projectChildEvent(snapshot: ChildSnapshot, event: AgentEvent, full = false): void {
  if (event.type === 'execution.failed' || event.type === 'execution.cancelled') {
    delete snapshot.summary;
    delete snapshot.summaryTruncated;
  }
  if (full && event.type === 'message.completed') {
    snapshot.latestMessage = {
      itemId: event.itemId,
      turnId: event.turnId ?? '',
      phase: event.phase,
      text: event.text,
      timestamp: event.timestamp,
      truncated: false
    };
    snapshot.latestActivity = { kind: 'message', timestamp: event.timestamp, phase: event.phase };
  } else if (
    full &&
    (event.type === 'tool.started' ||
      event.type === 'tool.completed' ||
      event.type === 'tool.failed')
  ) {
    snapshot.latestActivity = {
      kind: 'tool',
      timestamp: event.timestamp,
      toolName: event.toolName,
      status:
        event.type === 'tool.started'
          ? 'started'
          : event.type === 'tool.completed'
            ? 'completed'
            : 'failed'
    };
    if (event.type === 'tool.completed' && event.toolName === 'exec') {
      (snapshot.verification ??= []).push(event.summary);
    } else if (
      event.type === 'tool.completed' &&
      event.toolName === 'read' &&
      event.data &&
      'results' in event.data &&
      Array.isArray(event.data.results)
    ) {
      for (const result of event.data.results) {
        if (
          !result ||
          typeof result !== 'object' ||
          typeof result.path !== 'string' ||
          result.error !== undefined
        )
          continue;
        const positive = (value: unknown): value is number =>
          typeof value === 'number' && Number.isInteger(value) && value >= 1;
        const evidence = {
          path: result.path,
          ...(positive(result.startLine) ? { startLine: result.startLine } : {}),
          ...(positive(result.endLine) ? { endLine: result.endLine } : {})
        };
        const entries = (snapshot.evidence ??= []);
        if (
          !entries.some(
            (item) =>
              item.path === evidence.path &&
              item.startLine === evidence.startLine &&
              item.endLine === evidence.endLine
          )
        )
          entries.push(evidence);
      }
    }
  }
  if (event.type === 'message.completed' && event.phase === 'final_answer') {
    const summary = full
      ? { value: event.text, truncated: false }
      : boundedUtf8(event.text, 16_384);
    snapshot.summary = summary.value;
    if (summary.truncated) snapshot.summaryTruncated = true;
    else delete snapshot.summaryTruncated;
    if (event.turnId) snapshot.turnId = event.turnId;
    else delete snapshot.turnId;
  }
  if (
    event.type !== 'tool.completed' ||
    event.toolName !== 'apply_patch' ||
    !event.data ||
    !('files' in event.data) ||
    !Array.isArray(event.data.files)
  )
    return;
  for (const file of event.data.files) {
    if (typeof file !== 'object' || file === null) continue;
    for (const candidate of [
      (file as { path?: unknown }).path,
      (file as { targetPath?: unknown }).targetPath
    ]) {
      if (typeof candidate !== 'string' || !candidate || snapshot.changedFiles.includes(candidate))
        continue;
      if (!full && snapshot.changedFiles.length >= 200) {
        snapshot.changedFilesTruncated = true;
        continue;
      }
      snapshot.changedFiles.push(candidate);
    }
  }
}

export function publicChildSnapshot(snapshot: ChildSnapshot | undefined) {
  if (!snapshot) return {};
  return {
    ...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
    ...(snapshot.summaryTruncated ? { summaryTruncated: true } : {}),
    ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
    ...(snapshot.changedFiles.length ? { changedFiles: [...snapshot.changedFiles] } : {}),
    ...(snapshot.changedFilesTruncated ? { changedFilesTruncated: true } : {})
  };
}

/** Full native details are never included in model-facing projections. */
export function nativeChildSnapshot(snapshot: ChildSnapshot | undefined) {
  return {
    ...publicChildSnapshot(snapshot),
    ...(snapshot?.latestMessage ? { latestMessage: { ...snapshot.latestMessage } } : {}),
    ...(snapshot?.latestActivity ? { latestActivity: { ...snapshot.latestActivity } } : {}),
    ...(snapshot?.verification?.length ? { verification: [...snapshot.verification] } : {}),
    ...(snapshot?.evidence?.length
      ? { evidence: snapshot.evidence.map((item) => ({ ...item })) }
      : {})
  };
}
