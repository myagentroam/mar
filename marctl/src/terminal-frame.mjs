import { MarctlError } from './errors.mjs';

const MAX_INPUT_BYTES = 65536;

export function parseFrame(raw, isBinary, terminalId, translate) {
  if (isBinary) throw new MarctlError(translate('errors.terminalBinaryFrame'));
  let frame;
  try {
    frame = JSON.parse(rawToString(raw));
  } catch {
    throw new MarctlError(translate('errors.terminalInvalidJson'));
  }
  if (frame === null || typeof frame !== 'object' || frame.terminalId !== terminalId)
    throw new MarctlError(translate('errors.terminalFrameInvalid'));

  if (frame.type === 'attach') {
    if (!Number.isSafeInteger(frame.afterSequence) || frame.afterSequence < 0)
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'output') {
    if (
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 1 ||
      typeof frame.data !== 'string' ||
      Buffer.byteLength(frame.data) > MAX_INPUT_BYTES
    )
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'exit') {
    if (frame.exitCode !== null && !Number.isSafeInteger(frame.exitCode))
      throw new MarctlError(translate('errors.terminalFrameInvalid'));
    return frame;
  }
  if (frame.type === 'error' && typeof frame.code === 'string' && frame.code.length > 0)
    return frame;
  throw new MarctlError(translate('errors.terminalFrameInvalid'));
}

function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw))
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw);
}
