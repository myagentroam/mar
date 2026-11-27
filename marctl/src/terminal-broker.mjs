import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { MarctlClient } from './client.mjs';
import { DirectFallbackError } from './direct-errors.mjs';
import { openDirectConnection } from './direct.mjs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  decodeByteFrame,
  decodeTerminalMux,
  encodeTerminalMessage,
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
  listenTerminalBroker,
  terminalBrokerAddress,
  validNonce
} from './terminal-ipc.mjs';

const IDLE_MS = 10 * 60_000;
const MAX_STREAMS = 10;

/** Owns both paths to one Node; IPC clients own independent remote tasks and never migrate them. */
export async function startTerminalBroker(
  config,
  {
    idleMs = IDLE_MS,
    address = terminalBrokerAddress(config),
    openDirect = openDirectConnection
  } = {}
) {
  const { serverUrl, key, nodeId } = config;
  const client = new MarctlClient(config);
  const lifecycle = new AbortController();
  const peers = new Set();
  const relayStreams = new Map();
  let wire;
  let relayAttempt;
  let direct;
  let directAttempt;
  let admitted = 0;
  let lastStream = 0;
  let idle;
  const server = createServer((socket) => {
    const ipc = new TerminalIpc(socket);
    if (lifecycle.signal.aborted || peers.size >= 20) return ipc.close();
    peers.add(ipc);
    const pending = new AbortController();
    let state = 'hello';
    let clientNonce;
    let serverNonce;
    let forward;
    let release;
    const timer = setTimeout(() => ipc.close(), IPC_HANDSHAKE_MS);
    ipc.once('close', () => {
      clearTimeout(timer);
      pending.abort();
      peers.delete(ipc);
      release?.();
      if (
        state === 'admitted' ||
        state === 'ready' ||
        state === 'attaching' ||
        state === 'active'
      ) {
        admitted--;
        scheduleIdle();
      }
    });
    ipc.on('frame', (frame) => {
      try {
        if (state === 'active') {
          ipc.pause();
          Promise.resolve(forward(frame)).then(
            () => ipc.resume(),
            () => ipc.close()
          );
          return;
        }
        const { metadata, payload } = decodeByteFrame(frame);
        if (payload.length || frame.length > 1024) return ipc.close();
        if (state === 'hello' && metadata.type === 'hello' && validNonce(metadata.nonce)) {
          state = 'authenticate';
          clientNonce = metadata.nonce;
          serverNonce = randomBytes(16).toString('hex');
          ipc.send(
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
          if (admitted >= MAX_STREAMS) return ipc.close();
          admitted++;
          state = 'admitted';
          clearTimeout(idle);
          void readyPath().then(
            () => {
              if (!socket.destroyed) {
                state = 'ready';
                ipc.send(encodeByteFrame({ type: 'ready' }));
              }
            },
            () => ipc.close()
          );
          return;
        }
        const { terminalId, ticket, computer } = metadata;
        if (
          state !== 'ready' ||
          metadata.type !== 'open' ||
          typeof terminalId !== 'string' ||
          !terminalId ||
          terminalId.length > 512 ||
          (ticket !== undefined &&
            (typeof ticket !== 'string' || !ticket || ticket.length > 128)) ||
          typeof computer !== 'boolean'
        )
          return ipc.close();
        state = 'attaching';
        clearTimeout(timer);
        void attach().catch((error) => {
          if (socket.destroyed) return;
          // A dispatched attachment is never retried by the foreground on broker failure.
          const code =
            typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
              ? error.code
              : 'TERMINAL_ATTACH_FAILED';
          ipc.send(encodeTerminalMessage({ type: 'error', terminalId, code }));
          ipc.end();
        });

        async function attach() {
          if (direct && !direct.closed) {
            let transport;
            try {
              transport = await direct.attach({ terminalId, computer, signal: pending.signal });
            } catch (error) {
              if (!(error instanceof DirectFallbackError) || pending.signal.aborted) throw error;
              // Only an error before Direct OPEN allows the same task to use Relay.
            }
            if (transport) {
              if (socket.destroyed) return transport.close();
              forward = (frame) => transport.sendEncoded(frame);
              release = () => transport.close();
              state = 'active';
              transport.on('message', (raw) => ipc.send(raw));
              transport.on('error', () => ipc.end());
              transport.on('close', () => ipc.end());
              ipc.send(encodeTerminalMessage({ type: 'attach', terminalId, afterSequence: 0 }));
              transport.activate();
              return;
            }
          }
          const socketWire = await connectRelay();
          const grant = ticket ?? (await client.createAttachTicket({ nodeId, terminalId }));
          if (socket.destroyed) return;
          if (socketWire.readyState !== WebSocket.OPEN || lastStream === 0xffffffff)
            throw new Error('TERMINAL_CONNECTION_LOST');
          const stream = ++lastStream;
          relayStreams.set(stream, ipc);
          release = () => {
            if (relayStreams.delete(stream) && socketWire.readyState === WebSocket.OPEN)
              socketWire.send(encodeTerminalMux(TERMINAL_MUX.close, stream));
          };
          forward = (frame) => sendRelay(socketWire, TERMINAL_MUX.data, stream, frame);
          state = 'active';
          await sendRelay(
            socketWire,
            TERMINAL_MUX.open,
            stream,
            encodeByteFrame({ ticket: grant, deferred: false })
          );
        }
      } catch {
        ipc.close();
      }
    });
  });

  function scheduleIdle() {
    clearTimeout(idle);
    if (!lifecycle.signal.aborted && admitted === 0) idle = setTimeout(stop, idleMs);
  }

  function readyPath() {
    if (direct && !direct.closed) return Promise.resolve();
    if (direct) {
      // Rebuild a previously usable path once, without delaying callers on a ready relay.
      direct = undefined;
      directAttempt = undefined;
    }
    directAttempt ??= openDirect({
      client,
      WebSocketClass: WebSocket,
      nodeId,
      signal: lifecycle.signal,
      // Keep the native module initialized for the broker's lifetime.
      cleanupNative: () => {}
    }).then((connection) => {
      if (lifecycle.signal.aborted) connection.close();
      else direct = connection;
    });
    return Promise.any([
      connectRelay(),
      directAttempt.then(() => {
        if (!direct || direct.closed) throw new Error('DIRECT_UNAVAILABLE');
      })
    ]);
  }

  function connectRelay() {
    if (lifecycle.signal.aborted) return Promise.reject(new Error('TERMINAL_CONNECTION_LOST'));
    relayAttempt ??= new Promise((resolve, reject) => {
      const url = new URL('/api/marctl/terminal-mux', serverUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('node', nodeId);
      const socketWire = new WebSocket(url, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: MAX_TERMINAL_MUX_BYTES
      });
      wire = socketWire;
      let ready = false;
      const admissionTimer = setTimeout(() => socketWire.terminate(), IPC_HANDSHAKE_MS);
      socketWire.on('error', reject);
      socketWire.once('close', () => {
        clearTimeout(admissionTimer);
        reject(new Error('TERMINAL_CONNECTION_LOST'));
        relayAttempt = undefined;
        wire = undefined;
        for (const stream of relayStreams.values()) stream.end();
        relayStreams.clear();
      });
      socketWire.on('message', (raw, binary) => {
        try {
          if (!binary || !Buffer.isBuffer(raw)) throw new Error('TERMINAL_MUX_INVALID');
          const { type, stream, payload } = decodeTerminalMux(raw);
          if (!ready) {
            if (type !== TERMINAL_MUX.ready) throw new Error('TERMINAL_MUX_INVALID');
            ready = true;
            clearTimeout(admissionTimer);
            resolve(socketWire);
            return;
          }
          if (type === TERMINAL_MUX.ready || type === TERMINAL_MUX.open || stream > lastStream)
            throw new Error('TERMINAL_MUX_INVALID');
          const ipc = relayStreams.get(stream);
          if (!ipc) return;
          if (type === TERMINAL_MUX.close) {
            relayStreams.delete(stream);
            ipc.end();
          } else ipc.send(payload);
        } catch {
          socketWire.terminate();
        }
      });
    });
    return relayAttempt;
  }

  function stop() {
    if (lifecycle.signal.aborted) return;
    lifecycle.abort();
    clearTimeout(idle);
    relayStreams.clear();
    for (const channel of peers) channel.close();
    wire?.terminate();
    direct?.close();
    server.close();
  }

  await listenTerminalBroker(server, address);
  scheduleIdle();
  return { close: stop };
}

function sendRelay(socket, type, stream, data) {
  const frame = encodeTerminalMux(type, stream, data);
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + frame.length > IPC_BUFFER_LIMIT
  )
    throw new Error('TERMINAL_CONNECTION_LOST');
  return new Promise((resolve, reject) =>
    socket.send(frame, (error) => (error ? reject(error) : resolve()))
  );
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
