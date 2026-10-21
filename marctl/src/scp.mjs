import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { MarctlError } from './config.mjs';
import { parseFrame, runTerminalSession } from './terminal.mjs';

const CHUNK = 32 * 1024;
const WINDOW = 8;
const MAX_BUFFERED_BYTES = WINDOW * (CHUNK + 4) + 64;
const script = gzipSync(readFileSync(new URL('./scp-worker.cjs', import.meta.url))).toString(
  'base64'
);
const expression = `eval(require('zlib').gunzipSync(Buffer.from('${script}','base64')).toString())`;

export function parseScpEndpoint(value) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new MarctlError('Invalid copy endpoint.');
  const explicit = value.indexOf('://');
  const separator = explicit >= 0 ? explicit : value.indexOf(':');
  if (separator < 0 || (separator === 1 && /^[A-Za-z]:[\\/]/u.test(value))) {
    // Let the filesystem resolve dot components and symlink parents.
    return { path: path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}` };
  }
  const host = value.slice(0, separator);
  const file = value.slice(separator + (explicit >= 0 ? 3 : 1));
  if (!host || !file || (!file.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(file)))
    throw new MarctlError('Invalid Node file path.');
  return { host, path: file };
}

export function scpSourceBasename(value) {
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
  if (value.endsWith('/') || (windowsPath && value.endsWith('\\')))
    throw new MarctlError('Invalid source filename.');
  const sourcePath = windowsPath ? path.win32 : path.posix;
  const basename = sourcePath.basename(value);
  if (!basename || basename === '.' || basename === '..')
    throw new MarctlError('Invalid source filename.');
  return basename;
}

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

class ByteChannel {
  #buffer = Buffer.alloc(0);
  #waiting = [];
  #sending = new Map();
  #ended;
  #failure;
  #controller;

  constructor(send, controller) {
    this.#controller = controller;
    const signal = controller.signal;
    this.send = (bytes) => {
      if (this.#failure) throw this.#failure;
      if (this.#ended !== undefined) throw new MarctlError('Copy stream ended unexpectedly.');
      return new Promise((resolve, reject) => {
        this.#sending.set(reject, resolve);
        const settle = (complete, value) => {
          this.#sending.delete(reject);
          complete(value);
        };
        try {
          Promise.resolve(send(bytes)).then(
            (value) => settle(resolve, value),
            (error) => settle(reject, error)
          );
        } catch (error) {
          settle(reject, error);
        }
      });
    };
    if (signal) {
      if (signal.aborted) this.fail(signal.reason);
      else
        signal.addEventListener('abort', () => this.fail(signal.reason), {
          once: true
        });
    }
  }

  feed(bytes) {
    if (this.#failure) return;
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    if (this.#buffer.length > MAX_BUFFERED_BYTES)
      return this.fail(new MarctlError('Copy output exceeded the bounded window.'));
    this.#wake();
  }

  finish(code) {
    this.#ended = code;
    if (code !== 0) return this.fail(new MarctlError('Remote copy command failed.'));
    // A successful exit confirms the worker consumed its final protocol input.
    for (const resolve of this.#sending.values()) resolve();
    this.#sending.clear();
    this.#wake();
  }

  connectionEnded(error) {
    if (this.#ended === undefined) this.fail(error);
  }

  fail(error) {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    for (const reject of this.#sending.keys()) reject(this.#failure);
    this.#sending.clear();
    this.#wake();
    // Any endpoint failure must wake reads and writes across the entire copy.
    this.#controller.abort(error);
  }

  #wake() {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  async read(length) {
    if (this.#failure) throw this.#failure;
    while (this.#buffer.length < length) {
      if (this.#failure) throw this.#failure;
      if (this.#ended !== undefined) throw new MarctlError('Copy stream ended unexpectedly.');
      await new Promise((resolve) => this.#waiting.push(resolve));
    }
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  async done() {
    if (this.#failure) throw this.#failure;
    while (this.#ended === undefined && this.#failure === undefined)
      await new Promise((resolve) => this.#waiting.push(resolve));
    if (this.#failure) throw this.#failure;
    if (this.#ended !== 0) throw new MarctlError('Remote copy command failed.');
  }
}

async function copyBytes(source, destination) {
  const sizeBytes = await source.read(8);
  const size = sizeBytes.readBigUInt64BE();
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MarctlError('Copy source is too large.');
  const metadata = await source.read(20);
  await destination.open(Number(size), metadata, async (target) => {
    if ((await target.read(1))[0] !== 1)
      throw new MarctlError('Copy target did not accept the file.');
    let remaining = Number(size);
    let acknowledged = Promise.resolve();
    const pending = [];
    for (;;) {
      const header = await source.read(4);
      const length = header.readUInt32BE();
      if (length > CHUNK || length > remaining)
        throw new MarctlError('Copy source sent an invalid chunk.');
      await target.send(header);
      if (length === 0) {
        await acknowledged;
        await target.send(await source.read(32));
        if (remaining !== 0 || (await target.read(1))[0] !== 2)
          throw new MarctlError('Copy target did not verify the file.');
        break;
      }
      await target.send(await source.read(length));
      // Keep one ordered ACK reader while sending up to a bounded window ahead.
      acknowledged = acknowledged.then(async () => {
        if ((await target.read(1))[0] !== 1)
          throw new MarctlError('Copy target rejected the chunk.');
        await source.send(Buffer.from([1]));
      });
      acknowledged.catch((error) => {
        // ACK failures use the same copy-wide cancellation as transport failures.
        source.fail(error);
      });
      pending.push(acknowledged);
      remaining -= length;
      if (pending.length >= WINDOW) await pending.shift();
    }
    await target.done();
  });
  await source.done();
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
  child.once('close', (code) => channel.finish(code ?? 1));
  try {
    return await use(channel);
  } finally {
    if (child.exitCode === null) child.kill();
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
      const onError = () =>
        channel.connectionEnded(new MarctlError(translate('errors.terminalConnectionFailed')));
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

async function withWorker(endpoint, mode, size, metadata, context, use) {
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

export async function runScp({
  source,
  destination,
  preserve = false,
  client,
  WebSocketClass,
  resolveNodeId,
  translate,
  signals = process
}) {
  const from = parseScpEndpoint(source);
  const to = parseScpEndpoint(destination);
  const sourceBasename = scpSourceBasename(from.path);
  if (!from.host && !to.host) throw new MarctlError('At least one copy endpoint must be a Node.');
  const references = [...new Set([from.host, to.host].filter(Boolean))];
  const ids = await Promise.all(references.map((host) => resolveNodeId(host)));
  const resolved = (endpoint) => ({
    path: endpoint.path,
    ...(endpoint.host ? { nodeId: ids[references.indexOf(endpoint.host)] } : {})
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new MarctlError('Copy was interrupted.'));
  signals.on?.('SIGINT', interrupt);
  signals.on?.('SIGTERM', interrupt);
  try {
    const context = {
      client,
      WebSocketClass,
      translate,
      controller,
      preserve,
      sourceBasename
    };
    await withWorker(resolved(from), 'read', undefined, undefined, context, (channel) =>
      copyBytes(channel, {
        open: (size, metadata, use) =>
          withWorker(resolved(to), 'write', size, metadata, context, use)
      })
    );
    return 0;
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signals.removeListener?.('SIGINT', interrupt);
    signals.removeListener?.('SIGTERM', interrupt);
  }
}
