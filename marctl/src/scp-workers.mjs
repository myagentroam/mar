import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { MarctlError } from './errors.mjs';
import { DirectRejectedError } from './direct-errors.mjs';
import { runTerminalSession } from './terminal.mjs';
import { parseFrame } from './terminal-frame.mjs';
import { ByteChannel } from './scp-channel.mjs';

const script = gzipSync(readFileSync(new URL('./scp-worker.cjs', import.meta.url))).toString(
  'base64'
);
const expression = `eval(require('zlib').gunzipSync(Buffer.from('${script}','base64')).toString())`;

function workerArguments(mode, file, size, metadata, preserve, sourceBasename) {
  const encoded = Buffer.from(file, 'utf8').toString('base64url');
  return [
    mode,
    encoded,
    ...(size === undefined
      ? []
      : [
          String(size),
          metadata.toString('base64url'),
          preserve ? '1' : '0',
          Buffer.from(sourceBasename, 'utf8').toString('base64url')
        ])
  ];
}

function workerCommand(mode, file, size, metadata, preserve, sourceBasename) {
  return `node -e "${expression}" ${workerArguments(mode, file, size, metadata, preserve, sourceBasename).join(' ')}`;
}

async function withLocalWorker(
  mode,
  file,
  size,
  metadata,
  preserve,
  sourceBasename,
  use,
  controller
) {
  const child = spawn(
    process.execPath,
    ['-e', expression, ...workerArguments(mode, file, size, metadata, preserve, sourceBasename)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
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
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

async function withRemoteWorker(
  {
    client,
    WebSocketClass,
    nodeId,
    file,
    mode,
    size,
    metadata,
    preserve,
    sourceBasename,
    translate,
    controller
  },
  use
) {
  return runTerminalSession({
    client,
    WebSocketClass,
    nodeId,
    command: workerCommand(mode, file, size, metadata, preserve, sourceBasename),
    binary: true,
    raceConnections: true,
    signal: controller.signal,
    translate,
    attached: async ({ transport, terminalId }) => {
      const channel = new ByteChannel(
        (bytes) =>
          transport.send(
            JSON.stringify({ type: 'input', terminalId, data: bytes.toString('base64') })
          ),
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
            const bytes = Buffer.from(frame.data, 'base64');
            if (bytes.toString('base64') !== frame.data)
              throw new MarctlError('Copy output is not valid base64.');
            channel.feed(bytes);
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
  if (endpoint.nodeId === undefined)
    return withLocalWorker(
      mode,
      endpoint.path,
      size,
      metadata,
      context.preserve,
      context.sourceBasename,
      use,
      context.controller
    );
  return withRemoteWorker(
    {
      ...context,
      nodeId: endpoint.nodeId,
      file: endpoint.path,
      mode,
      size,
      metadata
    },
    use
  );
}
