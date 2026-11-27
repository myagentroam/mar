import { encodeTerminalMessage } from '@myagentroam/protocol/byte-frame';
import { NodeStreamError } from '@myagentroam/protocol/node-stream';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';

/** Adapts a Terminal substream for the foreground IPC; owns no path or peer. */
export function terminalNodeStream(stream, { terminalId, onFrame, onEnd }, release = () => {}) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stream.close();
    release();
  };
  return {
    activate() {
      void (async () => {
        try {
          for await (const frame of readTerminalRecords(stream)) await onFrame(frame);
        } catch (error) {
          if (!closed && error instanceof NodeStreamError)
            await onFrame(encodeTerminalMessage({ type: 'error', terminalId, code: error.code }));
        } finally {
          if (!closed) {
            close();
            onEnd();
          }
        }
      })();
    },
    write: (frame) => stream.write(writeTerminalRecord(frame)),
    close
  };
}
