import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { parseFrame } from './terminal-frame.mjs';

const MAX_INPUT_BYTES = 65536;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

export function splitInput(text, maxBytes = MAX_INPUT_BYTES) {
  const value = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (chunk !== '' && chunkBytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    if (characterBytes > maxBytes) continue;
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

export function runAttachedTerminal({
  transport,
  terminalId,
  commandMode,
  stdin,
  stdout,
  signal,
  translate
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inputEnabled = false;
    let rawModeEnabled = false;
    let inputTasks = 0;

    const cleanup = () => {
      transport.removeListener?.('message', onMessage);
      transport.removeListener?.('error', onError);
      transport.removeListener?.('close', onClose);
      stdin.removeListener?.('data', onInput);
      stdout.removeListener?.('resize', onResize);
      signal?.removeEventListener('abort', onAbort);
      if (rawModeEnabled) {
        try {
          stdin.setRawMode(false);
        } catch {
          // The terminal may already be gone.
        }
      }
      stdin.pause?.();
    };

    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      sendCloseFrame(transport, terminalId);
      transport.close?.();
      if (error === undefined) resolve(exitCode);
      else reject(error);
    };
    const fail = (key) => finish(new MarctlError(translate(key)));
    const send = (frame) => {
      return transport.send(JSON.stringify(frame));
    };
    const onInput = async (data) => {
      inputTasks += 1;
      stdin.pause?.();
      try {
        for (const chunk of splitInput(data)) {
          if (settled) return;
          await send({ type: 'input', terminalId, data: chunk });
        }
      } catch {
        fail('errors.terminalInputFailed');
      } finally {
        inputTasks -= 1;
        if (!settled && inputTasks === 0) stdin.resume?.();
      }
    };
    const onResize = () => {
      try {
        const { rows, cols } = getDimensions(stdout);
        Promise.resolve(send({ type: 'resize', terminalId, rows, cols })).catch(() =>
          fail('errors.terminalResizeFailed')
        );
      } catch {
        fail('errors.terminalResizeFailed');
      }
    };
    const onMessage = (raw, isBinary) => {
      try {
        const frame = parseFrame(raw, isBinary, terminalId, translate);
        if (frame.type === 'output') stdout.write(frame.data);
        else if (frame.type === 'exit') {
          finish(undefined, frame.exitCode === null ? 1 : frame.exitCode);
        } else if (frame.type === 'error') fail('errors.terminalRemoteError');
        else fail('errors.terminalUnexpectedFrame');
      } catch (error) {
        finish(
          error instanceof MarctlError
            ? error
            : new MarctlError(translate('errors.terminalFrameInvalid'))
        );
      }
    };
    const onError = (error) =>
      finish(
        error instanceof DirectRejectedError
          ? new MarctlError(`${translate('errors.terminalConnectionFailed')} [${error.code}]`, {
              code: error.code
            })
          : new MarctlError(translate('errors.terminalConnectionFailed'))
      );
    const onClose = () => finish(new MarctlError(translate('errors.terminalConnectionLost')));
    const onAbort = () => finish(undefined, signal.reason === 'SIGTERM' ? 143 : 130);
    const startInput = () => {
      if (settled || inputEnabled) return;
      inputEnabled = true;
      try {
        if (!commandMode) {
          if (typeof stdin.setRawMode !== 'function') {
            fail('errors.terminalInteractiveRequired');
            return;
          }
          stdin.setRawMode(true);
          rawModeEnabled = true;
        }
        stdin.resume?.();
        stdin.on?.('data', onInput);
        stdout.on?.('resize', onResize);
        onResize();
      } catch {
        fail(commandMode ? 'errors.terminalSessionFailed' : 'errors.terminalInteractiveInit');
      }
    };
    transport.on?.('message', onMessage);
    transport.on?.('error', onError);
    transport.on?.('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    transport.activate?.();
    startInput();
  });
}

function sendCloseFrame(socket, terminalId) {
  if (!terminalId || !isSocketOpen(socket)) return;
  try {
    Promise.resolve(socket.send(JSON.stringify({ type: 'close', terminalId }))).catch(() => {});
  } catch {
    // The DELETE request below remains the authoritative cleanup path.
  }
}

function isSocketOpen(socket) {
  return socket.readyState === undefined || socket.readyState === 1;
}

export function getDimensions(stdout) {
  const rows = Number.isSafeInteger(stdout.rows) && stdout.rows > 0 ? stdout.rows : DEFAULT_ROWS;
  const cols =
    Number.isSafeInteger(stdout.columns) && stdout.columns > 0 ? stdout.columns : DEFAULT_COLS;
  return { rows: Math.min(rows, 1000), cols: Math.min(cols, 1000) };
}
