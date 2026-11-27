import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { parseFrame } from './terminal-frame.mjs';

const INPUT_CHUNK_BYTES = 32 * 1024;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

export function runAttachedTerminal({
  transport,
  terminalId,
  commandMode,
  stdin,
  stdout,
  stderr = process.stderr,
  signal,
  translate
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inputEnabled = false;
    let rawModeEnabled = false;
    let inputTasks = 0;
    let inputEnded = false;
    let eofSent = false;

    const cleanup = () => {
      transport.removeListener?.('message', onMessage);
      transport.removeListener?.('error', onError);
      transport.removeListener?.('close', onClose);
      stdin.removeListener?.('data', onInput);
      stdin.removeListener?.('end', onEnd);
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
      return transport.send(frame);
    };
    const sendEof = () => {
      if (commandMode && !settled && inputEnded && inputTasks === 0 && !eofSent) {
        eofSent = true;
        Promise.resolve()
          .then(() => send({ type: 'eof', terminalId }))
          .catch(() => fail('errors.terminalInputFailed'));
      }
    };
    const onEnd = () => {
      inputEnded = true;
      sendEof();
    };
    const onInput = async (data) => {
      inputTasks += 1;
      stdin.pause?.();
      try {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
          if (settled) return;
          await send({
            type: 'input',
            terminalId,
            data: bytes.subarray(offset, offset + INPUT_CHUNK_BYTES)
          });
        }
      } catch {
        fail('errors.terminalInputFailed');
      } finally {
        inputTasks -= 1;
        if (!settled && inputTasks === 0) stdin.resume?.();
        sendEof();
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
        if (frame.type === 'output') {
          const output = frame.stream === 'stderr' ? stderr : stdout;
          output.write(frame.data);
        } else if (frame.type === 'exit') {
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
        stdin.on?.('data', onInput);
        if (commandMode) {
          stdin.once?.('end', onEnd);
          if (stdin.readableEnded) onEnd();
        } else {
          stdout.on?.('resize', onResize);
          onResize();
        }
        stdin.resume?.();
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
    Promise.resolve(socket.send({ type: 'close', terminalId })).catch(() => {});
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
