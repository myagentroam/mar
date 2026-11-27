import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { decodeByteFrame, encodeByteFrame } from '@myagentroam/protocol/byte-frame';
import {
  IPC_HANDSHAKE_MS,
  ipcProof,
  matchesIpcProof,
  terminalBrokerAddress,
  TerminalIpc,
  validNonce
} from './terminal-ipc.mjs';

/** A private broker keeps native teardown outside the foreground without touching the shared socket. */
export function openPrivateTerminalBroker(config, request) {
  let child;
  let reap;
  const endpoint = new TerminalBrokerClient(
    { ...config, privateId: randomBytes(16).toString('hex') },
    request,
    undefined,
    {
      launch(privateConfig) {
        child = launchBroker(privateConfig);
        child.once('close', () => {
          clearTimeout(reap);
          child = undefined;
        });
      }
    }
  );
  endpoint.once('close', () => {
    // Give the private worker time to release the carrier, but do not leave it behind if native teardown stalls.
    if (child !== undefined) reap = setTimeout(() => child?.kill('SIGKILL'), 1_000);
  });
  return endpoint;
}

/** Foreground WebSocket-shaped endpoint for a single logical Terminal attachment. */
export class TerminalBrokerClient extends EventEmitter {
  readyState = 0;
  #local;
  #single;
  #timer;

  constructor(
    config,
    { terminalId, ticket, computer = false },
    openSingle,
    { launch = launchBroker, address = terminalBrokerAddress(config) } = {}
  ) {
    super();
    // Setup begins on the next turn so the owning transport can subscribe first.
    void Promise.resolve().then(async () => {
      if (this.readyState !== 0) return;
      try {
        const socket = await connectBroker(config, address, launch, () => this.readyState === 0);
        if (this.readyState !== 0) return socket.destroy();
        this.#local = new TerminalIpc(socket);
        const nonce = randomBytes(16).toString('hex');
        let challenged = false;
        this.#timer = setTimeout(() => this.#local.close(), IPC_HANDSHAKE_MS);
        this.#local.once('close', () => {
          clearTimeout(this.#timer);
          if (this.readyState === 0) this.#fallback(openSingle);
          else this.#closed();
        });
        this.#local.on('frame', (bytes) => {
          if (this.readyState === 1) return this.emit('message', bytes, true);
          if (this.readyState !== 0) return;
          try {
            const { metadata, payload } = decodeByteFrame(bytes);
            if (payload.length) return this.#local.close();
            if (
              !challenged &&
              metadata.type === 'challenge' &&
              validNonce(metadata.nonce) &&
              matchesIpcProof(metadata.proof, ipcProof(config.key, 'server', nonce, metadata.nonce))
            ) {
              challenged = true;
              this.#local.send(
                encodeByteFrame({
                  type: 'authenticate',
                  proof: ipcProof(config.key, 'client', nonce, metadata.nonce)
                })
              );
              return;
            }
            if (!challenged || metadata.type !== 'ready') return this.#local.close();
            const request = encodeByteFrame({
              type: 'open',
              terminalId,
              ...(ticket === undefined ? {} : { ticket }),
              computer
            });
            clearTimeout(this.#timer);
            // Once OPEN is dispatched, never retry the same attachment on a different connection.
            this.readyState = 1;
            this.#local.send(request);
            this.emit('open');
          } catch {
            this.#local.close();
          }
        });
        this.#local.send(encodeByteFrame({ type: 'hello', nonce }));
      } catch {
        if (this.readyState === 0) this.#fallback(openSingle);
      }
    });
  }

  get bufferedAmount() {
    return this.#single?.bufferedAmount ?? this.#local?.bufferedAmount ?? 0;
  }

  send(bytes, done) {
    if (this.readyState !== 1) {
      if (done) {
        done(new Error('TERMINAL_CONNECTION_LOST'));
        return;
      }
      throw new Error('TERMINAL_CONNECTION_LOST');
    }
    if (this.#single) this.#single.send(bytes, done);
    else this.#local.send(bytes, done);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    clearTimeout(this.#timer);
    if (this.#single) this.#single.close();
    else if (this.#local) this.#local.close();
    else this.#closed();
  }

  #closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  async #fallback(openSingle) {
    if (this.readyState !== 0 || this.#single) return;
    try {
      if (!openSingle) return this.#closed();
      const socket = openSingle();
      this.#single = socket?.then ? await socket : socket;
      if (this.readyState !== 0) {
        this.#single.on('error', () => {});
        this.#single.close();
        return;
      }
      this.#single.on('open', () => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit('open');
      });
      this.#single.on('message', (...args) => this.emit('message', ...args));
      this.#single.on('close', () => this.#closed());
      this.#single.on('error', () => this.#closed());
    } catch {
      this.#closed();
    }
  }
}

async function connectBroker(config, address, launch, alive) {
  const deadline = Date.now() + 2_000;
  let started = false;
  while (alive()) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = createConnection(address);
        socket.once('error', reject);
        socket.once('connect', () => resolve(socket));
        socket.setTimeout(500, () => socket.destroy(new Error('TERMINAL_IPC_TIMEOUT')));
        socket.once('connect', () => socket.setTimeout(0));
      });
    } catch (error) {
      if (!alive() || Date.now() >= deadline || !['ENOENT', 'ECONNREFUSED'].includes(error.code))
        throw error;
      if (!started) {
        launch(config);
        started = true;
      }
      await delay(35);
    }
  }
  throw new Error('TERMINAL_CONNECTION_LOST');
}

function launchBroker(config) {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'TMPDIR',
    'TMP',
    'TEMP',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR'
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./terminal-broker.mjs', import.meta.url))],
    {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env
    }
  );
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(config));
  child.unref();
  return child;
}
