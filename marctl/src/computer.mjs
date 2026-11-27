import { randomUUID } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeByteFrame } from '@myagentroam/protocol/byte-frame';
import { MarctlError } from './errors.mjs';
import { parseFrame } from './terminal-frame.mjs';
import { openTerminalAttachment } from './terminal.mjs';

const MAX_REQUEST = 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Runs a single non-resumable desktop attachment and publishes only completed results. */
export async function runComputer({ client, nodeId, directory, stdin, stdout, signal, translate }) {
  directory = resolve(directory);
  if (!(await stat(directory).catch(() => undefined))?.isDirectory())
    throw new MarctlError(translate('errors.computerDirectory'));
  const { terminalId, ticket } = await client.openComputer(nodeId, signal);
  let transport;
  let pending;
  let sequence = 0;
  let received = Buffer.alloc(0);
  let exited;
  let acknowledgeExit;
  let failure;
  let dispatched = false;
  const fail = (error) => {
    failure ??= error;
    pending?.reject(failure);
    acknowledgeExit?.reject(failure);
    stdin.destroy?.();
  };
  const unknown = () =>
    new MarctlError(translate('errors.computerUnknown'), { code: 'OUTCOME_UNKNOWN' });
  const lost = () =>
    fail(dispatched ? unknown() : new MarctlError(translate('errors.terminalConnectionLost')));
  const invalid = () => new MarctlError(translate('errors.terminalFrameInvalid'));

  try {
    transport = await openTerminalAttachment({
      client,
      nodeId,
      terminalId,
      ticket,
      computer: true,
      signal,
      translate,
      connectionTimeoutMs: 15_000
    });
    transport.on('error', lost);
    transport.on('close', () => {
      if (exited === undefined) lost();
    });
    transport.on('message', (raw, binary) => {
      try {
        const frame = parseFrame(raw, binary, terminalId, translate);
        if (frame.type === 'exit') {
          if (pending) return lost();
          exited = frame.exitCode ?? 1;
          acknowledgeExit?.resolve(exited);
          return;
        }
        if (
          !pending ||
          frame.type !== 'output' ||
          frame.stream !== undefined ||
          frame.sequence !== ++sequence
        )
          throw invalid();
        received = Buffer.concat([received, frame.data]);
        while (received.length >= 4) {
          const size = received.readUInt32BE();
          if (size < 3 || size > 70 * 1024) throw invalid();
          if (received.length < 4 + size) break;
          const { metadata, payload } = decodeByteFrame(received.subarray(4, 4 + size));
          received = received.subarray(4 + size);
          const reply = pending.accept(metadata, payload);
          if (reply !== undefined) {
            if (received.length || !pending) throw invalid();
            const complete = pending;
            pending = undefined;
            dispatched = false;
            complete.resolve(reply);
          }
        }
      } catch (error) {
        fail(dispatched ? unknown() : error instanceof MarctlError ? error : invalid());
      }
    });
    signal?.addEventListener('abort', lost, { once: true });
    if (signal?.aborted) lost();
    transport.activate();
    for await (const request of readRequests(stdin, signal, translate)) {
      if (failure) throw failure;
      dispatched = true;
      const result = new Promise((resolve, reject) => {
        pending = { resolve, reject, accept: resultReader(invalid) };
      });
      const send = async () => {
        for (let offset = 0; offset < request.length; offset += 32 * 1024)
          await transport.send({
            type: 'input',
            terminalId,
            data: request.subarray(offset, offset + 32 * 1024)
          });
      };
      const [, reply] = await Promise.all([send(), result]).catch((error) => {
        if (failure) throw failure;
        if (dispatched) throw unknown();
        throw error;
      });
      if (reply.error !== undefined)
        throw new MarctlError(reply.error.message, { code: reply.error.code });
      if (reply.outcome === 'OUTCOME_UNKNOWN') throw unknown();
      if (reply.cleanupFailed === true)
        throw new MarctlError(translate('errors.computerCleanupFailed'), {
          code: 'COMPUTER_CLEANUP_FAILED'
        });
      const { images, ...report } = reply;
      const paths = [];
      for (const png of images ?? []) {
        const path = resolve(directory, `${randomUUID()}.png`);
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(png);
          await file.close();
        } catch (error) {
          await file.close().catch(() => {});
          await unlink(path).catch(() => {});
          throw error;
        }
        paths.push(path);
      }
      await new Promise((resolve, reject) =>
        stdout.write(`${JSON.stringify({ ...report, images: paths })}\n`, (error) =>
          error ? reject(error) : resolve()
        )
      );
    }
    if (failure) throw failure;
    if (exited !== undefined) return exited;
    const completed = new Promise((resolve, reject) => {
      acknowledgeExit = { resolve, reject };
    });
    const [, code] = await Promise.all([transport.send({ type: 'eof', terminalId }), completed]);
    return code;
  } finally {
    signal?.removeEventListener('abort', lost);
    transport?.close();
    await client.deleteTerminal({ nodeId, terminalId }).catch(() => {});
  }
}

async function* readRequests(stdin, signal, translate) {
  const abort = () => stdin.destroy?.();
  signal?.addEventListener('abort', abort, { once: true });
  let chunks = [];
  let size = 0;
  try {
    for await (const input of stdin) {
      const bytes = Buffer.from(input);
      for (let start = 0; start < bytes.length;) {
        const end = bytes.indexOf(10, start);
        const part = bytes.subarray(start, end < 0 ? bytes.length : end);
        size += part.length;
        if (size > MAX_REQUEST) throw new MarctlError(translate('errors.computerInput'));
        if (part.length) chunks.push(part);
        if (end < 0) break;
        if (size) yield Buffer.concat([...chunks, Buffer.of(10)], size + 1);
        chunks = [];
        size = 0;
        start = end + 1;
      }
    }
    if (size && !signal?.aborted) yield Buffer.concat([...chunks, Buffer.of(10)], size + 1);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function resultReader(invalid) {
  let result;
  let report;
  let image;
  let offset = 0;
  const images = [];
  return (metadata, payload) => {
    if (
      metadata.type === 'error' &&
      !result &&
      !payload.length &&
      typeof metadata.code === 'string' &&
      typeof metadata.message === 'string'
    )
      return { error: { code: metadata.code, message: metadata.message } };
    if (
      metadata.type === 'result' &&
      !result &&
      !payload.length &&
      ['SUCCEEDED', 'OUTCOME_UNKNOWN'].includes(metadata.outcome) &&
      typeof metadata.observationId === 'string' &&
      Number.isSafeInteger(metadata.reportBytes) &&
      metadata.reportBytes > 0 &&
      metadata.reportBytes <= 8 * 1024 * 1024 &&
      Number.isSafeInteger(metadata.imageCount) &&
      metadata.imageCount >= 0 &&
      metadata.imageCount <= 4
    ) {
      result = metadata;
      report = Buffer.alloc(metadata.reportBytes);
      return;
    }
    if (!result) throw invalid();
    if (
      metadata.type === 'report' &&
      offset < report.length &&
      payload.length &&
      offset + payload.length <= report.length
    ) {
      report.set(payload, offset);
      offset += payload.length;
      return;
    }
    if (offset !== report.length) throw invalid();
    if (
      metadata.type === 'image' &&
      !payload.length &&
      !image &&
      metadata.index === images.length &&
      images.length < result.imageCount &&
      Number.isSafeInteger(metadata.size) &&
      metadata.size >= SIGNATURE.length &&
      metadata.size <= MAX_IMAGE
    ) {
      image = { png: Buffer.alloc(metadata.size), offset: 0 };
      return;
    }
    if (
      metadata.type === 'png' &&
      image &&
      payload.length &&
      image.offset + payload.length <= image.png.length
    ) {
      image.png.set(payload, image.offset);
      image.offset += payload.length;
      if (image.offset === image.png.length) {
        if (!image.png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw invalid();
        images.push(image.png);
        image = undefined;
      }
      return;
    }
    if (
      metadata.type === 'complete' &&
      !payload.length &&
      !image &&
      images.length === result.imageCount
    ) {
      const { type: _, reportBytes: _bytes, imageCount: _count, ...rest } = result;
      const detail = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(report));
      if (!Array.isArray(detail?.logs) || detail.logs.some((log) => typeof log !== 'string'))
        throw invalid();
      return { ...rest, logs: detail.logs, message: detail.message, images };
    }
    throw invalid();
  };
}
