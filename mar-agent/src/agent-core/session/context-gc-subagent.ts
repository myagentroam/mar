export type ContextGcSubagentToolName =
  'agent_start' | 'agent_wait' | 'agent_message' | 'agent_cancel';

export interface ContextGcSubagentSnapshot {
  readonly agentId: string;
  readonly description: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly modelId?: string;
  readonly modelName?: string;
  readonly reasoningEffort?: string;
  readonly latestMessage?: {
    readonly itemId: string;
    readonly turnId: string;
    readonly phase: 'commentary' | 'final_answer';
    readonly text: string;
    readonly timestamp: string;
    readonly truncated?: boolean;
  };
  readonly latestActivity?:
    | {
        readonly kind: 'message';
        readonly timestamp: string;
        readonly phase: 'commentary' | 'final_answer';
      }
    | {
        readonly kind: 'tool';
        readonly timestamp: string;
        readonly toolName: string;
        readonly status: 'started' | 'completed' | 'failed';
      };
  readonly summary?: string;
  readonly changedFiles?: readonly string[];
  readonly verification?: readonly string[];
  readonly evidence?: readonly {
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
  }[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly deliveryStatus?: 'accepted' | 'applied' | 'cancelled' | 'failed';
  readonly waitOutcome?: 'snapshot' | 'message' | 'completion' | 'timeout';
}

export function normalizeContextGcSubagentSnapshot(
  modelContent: unknown,
  completedPayload: unknown,
  toolName: ContextGcSubagentToolName
): ContextGcSubagentSnapshot | undefined {
  if (
    typeof modelContent !== 'string' ||
    !isRecord(completedPayload) ||
    completedPayload.type !== 'tool.completed' ||
    completedPayload.toolName !== toolName ||
    completedPayload.truncated === true
  )
    return undefined;
  const fromContent = parseContextGcSubagentSnapshot(modelContent);
  const fromData = parseContextGcSubagentSnapshot(completedPayload.data);
  return fromContent && fromData && stableJson(fromContent) === stableJson(fromData)
    ? fromContent
    : undefined;
}

export function contextGcCompletedSubagentTurnId(
  snapshot: ContextGcSubagentSnapshot
): string | undefined {
  if (
    snapshot.status !== 'completed' ||
    !isNonemptyString(snapshot.summary) ||
    (snapshot.deliveryStatus !== undefined && snapshot.deliveryStatus !== 'applied')
  )
    return undefined;
  if (snapshot.latestMessage === undefined)
    return isNonemptyString(snapshot.turnId) ? snapshot.turnId : undefined;
  if (snapshot.latestMessage.phase !== 'final_answer') return undefined;
  const turnId = snapshot.latestMessage.turnId;
  return snapshot.turnId === undefined || snapshot.turnId === turnId ? turnId : undefined;
}

export function contextGcSubagentSnapshotTurnId(
  snapshot: ContextGcSubagentSnapshot
): string | undefined {
  return snapshot.turnId ?? snapshot.latestMessage?.turnId;
}

export function contextGcSubagentNeedsRetainedPriorFinal(
  snapshot: ContextGcSubagentSnapshot
): boolean {
  return (
    snapshot.latestMessage?.phase === 'final_answer' &&
    snapshot.latestMessage.turnId !== contextGcSubagentSnapshotTurnId(snapshot)
  );
}

export function contextGcSubagentPriorFinalIsRetained(
  source: ContextGcSubagentSnapshot,
  retained: ContextGcSubagentSnapshot | undefined
): boolean {
  if (!contextGcSubagentNeedsRetainedPriorFinal(source)) return true;
  return (
    retained !== undefined &&
    retained.agentId === source.agentId &&
    retained.description === source.description &&
    contextGcCompletedSubagentTurnId(retained) === source.latestMessage!.turnId &&
    (stableJson(retained.latestMessage) === stableJson(source.latestMessage) ||
      (retained.latestMessage === undefined &&
        source.latestMessage!.truncated !== true &&
        retained.summary === source.latestMessage!.text))
  );
}

export function contextGcSubagentSnapshotIsSuperseded(
  source: ContextGcSubagentSnapshot,
  terminal: ContextGcSubagentSnapshot,
  retainedPriorFinal?: ContextGcSubagentSnapshot
): boolean {
  const terminalTurnId = contextGcCompletedSubagentTurnId(terminal);
  if (
    !terminalTurnId ||
    source.agentId !== terminal.agentId ||
    contextGcSubagentSnapshotTurnId(source) !== terminalTurnId ||
    source.description !== terminal.description ||
    !optionalStringMatches(source.modelId, terminal.modelId) ||
    !optionalStringMatches(source.modelName, terminal.modelName) ||
    !optionalStringMatches(source.reasoningEffort, terminal.reasoningEffort)
  )
    return false;
  if (source.status === 'completed') return stableJson(source) === stableJson(terminal);
  if (
    (source.status !== 'queued' && source.status !== 'running') ||
    source.errorCode !== undefined ||
    source.errorMessage !== undefined ||
    !optionalStringMatches(source.summary, terminal.summary) ||
    !contextGcSubagentPriorFinalIsRetained(source, retainedPriorFinal) ||
    (source.latestMessage?.phase === 'final_answer' &&
      source.latestMessage.turnId === contextGcSubagentSnapshotTurnId(source))
  )
    return false;
  if (
    source.messageId !== undefined &&
    ((source.deliveryStatus !== 'accepted' && source.deliveryStatus !== 'applied') ||
      terminal.messageId !== source.messageId ||
      terminal.turnId !== source.turnId ||
      terminal.deliveryStatus !== 'applied')
  )
    return false;
  return (
    stringArrayIsCovered(source.changedFiles, terminal.changedFiles) &&
    stringArrayIsCovered(source.verification, terminal.verification) &&
    evidenceIsCovered(source.evidence, terminal.evidence)
  );
}

export function contextGcSubagentSnapshotIsPreciselyCovered(
  source: ContextGcSubagentSnapshot,
  retained: ContextGcSubagentSnapshot
): boolean {
  if (
    retained.status !== 'cancelled' &&
    retained.status !== 'failed' &&
    retained.status !== 'interrupted'
  )
    return false;
  if (
    source.agentId !== retained.agentId ||
    source.description !== retained.description ||
    contextGcSubagentSnapshotTurnId(source) !== contextGcSubagentSnapshotTurnId(retained) ||
    !optionalStringMatches(source.modelId, retained.modelId) ||
    !optionalStringMatches(source.modelName, retained.modelName) ||
    !optionalStringMatches(source.reasoningEffort, retained.reasoningEffort) ||
    !optionalStringMatches(source.summary, retained.summary) ||
    !optionalStringMatches(source.errorCode, retained.errorCode) ||
    !optionalStringMatches(source.errorMessage, retained.errorMessage) ||
    !latestMessageIsCovered(source.latestMessage, retained.latestMessage) ||
    !latestActivityIsCovered(source.latestActivity, retained.latestActivity) ||
    !receiptIsCovered(source, retained) ||
    !stringArrayIsCovered(source.changedFiles, retained.changedFiles) ||
    !stringArrayIsCovered(source.verification, retained.verification) ||
    !evidenceIsCovered(source.evidence, retained.evidence)
  )
    return false;
  return (
    source.status === retained.status || source.status === 'queued' || source.status === 'running'
  );
}

export function contextGcSubagentOutputReplacement(input: {
  readonly sourceContent: string;
  readonly source: ContextGcSubagentSnapshot;
  readonly terminal: ContextGcSubagentSnapshot;
}): string {
  const latestMessage = input.source.latestMessage;
  return JSON.stringify({
    agentId: input.source.agentId,
    description: input.source.description,
    status: input.source.status,
    ...(input.source.modelId === undefined ? {} : { modelId: input.source.modelId }),
    ...(input.source.modelName === undefined ? {} : { modelName: input.source.modelName }),
    ...(input.source.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: input.source.reasoningEffort }),
    ...(input.source.messageId === undefined ? {} : { messageId: input.source.messageId }),
    ...(input.source.turnId === undefined ? {} : { turnId: input.source.turnId }),
    ...(input.source.deliveryStatus === undefined
      ? {}
      : { deliveryStatus: input.source.deliveryStatus }),
    ...(input.source.waitOutcome === undefined ? {} : { waitOutcome: input.source.waitOutcome }),
    ...(latestMessage === undefined
      ? {}
      : {
          latestMessage: {
            turnId: latestMessage.turnId,
            phase: latestMessage.phase,
            timestamp: latestMessage.timestamp,
            ...(latestMessage.truncated === undefined
              ? {}
              : { truncated: latestMessage.truncated }),
            textBytes: Buffer.byteLength(latestMessage.text)
          }
        }),
    ...(input.source.latestActivity === undefined
      ? {}
      : { latestActivity: input.source.latestActivity }),
    contextGc: {
      kind: 'superseded_subagent_snapshot',
      formatVersion: 2,
      originalBytes: Buffer.byteLength(input.sourceContent),
      terminalStatus: input.terminal.status,
      terminalTurnId:
        contextGcCompletedSubagentTurnId(input.terminal) ??
        contextGcSubagentSnapshotTurnId(input.terminal),
      note:
        input.terminal.status === 'completed'
          ? 'This intermediate child-agent snapshot was superseded by retained completed evidence; complete Turn results remain in retained completed snapshots.'
          : 'This duplicate child-agent snapshot was superseded by a retained non-completed terminal snapshot. Only fields exactly covered by the retained snapshot were reclaimed.'
    }
  });
}

function parseContextGcSubagentSnapshot(value: unknown): ContextGcSubagentSnapshot | undefined {
  let parsed = value;
  if (typeof value === 'string')
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some(
      (key) =>
        ![
          'agentId',
          'description',
          'status',
          'modelId',
          'modelName',
          'reasoningEffort',
          'latestMessage',
          'latestActivity',
          'summary',
          'changedFiles',
          'verification',
          'evidence',
          'errorCode',
          'errorMessage',
          'messageId',
          'turnId',
          'deliveryStatus',
          'waitOutcome'
        ].includes(key)
    ) ||
    !isNonemptyString(parsed.agentId) ||
    !isNonemptyString(parsed.description) ||
    (parsed.status !== 'queued' &&
      parsed.status !== 'running' &&
      parsed.status !== 'completed' &&
      parsed.status !== 'failed' &&
      parsed.status !== 'cancelled' &&
      parsed.status !== 'interrupted') ||
    !isOptionalNonemptyString(parsed.modelId) ||
    !isOptionalNonemptyString(parsed.modelName) ||
    !isOptionalNonemptyString(parsed.reasoningEffort) ||
    !isOptionalString(parsed.summary) ||
    !isOptionalString(parsed.errorCode) ||
    !isOptionalString(parsed.errorMessage) ||
    !isOptionalNonemptyString(parsed.messageId) ||
    !isOptionalNonemptyString(parsed.turnId) ||
    (parsed.deliveryStatus !== undefined &&
      parsed.deliveryStatus !== 'accepted' &&
      parsed.deliveryStatus !== 'applied' &&
      parsed.deliveryStatus !== 'cancelled' &&
      parsed.deliveryStatus !== 'failed') ||
    (parsed.waitOutcome !== undefined &&
      parsed.waitOutcome !== 'snapshot' &&
      parsed.waitOutcome !== 'message' &&
      parsed.waitOutcome !== 'completion' &&
      parsed.waitOutcome !== 'timeout') ||
    !isOptionalStringArray(parsed.changedFiles) ||
    !isOptionalStringArray(parsed.verification) ||
    !isOptionalSubagentEvidence(parsed.evidence)
  )
    return undefined;
  if (
    (parsed.messageId !== undefined || parsed.deliveryStatus !== undefined) &&
    (parsed.messageId === undefined ||
      parsed.turnId === undefined ||
      parsed.deliveryStatus === undefined)
  )
    return undefined;
  const latestMessage = parseContextGcSubagentLatestMessage(parsed.latestMessage);
  if (parsed.latestMessage !== undefined && !latestMessage) return undefined;
  const latestActivity = parseContextGcSubagentLatestActivity(parsed.latestActivity);
  if (parsed.latestActivity !== undefined && !latestActivity) return undefined;
  return {
    agentId: parsed.agentId,
    description: parsed.description,
    status: parsed.status,
    ...(typeof parsed.modelId === 'string' ? { modelId: parsed.modelId } : {}),
    ...(typeof parsed.modelName === 'string' ? { modelName: parsed.modelName } : {}),
    ...(typeof parsed.reasoningEffort === 'string'
      ? { reasoningEffort: parsed.reasoningEffort }
      : {}),
    ...(latestMessage ? { latestMessage } : {}),
    ...(latestActivity ? { latestActivity } : {}),
    ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    ...(Array.isArray(parsed.changedFiles) ? { changedFiles: [...parsed.changedFiles] } : {}),
    ...(Array.isArray(parsed.verification) ? { verification: [...parsed.verification] } : {}),
    ...(Array.isArray(parsed.evidence)
      ? { evidence: parsed.evidence.map((item) => ({ ...item })) }
      : {}),
    ...(typeof parsed.errorCode === 'string' ? { errorCode: parsed.errorCode } : {}),
    ...(typeof parsed.errorMessage === 'string' ? { errorMessage: parsed.errorMessage } : {}),
    ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
    ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
    ...(typeof parsed.deliveryStatus === 'string'
      ? {
          deliveryStatus: parsed.deliveryStatus as NonNullable<
            ContextGcSubagentSnapshot['deliveryStatus']
          >
        }
      : {}),
    ...(typeof parsed.waitOutcome === 'string'
      ? {
          waitOutcome: parsed.waitOutcome as NonNullable<ContextGcSubagentSnapshot['waitOutcome']>
        }
      : {})
  };
}

function parseContextGcSubagentLatestMessage(
  value: unknown
): ContextGcSubagentSnapshot['latestMessage'] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['itemId', 'turnId', 'phase', 'text', 'timestamp', 'truncated'].includes(key)
    ) ||
    !isNonemptyString(value.itemId) ||
    !isNonemptyString(value.turnId) ||
    (value.phase !== 'commentary' && value.phase !== 'final_answer') ||
    typeof value.text !== 'string' ||
    !isNonemptyString(value.timestamp) ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean')
  )
    return undefined;
  return {
    itemId: value.itemId,
    turnId: value.turnId,
    phase: value.phase,
    text: value.text,
    timestamp: value.timestamp,
    ...(typeof value.truncated === 'boolean' ? { truncated: value.truncated } : {})
  };
}

function parseContextGcSubagentLatestActivity(
  value: unknown
): ContextGcSubagentSnapshot['latestActivity'] | undefined {
  if (!isRecord(value) || !isNonemptyString(value.timestamp)) return undefined;
  if (
    value.kind === 'message' &&
    Object.keys(value).every((key) => ['kind', 'timestamp', 'phase'].includes(key)) &&
    (value.phase === 'commentary' || value.phase === 'final_answer')
  )
    return { kind: 'message', timestamp: value.timestamp, phase: value.phase };
  if (
    value.kind === 'tool' &&
    Object.keys(value).every((key) => ['kind', 'timestamp', 'toolName', 'status'].includes(key)) &&
    isNonemptyString(value.toolName) &&
    (value.status === 'started' || value.status === 'completed' || value.status === 'failed')
  )
    return {
      kind: 'tool',
      timestamp: value.timestamp,
      toolName: value.toolName,
      status: value.status
    };
  return undefined;
}

function isOptionalSubagentEvidence(
  value: unknown
): value is ContextGcSubagentSnapshot['evidence'] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          isRecord(item) &&
          Object.keys(item).every((key) => ['path', 'startLine', 'endLine'].includes(key)) &&
          isNonemptyString(item.path) &&
          (item.startLine === undefined || isPositiveInteger(item.startLine)) &&
          (item.endLine === undefined || isPositiveInteger(item.endLine))
      ))
  );
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonemptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonemptyString(value);
}

function optionalStringMatches(source: string | undefined, terminal: string | undefined): boolean {
  return source === undefined || source === terminal;
}

function latestMessageIsCovered(
  source: ContextGcSubagentSnapshot['latestMessage'],
  retained: ContextGcSubagentSnapshot['latestMessage']
): boolean {
  return (
    source === undefined || (retained !== undefined && stableJson(source) === stableJson(retained))
  );
}

function latestActivityIsCovered(
  source: ContextGcSubagentSnapshot['latestActivity'],
  retained: ContextGcSubagentSnapshot['latestActivity']
): boolean {
  return (
    source === undefined || (retained !== undefined && stableJson(source) === stableJson(retained))
  );
}

function receiptIsCovered(
  source: ContextGcSubagentSnapshot,
  retained: ContextGcSubagentSnapshot
): boolean {
  if (source.messageId === undefined) return true;
  return (
    source.messageId === retained.messageId &&
    source.turnId === retained.turnId &&
    source.deliveryStatus === retained.deliveryStatus
  );
}

function stringArrayIsCovered(
  source: readonly string[] | undefined,
  terminal: readonly string[] | undefined
): boolean {
  return source === undefined || source.every((item) => terminal?.includes(item) === true);
}

function evidenceIsCovered(
  source: ContextGcSubagentSnapshot['evidence'],
  terminal: ContextGcSubagentSnapshot['evidence']
): boolean {
  return (
    source === undefined ||
    source.every((item) =>
      terminal?.some((candidate) => stableJson(candidate) === stableJson(item))
    )
  );
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

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
