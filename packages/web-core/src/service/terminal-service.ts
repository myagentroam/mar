import {
  decodeTerminalMessage,
  encodeTerminalMessage,
  terminalDataFrameSchema
} from '@myagentroam/protocol';
import { NodeStreamError, type NodeStream } from '@myagentroam/protocol/node-stream';
import { readTerminalRecords, writeTerminalRecord } from '@myagentroam/protocol/terminal-stream';
import type { OpenWorkbenchNodeStream } from './workbench-node-connection-service.js';
import { ApiError } from '../util/api-error.js';
import { translate } from './locale-preference-service.js';

export interface TerminalDockHandle {
  toggle(): Promise<void>;
  release(): Promise<void>;
  closeAll(): Promise<boolean>;
}

export interface WorkbenchTerminalView {
  terminalDocks: Map<string, TerminalDockHandle>;
  openNodeStream: OpenWorkbenchNodeStream;
  terminalReady: boolean;
}

export interface TerminalServiceOptions {
  readonly terminalId: string;
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly openStream: OpenWorkbenchNodeStream;
  readonly onAttached: () => void;
  readonly onOutput: (data: Uint8Array) => void;
  readonly onExited: () => void;
  readonly onTerminalUnavailable: (code: string) => void;
  readonly onErrorFrame: (code: string) => void;
  readonly onReconnectStatus: (message: string | undefined) => void;
}

const TERMINAL_END_CODES = new Set(['TERMINAL_CLOSED', 'TERMINAL_NOT_FOUND']);
const INPUT_CHUNK_BYTES = 32 * 1024;
const ATTACH_TIMEOUT_MS = 20_000;
const MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024;
const DENIED_CODES = new Set([
  'RESOURCE_DENIED',
  'TERMINAL_NOT_AUTHORIZED',
  'TERMINAL_OWNER_REQUIRED',
  'RESOURCE_ACCESS_DENIED',
  'WORKSPACE_ACCESS_DENIED',
  'SESSION_UNAUTHENTICATED',
  'USER_AUTHORIZATION_REQUIRED',
  'TERMINAL_WORKSPACE_MISMATCH',
  'TERMINAL_GIT_OWNER_REQUIRED',
  'NODE_ACCESS_DENIED'
]);

/** Owns one Terminal attachment and its replay cursor, not the shared carrier or PTY. */
export function createTerminalService(options: TerminalServiceOptions) {
  let attachment: { send(frame: object): void; dispose(): void } | undefined;
  let attaching: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let lastSequence = 0;
  let delay = 1_000;
  let generation = 0;
  let disposed = false;
  let attached = false;
  let terminalUnavailable = false;
  let attachmentConflicts = 0;

  function stopTimers(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (countdown !== undefined) clearInterval(countdown);
    timer = undefined;
    countdown = undefined;
  }

  function stopPath(): void {
    attached = false;
    attaching = undefined;
    abort?.abort();
    abort = undefined;
    attachment?.dispose();
    attachment = undefined;
  }

  function terminalFailure(code: string): boolean {
    if (code === 'TERMINAL_ATTACH_CONFLICT') {
      attachmentConflicts += 1;
      generation += 1;
      stopPath();
      scheduleReconnect();
      return true;
    }
    if (TERMINAL_END_CODES.has(code)) {
      terminalUnavailable = true;
      stopTimers();
      stopPath();
      options.onTerminalUnavailable(code);
      return true;
    }
    if (DENIED_CODES.has(code)) {
      terminalUnavailable = true;
      stopTimers();
      stopPath();
      options.onReconnectStatus(undefined);
      options.onErrorFrame(code);
      return true;
    }
    return false;
  }

  function scheduleReconnect(): void {
    if (disposed || terminalUnavailable || timer !== undefined) return;
    const deadline = Date.now() + delay;
    const status = () =>
      options.onReconnectStatus(
        attachmentConflicts >= 3
          ? translate('generated.terminalRelayService.terminalOccupiedRetrying')
          : translate(
              'generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds',
              {
                value0: Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))
              }
            )
      );
    status();
    countdown = setInterval(status, 250);
    timer = setTimeout(() => {
      stopTimers();
      options.onReconnectStatus(
        attachmentConflicts >= 3
          ? translate('generated.terminalRelayService.terminalOccupiedRetrying')
          : translate('generated.terminalRelayService.reconnectingTerminal')
      );
      void connect();
    }, delay);
    delay = Math.min(delay * 2, 10_000);
  }

  function onAttached(): void {
    attached = true;
    attachmentConflicts = 0;
    delay = 1_000;
    stopTimers();
    options.onReconnectStatus(undefined);
    options.onAttached();
  }

  function onOutput(data: Uint8Array, sequence?: number): void {
    if (sequence !== undefined) {
      if (sequence <= lastSequence) return;
      lastSequence = sequence;
    }
    options.onOutput(data);
  }

  function streamLost(epoch: number, error?: unknown): void {
    if (epoch !== generation || disposed || terminalUnavailable) return;
    if (
      (error instanceof NodeStreamError || error instanceof ApiError) &&
      terminalFailure(error.code)
    )
      return;
    generation += 1;
    stopPath();
    scheduleReconnect();
  }

  async function doConnect(): Promise<void> {
    if (disposed || terminalUnavailable) return;
    const epoch = ++generation;
    stopPath();
    abort = new AbortController();
    const signal = abort.signal;
    let stream: NodeStream | undefined;
    const handshake = new AbortController();
    const deadline = setTimeout(() => handshake.abort(), ATTACH_TIMEOUT_MS);
    const opening = AbortSignal.any([signal, handshake.signal]);
    const onTimeout = () => streamLost(epoch);
    handshake.signal.addEventListener('abort', onTimeout, { once: true });
    const clearDeadline = () => {
      clearTimeout(deadline);
      handshake.signal.removeEventListener('abort', onTimeout);
    };
    signal.addEventListener('abort', clearDeadline, { once: true });
    try {
      stream = await options.openStream(
        options.nodeId,
        {
          kind: 'terminal',
          terminalId: options.terminalId,
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          afterSequence: lastSequence
        },
        opening
      );
      opening.throwIfAborted();
      const current = stream;
      let pendingBytes = 0;
      let write = Promise.resolve();
      attachment = {
        send(frame) {
          const record = writeTerminalRecord(encodeTerminalMessage(frame));
          pendingBytes += record.byteLength;
          if (pendingBytes > MAX_PENDING_INPUT_BYTES) {
            streamLost(epoch);
            return;
          }
          write = write
            .then(async () => {
              if (!signal.aborted) await current.write(record);
              pendingBytes -= record.byteLength;
            })
            .catch((error: unknown) => streamLost(epoch, error));
        },
        dispose: () => current.close()
      };
      void (async () => {
        try {
          for await (const record of readTerminalRecords(current)) {
            if (signal.aborted) return;
            const frame = terminalDataFrameSchema.parse(decodeTerminalMessage(record));
            if (frame.terminalId !== options.terminalId) throw new Error('TERMINAL_FRAME_INVALID');
            if (frame.type === 'attach') {
              if (!attached) {
                clearDeadline();
                onAttached();
              }
            } else if (frame.type === 'output') onOutput(frame.data, frame.sequence);
            else if (frame.type === 'exit') {
              terminalUnavailable = true;
              stopPath();
              options.onExited();
              return;
            } else if (frame.type === 'error' && !terminalFailure(frame.code)) {
              options.onErrorFrame(frame.code);
            }
          }
          streamLost(epoch);
        } catch (error) {
          streamLost(epoch, error);
        }
      })();
    } catch (error) {
      clearDeadline();
      stream?.close();
      streamLost(epoch, error);
    }
  }

  function connect(): Promise<void> {
    if (attaching !== undefined) return attaching;
    const task = doConnect().finally(() => {
      if (attaching === task) attaching = undefined;
    });
    attaching = task;
    return task;
  }

  function send(frame: object): void {
    if (!attached || disposed) return;
    const path = attachment;
    if (path === undefined) return;
    if (!(
      'type' in frame &&
      frame.type === 'input' &&
      'data' in frame &&
      typeof frame.data === 'string'
    )) {
      path.send(frame);
      return;
    }
    // Encode once; the Node's streaming PTY decoder preserves characters split across frames.
    const bytes = new TextEncoder().encode(frame.data);
    const epoch = generation;
    for (
      let offset = 0;
      offset < bytes.length && attached && epoch === generation;
      offset += INPUT_CHUNK_BYTES
    )
      path.send({ ...frame, data: bytes.subarray(offset, offset + INPUT_CHUNK_BYTES) });
  }

  function reconnect(): void {
    if (disposed || terminalUnavailable) return;
    attaching = undefined;
    void connect();
  }

  function dispose(): void {
    disposed = true;
    generation += 1;
    stopTimers();
    stopPath();
    options.onReconnectStatus(undefined);
  }

  return { attach: () => (attached ? Promise.resolve() : connect()), send, reconnect, dispose };
}
