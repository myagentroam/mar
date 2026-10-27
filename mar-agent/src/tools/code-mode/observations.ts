import { randomUUID } from 'node:crypto';
import { truncateModelText, countModelTokens } from '../../runtime/token-budget.js';
import type { CodeObservation } from '../../session/code-observation-contract.js';
import {
  observationContent,
  visibleObservationText,
  renderObservations
} from '../../session/code-observation-projection.js';

/** Truncate each body before encoding, never a JSON array or its trusted identity. */
export function boundObservations(values: readonly CodeObservation[], maximumTokens: number) {
  let remaining = Math.max(0, maximumTokens - 2);
  let truncated = false;
  const observations: CodeObservation[] = [];
  const selected: Array<{ original: CodeObservation; overhead: number }> = [];
  let overheadBudget = 0;
  for (const original of values) {
    const empty =
      original.type === 'tool_result'
        ? { ...original, result: { ...original.result, content: '', truncated: true } }
        : { ...original, value: '', truncated: true };
    const overhead = countModelTokens(visibleObservationText(empty)) + 8;
    if (overheadBudget + overhead > remaining) {
      truncated = true;
      break;
    }
    selected.push({ original, overhead });
    overheadBudget += overhead;
  }
  for (const { original, overhead } of selected) {
    let bodyBudget = Math.max(0, remaining - overheadBudget - 12);
    let value: CodeObservation;
    let bodyTruncated = false;
    for (;;) {
      const bounded = truncateModelText(observationContent(original), bodyBudget);
      bodyTruncated ||= bounded.truncated;
      value =
        original.type === 'tool_result'
          ? {
              ...original,
              result: {
                ...original.result,
                content: bounded.content,
                truncated: original.result.truncated === true || bodyTruncated
              }
            }
          : {
              ...original,
              value: bounded.content,
              truncated: original.truncated === true || bodyTruncated
            };
      if (
        countModelTokens(visibleObservationText(value)) + 1 <=
          remaining - (overheadBudget - overhead) ||
        bodyBudget === 0
      )
        break;
      bodyBudget = Math.floor(bodyBudget / 2);
    }
    overheadBudget -= overhead;
    observations.push(value);
    remaining -= countModelTokens(visibleObservationText(value)) + 1;
    truncated ||=
      bodyTruncated ||
      (original.type === 'tool_result'
        ? original.result.truncated === true
        : original.truncated === true);
  }
  return { observations, content: renderObservations(observations), truncated };
}

export function newObservationId(): string {
  return randomUUID();
}
