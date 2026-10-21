import { randomUUID } from 'node:crypto';
import { truncateModelText, countModelTokens } from '../../runtime/token-budget.js';

/** Execution metadata is independent of explicit model observations. */
export interface CodeToolCallRecord {
  callId: string;
  toolName: string;
  input: unknown;
  status: 'running' | 'completed' | 'failed';
  resultExtensions?: readonly import('../result-extensions.js').ToolResultExtension[];
  result?: { content: string; data?: unknown; truncated?: boolean };
  error?: { code: string; message: string };
}

export function parseCodeCalls(value: unknown): CodeToolCallRecord[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.callId !== 'string' ||
      !item.callId ||
      ids.has(item.callId) ||
      typeof item.toolName !== 'string' ||
      !['running', 'completed', 'failed'].includes(item.status)
    )
      return undefined;
    if (item.result !== undefined && (!item.result || typeof item.result.content !== 'string'))
      return undefined;
    ids.add(item.callId);
  }
  return value as CodeToolCallRecord[];
}

export type CodeObservation =
  | {
      type: 'tool_result';
      id: string;
      source: { callId: string; toolName: string; input: unknown };
      outcome: 'completed' | 'failed';
      result: { content: string; data?: unknown; truncated?: boolean; imageIndices?: number[] };
    }
  | {
      type: 'value';
      id: string;
      format: 'text' | 'json' | 'image';
      value: string;
      truncated?: boolean;
      imageIndices?: number[];
    };

export function observationContent(value: CodeObservation): string {
  return value.type === 'tool_result' ? value.result.content : value.value;
}

export function observationImages(value: CodeObservation): readonly number[] {
  return value.type === 'tool_result'
    ? (value.result.imageIndices ?? [])
    : (value.imageIndices ?? []);
}

export function selectObservationImages(
  values: readonly CodeObservation[],
  images: readonly { mimeType: string; dataBase64: string }[],
  offset = 0
) {
  const selected: { mimeType: string; dataBase64: string }[] = [];
  const indices = new Map<number, number>();
  const observations = values.map((value) => {
    const remap = observationImages(value).flatMap((index) => {
      const image = images[index - offset];
      if (!image) return [];
      let next = indices.get(index);
      if (next === undefined) {
        next = selected.length;
        indices.set(index, next);
        selected.push(image);
      }
      return [next];
    });
    return value.type === 'tool_result'
      ? { ...value, result: { ...value.result, imageIndices: remap } }
      : { ...value, imageIndices: remap };
  });
  return { observations, images: selected };
}

/** Only the visible projection crosses into model text; program data and inputs stay private. */
export function visibleObservation(value: CodeObservation): Record<string, unknown> {
  return value.type === 'tool_result'
    ? {
        type: value.type,
        toolName: value.source.toolName,
        outcome: value.outcome,
        content: value.result.content,
        ...(value.result.truncated ? { truncated: true } : {})
      }
    : {
        type: value.type,
        format: value.format,
        value: value.value,
        ...(value.truncated ? { truncated: true } : {})
      };
}

export function renderObservations(values: readonly CodeObservation[]): string {
  return JSON.stringify(values.map(visibleObservation));
}

function visibleObservationText(value: CodeObservation): string {
  const { content: _content, value: _value, ...header } = visibleObservation(value);
  const body = observationContent(value);
  return JSON.stringify(header) + (body.length ? `\n${body}` : '');
}

export function renderObservationResult(
  values: readonly CodeObservation[],
  original: string
): string {
  try {
    const envelope = JSON.parse(original);
    if (envelope && !Array.isArray(envelope) && typeof envelope === 'object')
      return JSON.stringify({ ...envelope, observations: values.map(visibleObservation) });
  } catch {
    // A non-JSON envelope falls back to the bounded observation rendering.
  }
  return renderObservations(values);
}

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

export function observationModelParts(message: {
  content?: string;
  textBlocks?: readonly { readonly text: string }[];
  observations?: readonly CodeObservation[];
  images?: readonly { mimeType: string; dataBase64: string }[];
}):
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: { mimeType: string; dataBase64: string } }
    >
  | undefined {
  if (message.textBlocks !== undefined || message.observations === undefined) return undefined;
  const prefix: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: { mimeType: string; dataBase64: string } }
  > = [];
  try {
    const parsed = JSON.parse(message.content ?? '');
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      const { observations: _observations, ...metadata } = parsed;
      const cellEnvelope =
        typeof metadata.cellId === 'string' &&
        typeof metadata.status === 'string' &&
        Array.isArray(_observations);
      if (!message.observations.length && !cellEnvelope) return undefined;
      if (cellEnvelope) {
        // Keep execution facts in storage; project only actionable lifecycle metadata.
        delete metadata.toolCalls;
        delete metadata.outputBytes;
        if (metadata.outputDroppedBytes === 0) delete metadata.outputDroppedBytes;
        if (metadata.truncated === false) delete metadata.truncated;
        if (metadata.cached === false) delete metadata.cached;
      }
      prefix.push({ type: 'text', text: JSON.stringify(metadata) });
    }
  } catch {
    // Malformed envelope metadata must not hide structured observations.
  }
  if (!message.observations.length && !prefix.length) return undefined;
  return [
    ...prefix,
    ...message.observations.flatMap((value) => {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; image: { mimeType: string; dataBase64: string } }
      > = [{ type: 'text', text: visibleObservationText(value) }];
      for (const index of observationImages(value)) {
        const image = message.images?.[index];
        if (image) parts.push({ type: 'image', image });
      }
      return parts;
    })
  ];
}

/** Uses the same visible text as both adapters, without pixels or private observation data. */
export function observationModelText(
  message: Parameters<typeof observationModelParts>[0]
): string | undefined {
  return observationModelParts(message)
    ?.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

export function parseObservations(value: unknown): CodeObservation[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return undefined;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || ids.has(item.id))
      return undefined;
    ids.add(item.id);
    if (item.type === 'tool_result') {
      if (
        !item.source ||
        typeof item.source.callId !== 'string' ||
        typeof item.source.toolName !== 'string' ||
        !['completed', 'failed'].includes(item.outcome) ||
        !item.result ||
        typeof item.result.content !== 'string'
      )
        return undefined;
    } else if (
      item.type !== 'value' ||
      !['text', 'json', 'image'].includes(item.format) ||
      typeof item.value !== 'string'
    )
      return undefined;
    const indices = item.type === 'tool_result' ? item.result.imageIndices : item.imageIndices;
    if (
      indices !== undefined &&
      (!Array.isArray(indices) ||
        indices.some((i: unknown) => !Number.isSafeInteger(i) || Number(i) < 0 || Number(i) >= 5))
    )
      return undefined;
  }
  return value as CodeObservation[];
}
