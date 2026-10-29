import { boundedUtf8 } from './snapshot.js';

type WaitAgent = {
  agentId: string;
  executionId?: string;
  status: string;
  waitOutcome: string;
  summary?: string;
  summaryTruncated?: boolean;
  changedFiles?: string[];
  changedFilesTruncated?: boolean;
  updates?: Array<{ value: string; truncated?: boolean }>;
};

/** Keep the model's JSON parseable without modifying the native result. */
export function modelWaitAgent<T extends WaitAgent>(
  agent: T,
  maximumBytes: number
): T & {
  detailsTruncated?: boolean;
} {
  const result = {
    ...agent,
    ...(agent.changedFiles ? { changedFiles: [...agent.changedFiles] } : {}),
    ...(agent.updates ? { updates: agent.updates.map((update) => ({ ...update })) } : {})
  };
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  while (size() > maximumBytes && result.changedFiles?.length) {
    result.changedFiles.pop();
    result.changedFilesTruncated = true;
  }
  if (size() > maximumBytes && result.summary !== undefined) {
    const summary = result.summary;
    let low = 0;
    let high = Buffer.byteLength(summary, 'utf8');
    result.summaryTruncated = true;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      result.summary = boundedUtf8(summary, middle).value;
      if (size() <= maximumBytes) low = middle;
      else high = middle - 1;
    }
    result.summary = boundedUtf8(summary, low).value;
  }
  for (const update of result.updates ?? []) {
    if (size() <= maximumBytes) break;
    const value = update.value;
    let low = 0;
    let high = Buffer.byteLength(value, 'utf8');
    update.truncated = true;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      update.value = boundedUtf8(value, middle).value;
      if (size() <= maximumBytes) low = middle;
      else high = middle - 1;
    }
    update.value = boundedUtf8(value, low).value;
  }
  if (size() <= maximumBytes) return result;
  // Preserve the identity and outcome even if unusual metadata itself exceeds the budget.
  return {
    agentId: agent.agentId,
    ...(agent.executionId ? { executionId: agent.executionId } : {}),
    status: agent.status,
    waitOutcome: agent.waitOutcome,
    detailsTruncated: true
  } as T & {
    detailsTruncated: boolean;
  };
}
