import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  decodeByteFrame,
  decodeTerminalMux,
  encodeByteFrame,
  encodeTerminalMux,
  MAX_TERMINAL_MUX_BYTES,
  TERMINAL_MUX
} from '@myagentroam/protocol/byte-frame';
import {
  IPC_BUFFER_LIMIT,
  IPC_HANDSHAKE_MS,
  ipcProof,
  matchesIpcProof,
  TerminalIpc,
  terminalBrokerAddress,
  validNonce
} from './terminal-ipc.mjs';

const IDLE_MS = 10 * 60_000;
const MAX_STREAMS = 10;

/** Owns one authenticated Node relay across foreground commands, never a PTY or desktop lease. */
export async function startTerminalBroker(config, { idleMs = IDLE_MS } = {}) {
  const { serverUrl, key, nodeId } = config;
  const peers = new Set();
  const streams = new Map();
  let wire;
  let connecting;
  let admissionTimer;
  let preparing = 0;
  let lastStream = 0;
  let idle;
  let closed = false;
  const server = createServer((socket) => {
    const channel = new TerminalIpc(socket);
    if (closed || peers.size >= 20) return channel.close();
    peers.add(channel);
    let state = 'hello';
    let clientNonce;
    let serverNonce;
    let stream;
    const timer = setTimeout(() => channel.close(), IPC_HANDSHAKE_MS);
    channel.once('close', () => {
      clearTimeout(timer);
      peers.delete(channel);
      if (state === 'awaiting-wire' || state === 'open') {
        preparing--;
        scheduleIdle();
      } else if (stream !== undefined && streams.delete(stream)) {
        if (wire?.readyState === WebSocket.OPEN)
          wire.send(encodeTerminalMux(TERMINAL_MUX.close, stream));
        scheduleIdle();
      }
    });
    channel.on('frame', (frame) => {
      try {
        if (state === 'active') {
          send(stream, TERMINAL_MUX.data, frame, channel);
          return;
        }
        const { metadata, payload } = decodeByteFrame(frame);
        if (payload.length || frame.length > 1024) return channel.close();
        if (state === 'hello' && metadata.type === 'hello' && validNonce(metadata.nonce)) {
          state = 'authenticate';
          clientNonce = metadata.nonce;
          serverNonce = randomBytes(16).toString('hex');
          channel.send(
            encodeByteFrame({
              type: 'challenge',
              nonce: serverNonce,
              proof: ipcProof(key, 'server', clientNonce, serverNonce)
            })
          );
          return;
        }
        if (
          state === 'authenticate' &&
          metadata.type === 'authenticate' &&
          matchesIpcProof(metadata.proof, ipcProof(key, 'client', clientNonce, serverNonce))
        ) {
          if (preparing + streams.size >= MAX_STREAMS) return channel.close();
          state = 'awaiting-wire';
          // An authenticated foreground command owns a slot even before OPEN.
          preparing++;
          clearTimeout(idle);
          void connect()
            .then(() => {
              if (socket.destroyed) return;
              state = 'open';
              channel.send(encodeByteFrame({ type: 'ready' }));
            })
            .catch(() => channel.close());
          return;
        }
        if (
          state !== 'open' ||
          metadata.type !== 'open' ||
          typeof metadata.ticket !== 'string' ||
          !metadata.ticket ||
          metadata.ticket.length > 128 ||
          typeof metadata.deferred !== 'boolean'
        )
          return channel.close();
        if (lastStream === 0xffffffff) return stop();
        stream = ++lastStream;
        streams.set(stream, channel);
        preparing--;
        state = 'active';
        clearTimeout(timer);
        send(
          stream,
          TERMINAL_MUX.open,
          encodeByteFrame({ ticket: metadata.ticket, deferred: metadata.deferred }),
          channel
        );
      } catch {
        channel.close();
      }
    });
  });

  function scheduleIdle() {
    clearTimeout(idle);
    if (!closed && preparing === 0 && streams.size === 0) idle = setTimeout(stop, idleMs);
  }

  function send(stream, type, data, channel) {
    const frame = encodeTerminalMux(type, stream, data);
    if (
      wire?.readyState !== WebSocket.OPEN ||
      wire.bufferedAmount + frame.length > IPC_BUFFER_LIMIT
    )
      return channel.close();
    channel.socket.pause();
    wire.send(frame, (error) => {
      if (error) channel.close();
      else channel.socket.resume();
    });
  }

  function connect() {
    connecting ??= new Promise((resolve, reject) => {
      const url = new URL('/api/marctl/terminal-mux', serverUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('node', nodeId);
      wire = new WebSocket(url, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: MAX_TERMINAL_MUX_BYTES
      });
      // The upgrade may succeed before Server authenticates or refuses pool admission.
      admissionTimer = setTimeout(stop, IPC_HANDSHAKE_MS);
      let admitted = false;
      wire.on('error', reject);
      wire.once('close', () => {
        reject(new Error('TERMINAL_CONNECTION_LOST'));
        stop();
      });
      wire.on('message', (raw, binary) => {
        try {
          if (!binary || !Buffer.isBuffer(raw)) throw new Error('TERMINAL_MUX_INVALID');
          const { type, stream, payload } = decodeTerminalMux(raw);
          if (!admitted) {
            if (type !== TERMINAL_MUX.ready) throw new Error('TERMINAL_MUX_INVALID');
            admitted = true;
            clearTimeout(admissionTimer);
            resolve();
            return;
          }
          if (type === TERMINAL_MUX.ready || type === TERMINAL_MUX.open || stream > lastStream)
            throw new Error('TERMINAL_MUX_INVALID');
          const channel = streams.get(stream);
          if (!channel) return;
          if (type === TERMINAL_MUX.close) {
            streams.delete(stream);
            channel.end();
            scheduleIdle();
          } else channel.send(payload);
        } catch {
          stop();
        }
      });
    });
    return connecting;
  }

  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    clearTimeout(admissionTimer);
    streams.clear();
    for (const channel of peers) channel.close();
    wire?.terminate();
    server.close();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(terminalBrokerAddress(config), resolve);
  });
  scheduleIdle();
  return { close: stop };
}

async function run() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20 * 1024) return;
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  await startTerminalBroker(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run().catch(() => {
    process.exitCode = 1;
  });
