import { isPlainRecord } from '../../util/records.js';

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
    ...input,
    ...(Array.isArray(input.changedFiles) ? { changedFiles: [...input.changedFiles] } : {}),
    ...(Array.isArray(input.updates)
      ? { updates: input.updates.map((item) => (isPlainRecord(item) ? { ...item } : item)) }
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
    agentId: input.agentId,
    runId: input.runId,
    executionId: input.executionId,
    status: input.status,
    waitOutcome: input.waitOutcome,
    detailsTruncated: true
  };
}

/** Limit only the model-facing view; the Node use-case result remains unchanged. */
export function agentNetworkWaitModelOutput(input: unknown): unknown {
  if (!isPlainRecord(input)) return input;
  if (!Array.isArray(input.agents))
    return {
      ...projectAgent(input, 34_000),
      ...(typeof input.waitFor === 'string' ? { waitFor: input.waitFor } : {}),
      ...(typeof input.reason === 'string' ? { reason: input.reason } : {})
    };
  const budget = Math.floor(34_000 / Math.max(1, input.agents.length));
  return {
    ...input,
    agents: input.agents.map((item) => (isPlainRecord(item) ? projectAgent(item, budget) : item))
  };
}
