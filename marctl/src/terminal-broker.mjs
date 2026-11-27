import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { MarctlClient } from './client.mjs';
import { openDirectConnection } from './direct.mjs';
import { connectTerminalBrokerRelay } from './terminal-broker-relay.mjs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  decodeByteFrame,
  encodeTerminalMessage,
  encodeByteFrame
} from '@myagentroam/protocol/byte-frame';
import { NodeConnection } from '@myagentroam/protocol/node-connection';
import {
  IPC_HANDSHAKE_MS,
  ipcProof,
  matchesIpcProof,
  TerminalIpc,
  listenTerminalBroker,
  terminalBrokerAddress,
  validNonce
} from './terminal-ipc.mjs';

const IDLE_MS = 10 * 60_000;
const PRIVATE_START_IDLE_MS = 10_000;
const MAX_STREAMS = 10;

/** Shares one NodeConnection with admitted IPC clients and owns its idle lifetime. */
export async function startTerminalBroker(
  config,
  {
    idleMs = IDLE_MS,
    address = terminalBrokerAddress(config),
    openDirect = openDirectConnection
  } = {}
) {
  const { serverUrl, key, nodeId } = config;
  const privateBroker = config.privateId !== undefined;
  const client = new MarctlClient(config);
  const lifecycle = new AbortController();
  const peers = new Set();
  const connection = new NodeConnection({
    direct: async (signal) => {
      const direct = await openDirect({
        client,
        WebSocketClass: WebSocket,
        nodeId,
        signal,
        // Keep the native module initialized for the broker's lifetime.
        cleanupNative: () => {}
      });
      try {
        return await direct.openStreams(signal);
      } catch (error) {
        direct.close();
        throw error;
      }
    },
    relay: (signal) => connectTerminalBrokerRelay({ serverUrl, key, nodeId, client }, signal)
  });
  let admitted = 0;
  let idle;
  const server = createServer((socket) => {
    const ipc = new TerminalIpc(socket);
    if (lifecycle.signal.aborted || peers.size >= (privateBroker ? 1 : 20)) return ipc.close();
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
      if (privateBroker) return stop();
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
          void connection.ready({ signal: pending.signal }).then(
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
          const stream = await connection.openStream(
            {
              terminalId,
              ticket,
              computer,
              onFrame: (bytes) => new Promise((resolve) => ipc.send(bytes, resolve)),
              onEnd: () => ipc.end()
            },
            { signal: pending.signal }
          );
          if (socket.destroyed) return stream.close();
          forward = stream.write;
          release = stream.close;
          state = 'active';
          stream.activate?.();
        }
      } catch {
        ipc.close();
      }
    });
  });

  function scheduleIdle() {
    clearTimeout(idle);
    if (!lifecycle.signal.aborted && admitted === 0)
      idle = setTimeout(stop, privateBroker ? PRIVATE_START_IDLE_MS : idleMs);
  }

  function stop() {
    if (lifecycle.signal.aborted) return;
    lifecycle.abort();
    clearTimeout(idle);
    for (const channel of peers) channel.close();
    server.close();
    connection.close();
  }

  await listenTerminalBroker(server, address);
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
