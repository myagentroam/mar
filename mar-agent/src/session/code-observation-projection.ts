import type { ModelImage } from '../model/image.js';
import type { CodeToolCallRecord, CodeObservation } from './code-observation-contract.js';
export type { CodeToolCallRecord, CodeObservation } from './code-observation-contract.js';

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
  images: readonly ModelImage[],
  offset = 0
) {
  const selected: ModelImage[] = [];
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

export function visibleObservationText(value: CodeObservation): string {
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

export function observationModelParts(message: {
  content?: string;
  textBlocks?: readonly { readonly text: string }[];
  observations?: readonly CodeObservation[];
  images?: readonly import('../model/image.js').ModelImage[];
}):
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: import('../model/image.js').ModelImage }
    >
  | undefined {
  if (message.textBlocks !== undefined || message.observations === undefined) return undefined;
  const prefix: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: import('../model/image.js').ModelImage }
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
        | { type: 'image'; image: import('../model/image.js').ModelImage }
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
