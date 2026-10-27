import { AgentError } from '../../../error.js';
import { inputImageReference } from './images.js';
import type { SessionRecord } from '../types.js';

type LogicalSessionRecord = SessionRecord;

/** Decode one complete JSONL record using the encoding selected by the Session index. */
export function decodeJsonlRecord(line: string, encoding: number): LogicalSessionRecord {
  assertEncoding(encoding);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session record is corrupt.', { cause });
  }
  return decodeJsonlValue(value, encoding);
}

/** Decode an already-parsed line without repeating JSON parsing. */
export function decodeJsonlValue(value: unknown, encoding: number): LogicalSessionRecord {
  assertEncoding(encoding);
  return decodeRecord(value, encoding);
}

/** Encode one v2 record without a line delimiter; the segment writer owns framing. */
export function encodeJsonlRecord(record: LogicalSessionRecord, encoding: number): string {
  assertEncoding(encoding);
  if (encoding !== 2) throw unsupportedEncoding();
  let line: string | undefined;
  try {
    line = JSON.stringify(normalizeJsonlRecord(record));
  } catch (cause) {
    throw new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session record is not serializable.', {
      cause
    });
  }
  if (line === undefined) throw corruptRecord();
  return line;
}

/** Normalize known physical image references without examining unrelated payload fields. */
export function normalizeJsonlRecord(record: LogicalSessionRecord): LogicalSessionRecord {
  return decodeRecord(record, 2);
}

function decodeRecord(value: unknown, encoding: number): LogicalSessionRecord {
  if (!isObject(value)) throw corruptRecord();
  if (isObject(value.payload)) {
    const payload = value.payload;
    if (value.type === 'context.gc.completed') {
      rejectFuture(payload.version, 1);
      if (isObject(payload.inlineMedia) && isObject(payload.inlineMedia.state))
        rejectFuture(payload.inlineMedia.state.version, 1);
    } else if (value.type === 'resource.window') {
      rejectFuture(payload.version, 1);
    } else if (value.type === 'compact.completed' && isObject(payload.inlineMediaState)) {
      rejectFuture(payload.inlineMediaState.version, 1);
    }
  }
  const version = value.schemaVersion;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > 1)
    throw unsupportedEncoding();
  if ((encoding === 1 && version !== 1) || (encoding === 2 && 'schemaVersion' in value))
    throw corruptRecord();
  if (
    typeof value.recordId !== 'string' ||
    value.recordId.length === 0 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.timestamp !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    typeof value.type !== 'string' ||
    value.type.length === 0 ||
    !Object.hasOwn(value, 'payload') ||
    (value.executionId !== undefined && typeof value.executionId !== 'string') ||
    (value.turnId !== undefined && typeof value.turnId !== 'string')
  )
    throw corruptRecord();

  const { schemaVersion: _version, ...record } = value;
  record.payload = decodePayload(value.type, value.payload, encoding);
  return record as unknown as LogicalSessionRecord;
}

function rejectFuture(version: unknown, current: number): void {
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > current)
    throw unsupportedEncoding();
}

function decodePayload(type: string, payload: unknown, encoding: number): unknown {
  if (!isObject(payload)) return payload;
  if (type === 'turn.user' || type === 'extension.input' || type === 'model.context')
    return decodeImageField(payload, encoding);
  if (type !== 'compact.completed') return payload;
  return {
    ...payload,
    ...(Array.isArray(payload.pendingInputs)
      ? { pendingInputs: payload.pendingInputs.map((record) => decodeRecord(record, encoding)) }
      : {}),
    ...(Array.isArray(payload.retainedModelContext)
      ? {
          retainedModelContext: payload.retainedModelContext.map((message) =>
            isObject(message) ? decodeImageField(message, encoding) : message
          )
        }
      : {})
  };
}

function decodeImageField(
  payload: Record<string, unknown>,
  _encoding: number
): Record<string, unknown> {
  if (!Array.isArray(payload.images)) return payload;
  return {
    ...payload,
    images: payload.images.map((image: unknown) => {
      if (
        isObject(image) &&
        typeof image.resourceInputVersion === 'number' &&
        Number.isSafeInteger(image.resourceInputVersion) &&
        image.resourceInputVersion > 1
      )
        throw unsupportedEncoding();
      // Older unsupported image formats and already-logical image references remain untouched.
      if (!isObject(image) || image.resourceInputVersion !== 1 || !Object.hasOwn(image, 'fileName'))
        return image;
      const reference = inputImageReference(image);
      if (!reference?.resourceId) throw corruptRecord();
      const { fileName: _fileName, ...logical } = image;
      return logical;
    })
  };
}

function assertEncoding(encoding: number): void {
  if (encoding !== 1 && encoding !== 2) throw unsupportedEncoding();
}

function unsupportedEncoding(): AgentError {
  return new AgentError(
    'MAR_AGENT_SESSION_VERSION_UNSUPPORTED',
    'Session encoding is unsupported.'
  );
}

function corruptRecord(): AgentError {
  return new AgentError('MAR_AGENT_SESSION_CORRUPT', 'Session record is corrupt.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
