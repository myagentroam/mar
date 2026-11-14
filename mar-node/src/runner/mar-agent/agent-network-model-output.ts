import { isPlainRecord } from '../../util/records.js';

function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])
  );
}

/** Model receipts expose actionable outcomes, not the Node audit or execution identities. */
function receipt(input: unknown): Record<string, unknown> {
  if (!isPlainRecord(input)) return {};
  const result = pick(input, [
    'status',
    'code',
    'delivery',
    'idempotent',
    'cleared',
    'goalAccessChanged',
    'approvalId',
    'decision'
  ]);
  const execution = isPlainRecord(input.run)
    ? input.run
    : isPlainRecord(input.turn)
      ? input.turn
      : undefined;
  if (execution?.status !== undefined) result.executionStatus = execution.status;
  if (isPlainRecord(input.goal)) result.goal = pick(input.goal, ['status']);
  if (isPlainRecord(input.goalExit)) result.goalExit = pick(input.goalExit, ['status']);
  return result;
}

function operation(input: unknown): unknown {
  if (!isPlainRecord(input)) return input;
  return {
    ...receipt(input.result),
    ...pick(input, ['status', 'code']),
    ...(input.current === null
      ? { current: null }
      : isPlainRecord(input.current)
        ? { current: pick(input.current, ['objective', 'status']) }
        : {})
  };
}

function prefix(value: string, bytes: number): string {
  const input = Buffer.from(value, 'utf8');
  let end = Math.min(bytes, input.length);
  while (end > 0 && end < input.length && (input[end]! & 0xc0) === 0x80) end--;
  return input.subarray(0, end).toString('utf8');
}

function projectAgent(
  input: Record<string, unknown>,
  maximumBytes: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...pick(input, [
      'agentId',
      'status',
      'waitOutcome',
      'summary',
      'summaryTruncated',
      'changedFilesTruncated',
      'errorCode',
      'errorMessage'
    ]),
    ...(Array.isArray(input.changedFiles) ? { changedFiles: [...input.changedFiles] } : {}),
    ...(Array.isArray(input.updates)
      ? {
          updates: input.updates.map((item) =>
            isPlainRecord(item) ? pick(item, ['kind', 'value', 'truncated', 'final']) : item
          )
        }
      : {})
  };
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  while (
    size() > maximumBytes &&
    Array.isArray(result.changedFiles) &&
    result.changedFiles.length
  ) {
    result.changedFiles.pop();
    result.changedFilesTruncated = true;
  }
  const shorten = (target: Record<string, unknown>, field: string, flag: string) => {
    if (size() <= maximumBytes || typeof target[field] !== 'string') return;
    const value = target[field] as string;
    let low = 0;
    let high = Buffer.byteLength(value, 'utf8');
    target[flag] = true;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      target[field] = prefix(value, middle);
      if (size() <= maximumBytes) low = middle;
      else high = middle - 1;
    }
    target[field] = prefix(value, low);
  };
  shorten(result, 'summary', 'summaryTruncated');
  if (Array.isArray(result.updates))
    for (const update of result.updates)
      if (isPlainRecord(update)) shorten(update, 'value', 'truncated');
  if (size() <= maximumBytes) return result;
  return {
    ...pick(input, ['agentId', 'status', 'waitOutcome', 'errorCode', 'errorMessage']),
    detailsTruncated: true
  };
}

/** One model contract for direct text and Code Mode data; domain and UI receipts stay separate. */
export function agentNetworkModelOutput(action: string, input: unknown): unknown {
  if (!isPlainRecord(input)) return input;
  if (action === 'wait') {
    const agents = Array.isArray(input.agents) ? input.agents : [input];
    const budget = Math.floor(34_000 / Math.max(1, agents.length));
    return {
      ...pick(input, ['mode', 'waitFor', 'waitOutcome', 'reason', 'pendingAgentIds']),
      agents: agents.map((item) => (isPlainRecord(item) ? projectAgent(item, budget) : item))
    };
  }
  if (!['start', 'send', 'stop'].includes(action)) return input;
  const result = pick(input, ['agentId']);
  if (input.start !== undefined) result.start = receipt(input.start);
  for (const field of ['message', 'goal', 'approval', 'cancel', 'observation'])
    if (input[field] !== undefined) result[field] = operation(input[field]);
  return result;
}
