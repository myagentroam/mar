import { MarctlError } from './errors.mjs';
import { decodeTerminalMessage } from '@myagentroam/protocol/byte-frame';

const MAX_INPUT_BYTES = 65536;

export function parseFrame(raw, isBinary, terminalId, translate) {
  if (!isBinary) throw new MarctlError(translate('errors.terminalBinaryFrame'));
  let frame;
  try {
    frame = decodeTerminalMessage(raw);
  } catch {
    throw new MarctlError(translate('errors.terminalFrameInvalid'));
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
      !(frame.data instanceof Uint8Array) ||
      frame.data.byteLength > MAX_INPUT_BYTES ||
      (frame.stream !== undefined && frame.stream !== 'stderr')
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
