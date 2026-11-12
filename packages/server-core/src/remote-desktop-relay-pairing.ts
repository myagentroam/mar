import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type { DirectTransferBrowserIdentity } from './direct-transfer-coordinator.js';
import type { RemoteDesktopAdmission } from './remote-desktop-admission.js';
import { RemoteDesktopRelayPair } from './remote-desktop-relay-pair.js';

interface Pending {
  readonly browserTicket: string;
  readonly nodeTicket: string;
  readonly deadline: number;
  readonly timer: NodeJS.Timeout;
  browser?: WebSocket;
  node?: WebSocket;
  pair?: RemoteDesktopRelayPair;
  browserClosed?: () => void;
  nodeClosed?: () => void;
  browserMessage?: (data: RawData, binary: boolean) => void;
  nodeMessage?: (data: RawData, binary: boolean) => void;
  browserFrames: Array<{ data: Buffer; binary: boolean }>;
  nodeFrames: Array<{ data: Buffer; binary: boolean }>;
  browserBytes: number;
  nodeBytes: number;
}

function matchesTicket(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  const actual = Buffer.from(value);
  const original = Buffer.from(expected);
  return actual.length === original.length && timingSafeEqual(actual, original);
}

/**
 * Owns one-use relay handoffs after external browser/Node authentication.
 * The admission owner remains responsible for authorization, OPEN/ACTIVE,
 * lease renewal and native cleanup confirmation; socket loss fences admission
 * synchronously but never settles it.
 */
export class RemoteDesktopRelayPairing {
  readonly #pending = new Map<string, Pending>();
  readonly #clock: () => number;
  #closed = false;

  constructor(
    private readonly options: {
      readonly admission: RemoteDesktopAdmission;
      readonly maxFrameBytes: number;
      readonly maxInFlightBytes: number;
      readonly onClosed: (attachmentId: string) => void;
      readonly now?: () => number;
    }
  ) {
    if (
      !Number.isSafeInteger(options.maxFrameBytes) ||
      options.maxFrameBytes < 1 ||
      !Number.isSafeInteger(options.maxInFlightBytes) ||
      options.maxInFlightBytes < options.maxFrameBytes
    )
      throw new Error('Invalid desktop relay limits.');
    const epoch = Date.now() - performance.now();
    this.#clock = options.now ?? (() => Math.floor(epoch + performance.now()));
  }

  /** Only an existing dispatched RELAY reservation can obtain separate one-use tickets. */
  prepare(
    attachmentId: string
  ): { browserTicket: string; nodeTicket: string; deadline: number } | undefined {
    const entry = this.options.admission.get(attachmentId);
    const now = this.#now();
    if (
      this.#closed ||
      this.#pending.has(attachmentId) ||
      !entry ||
      entry.path !== 'RELAY' ||
      !entry.dispatched ||
      !['RESERVED', 'PREPARED'].includes(entry.phase) ||
      entry.openExpiresAt <= now ||
      entry.expiresAt <= now
    )
      return undefined;
    const browserTicket = randomBytes(32).toString('base64url');
    const nodeTicket = randomBytes(32).toString('base64url');
    const deadline = Math.min(entry.openExpiresAt, entry.expiresAt);
    const timer = setTimeout(() => this.#finish(attachmentId), Math.max(0, deadline - now));
    timer.unref();
    this.#pending.set(attachmentId, {
      browserTicket,
      nodeTicket,
      deadline,
      timer,
      browserFrames: [],
      nodeFrames: [],
      browserBytes: 0,
      nodeBytes: 0
    });
    return { browserTicket, nodeTicket, deadline };
  }

  /** Caller passes the authenticated page identity, never an identity supplied in a frame. */
  attachBrowser(
    attachmentId: string,
    ticket: unknown,
    identity: DirectTransferBrowserIdentity,
    socket: WebSocket
  ): boolean {
    const entry = this.options.admission.get(attachmentId);
    const pending = this.#pending.get(attachmentId);
    if (
      !this.#eligible(entry, pending) ||
      pending!.browser ||
      entry!.userId !== identity.userId ||
      entry!.sessionHash !== identity.sessionHash ||
      entry!.workbenchConnectionId !== identity.workbenchConnectionId ||
      !matchesTicket(ticket, pending!.browserTicket) ||
      socket.readyState !== WebSocket.OPEN ||
      socket === pending!.node
    )
      return false;
    pending!.browser = socket;
    this.#watch(attachmentId, pending!, 'browser', socket);
    this.#pair(attachmentId, pending!);
    return true;
  }

  /** Caller supplies the authenticated current Node and its actual process generation. */
  attachNode(
    attachmentId: string,
    ticket: unknown,
    nodeId: string,
    generation: string,
    socket: WebSocket
  ): boolean {
    const entry = this.options.admission.get(attachmentId);
    const pending = this.#pending.get(attachmentId);
    if (
      !this.#eligible(entry, pending) ||
      pending!.node ||
      entry!.nodeId !== nodeId ||
      entry!.nodeGeneration !== generation ||
      !matchesTicket(ticket, pending!.nodeTicket) ||
      socket.readyState !== WebSocket.OPEN ||
      socket === pending!.browser
    )
      return false;
    pending!.node = socket;
    this.#watch(attachmentId, pending!, 'node', socket);
    this.#pair(attachmentId, pending!);
    return true;
  }

  cancel(attachmentId: string): void {
    this.#finish(attachmentId);
  }

  /** Node OPEN is authoritative; pairing sockets must not extend the OPEN deadline. */
  opened(attachmentId: string): boolean {
    const pending = this.#pending.get(attachmentId);
    const entry = this.options.admission.get(attachmentId);
    if (
      !pending?.pair ||
      !entry ||
      entry.path !== 'RELAY' ||
      !['SETTING_UP', 'ATTACHED', 'ACTIVE'].includes(entry.phase) ||
      pending.deadline <= this.#now()
    )
      return false;
    clearTimeout(pending.timer);
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const id of this.#pending.keys()) this.#finish(id);
  }

  #eligible(
    entry: ReturnType<RemoteDesktopAdmission['get']>,
    pending: Pending | undefined
  ): boolean {
    return (
      !this.#closed &&
      !!pending &&
      !!entry &&
      entry.path === 'RELAY' &&
      entry.phase !== 'CLOSING' &&
      entry.dispatched &&
      pending.deadline > this.#now() &&
      entry.expiresAt > this.#now()
    );
  }

  #watch(id: string, pending: Pending, side: 'browser' | 'node', socket: WebSocket): void {
    socket.pause();
    const closed = () => this.#finish(id);
    const message = (data: RawData, binary: boolean) => {
      const size = Array.isArray(data)
        ? data.reduce((n, chunk) => n + chunk.byteLength, 0)
        : data.byteLength;
      const charge = Math.max(size, Math.min(256, this.options.maxFrameBytes));
      const used = side === 'browser' ? pending.browserBytes : pending.nodeBytes;
      if (size > this.options.maxFrameBytes || used + charge > this.options.maxInFlightBytes)
        return this.#finish(id);
      const copy = Array.isArray(data)
        ? Buffer.concat(data, size)
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      if (side === 'browser') {
        pending.browserBytes += charge;
        pending.browserFrames.push({ data: copy, binary });
      } else {
        pending.nodeBytes += charge;
        pending.nodeFrames.push({ data: copy, binary });
      }
    };
    if (side === 'browser') {
      pending.browserClosed = closed;
      pending.browserMessage = message;
    } else {
      pending.nodeClosed = closed;
      pending.nodeMessage = message;
    }
    socket.on('message', message);
    socket.on('close', closed);
    socket.on('error', closed);
  }

  #unwatch(
    socket: WebSocket | undefined,
    closed: (() => void) | undefined,
    message: ((data: RawData, binary: boolean) => void) | undefined
  ): void {
    if (!socket || !closed) return;
    socket.off('close', closed);
    socket.off('error', closed);
    if (message) socket.off('message', message);
  }

  #pair(id: string, pending: Pending): void {
    if (!pending.browser || !pending.node) return;
    this.#unwatch(pending.browser, pending.browserClosed, pending.browserMessage);
    this.#unwatch(pending.node, pending.nodeClosed, pending.nodeMessage);
    try {
      pending.pair = new RemoteDesktopRelayPair(pending.browser, pending.node, {
        maxFrameBytes: this.options.maxFrameBytes,
        maxInFlightBytes: this.options.maxInFlightBytes,
        browserPreRead: pending.browserFrames,
        nodePreRead: pending.nodeFrames,
        onClosed: () => this.#finish(id)
      });
      pending.browserFrames.length = 0;
      pending.nodeFrames.length = 0;
      pending.browserBytes = 0;
      pending.nodeBytes = 0;
    } catch {
      this.#finish(id);
    }
  }

  #finish(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.options.admission.beginClose(id);
    clearTimeout(pending.timer);
    this.#unwatch(pending.browser, pending.browserClosed, pending.browserMessage);
    this.#unwatch(pending.node, pending.nodeClosed, pending.nodeMessage);
    if (pending.pair) pending.pair.close();
    else
      for (const socket of [pending.browser, pending.node]) {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const ignoreError = () => {};
          socket.on('error', ignoreError);
          socket.once('close', () => socket.off('error', ignoreError));
          socket.terminate();
        }
      }
    this.options.onClosed(id);
  }

  #now(): number {
    return this.#clock();
  }
}
