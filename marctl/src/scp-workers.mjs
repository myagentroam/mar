import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminalCopySchema } from '@myagentroam/protocol';
import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { runTerminalSession } from './terminal.mjs';
import { parseFrame } from './terminal-frame.mjs';
import { ByteChannel } from './scp-channel.mjs';
import { closeScpWorker } from './scp-worker-close.mjs';

const workerPath = fileURLToPath(new URL('./scp-worker.cjs', import.meta.url));

async function withLocalWorker(copy, use, controller) {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(copy)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  const channel = new ByteChannel(
    (bytes) =>
      new Promise((resolve, reject) => {
        child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
    controller
  );
  child.stdout.on('data', (bytes) => channel.feed(bytes));
  child.once('error', (error) => channel.fail(error));
  const closed = new Promise((resolve) => {
    child.once('close', (code) => {
      channel.finish(code ?? 1);
      resolve();
    });
  });
  try {
    return await use(channel);
  } finally {
    await closeScpWorker(child, closed);
  }
}

async function withRemoteWorker({ client, nodeId, copy, translate, controller }, use) {
  return runTerminalSession({
    client,
    nodeId,
    copy,
    signal: controller.signal,
    translate,
    attached: async ({ transport, terminalId }) => {
      const channel = new ByteChannel(
        (bytes) => transport.send({ type: 'input', terminalId, data: bytes }),
        controller
      );
      let sequence = 0;
      const onMessage = (raw, isBinary) => {
        try {
          const frame = parseFrame(raw, isBinary, terminalId, translate);
          if (frame.type === 'output') {
            if (frame.sequence !== sequence + 1)
              throw new MarctlError('Copy output sequence is invalid.');
            sequence = frame.sequence;
            if (frame.stream !== 'stderr') channel.feed(Buffer.from(frame.data));
          } else if (frame.type === 'exit') channel.finish(frame.exitCode ?? 1);
          else if (frame.type === 'error')
            channel.fail(new MarctlError(translate('errors.terminalRemoteError')));
          else throw new MarctlError(translate('errors.terminalUnexpectedFrame'));
        } catch (error) {
          channel.fail(error);
        }
      };
      const onError = (error) =>
        channel.connectionEnded(
          error instanceof DirectRejectedError
            ? new MarctlError(`${translate('errors.terminalConnectionFailed')} [${error.code}]`, {
                code: error.code
              })
            : new MarctlError(translate('errors.terminalConnectionFailed'))
        );
      const onClose = () =>
        channel.connectionEnded(new MarctlError(translate('errors.terminalConnectionLost')));
      transport.on('message', onMessage);
      transport.on('error', onError);
      transport.on('close', onClose);
      try {
        transport.activate?.();
        return await use(channel);
      } finally {
        transport.removeListener?.('message', onMessage);
        transport.removeListener?.('error', onError);
        transport.removeListener?.('close', onClose);
      }
    }
  });
}

export async function withWorker(endpoint, mode, size, metadata, context, use) {
  const descriptor =
    mode === 'read'
      ? { mode, path: endpoint.path }
      : {
          mode,
          path: endpoint.path,
          size,
          sourceMode: metadata.readUInt32BE(0),
          atimeMs: metadata.readDoubleBE(4),
          mtimeMs: metadata.readDoubleBE(12),
          preserve: context.preserve,
          sourceBasename: context.sourceBasename
        };
  const parsed = terminalCopySchema.safeParse(descriptor);
  if (!parsed.success)
    throw new MarctlError(context.translate('errors.scpOpenInvalid'), { code: 'SCP_OPEN_INVALID' });
  const copy = parsed.data;
  if (endpoint.nodeId === undefined) return withLocalWorker(copy, use, context.controller);
  return withRemoteWorker({ ...context, nodeId: endpoint.nodeId, copy }, use);
}
