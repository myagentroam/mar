import {
  terminalDataFrameSchema,
  terminalDirectAttachedFrameSchema,
  type TerminalDirectBrowserMessage,
  type TerminalDirectServerMessage,
  type TerminalDataFrame
} from '@myagentroam/protocol';
import type { createWorkspaceDirectTransferService } from './WorkspaceDirectTransferService.js';

type Transport = NonNullable<
  ReturnType<ReturnType<typeof createWorkspaceDirectTransferService>['acquireTerminalTransport']>
>;

export class TerminalDirectError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Pending {
  readonly transport: Transport;
  readonly resolve: (
    message: Extract<TerminalDirectServerMessage, { type: 'terminal.direct.prepared' }>
  ) => void;
  readonly reject: (error: TerminalDirectError) => void;
}

interface Active {
  readonly transport: Transport;
  readonly channel: RTCDataChannel;
  readonly onFrame: (frame: TerminalDataFrame) => void;
  readonly onAttached: () => void;
  readonly onDisconnected: (code: string) => void;
  attached: boolean;
  stopped: boolean;
  lastHeartbeat: number;
  timer?: ReturnType<typeof setInterval>;
  attachTimer?: ReturnType<typeof setTimeout>;
}

export interface TerminalDirectClientOptions {
  readonly send: (message: TerminalDirectBrowserMessage) => boolean;
  readonly acquire: (nodeId: string) => Transport | undefined;
}

export function createTerminalDirectClient(options: TerminalDirectClientOptions) {
  const pending = new Map<string, Pending>();
  const active = new Map<string, Active>();

  function handle(message: TerminalDirectServerMessage): void {
    if (message.type === 'terminal.direct.prepared') {
      const waiting = pending.get(message.requestId);
      if (waiting === undefined) {
        options.send({ type: 'terminal.direct.cancel', directSessionId: message.directSessionId });
        return;
      }
      pending.delete(message.requestId);
      waiting.resolve(message);
      return;
    }
    if (message.type === 'terminal.direct.error') {
      const waiting = pending.get(message.requestId ?? '');
      if (waiting !== undefined) {
        pending.delete(message.requestId!);
        waiting.reject(new TerminalDirectError(message.code));
      }
      return;
    }
    const session = active.get(message.directSessionId);
    if (session === undefined) return;
    if (message.type === 'terminal.direct.heartbeat') session.lastHeartbeat = Date.now();
    else stop(message.directSessionId, session, message.code);
  }

  function stop(id: string, session: Active, code?: string): void {
    if (session.stopped) return;
    session.stopped = true;
    active.delete(id);
    if (session.timer !== undefined) clearInterval(session.timer);
    if (session.attachTimer !== undefined) clearTimeout(session.attachTimer);
    session.channel.close();
    options.send({ type: 'terminal.direct.cancel', directSessionId: id });
    session.transport.release();
    if (code !== undefined) session.onDisconnected(code);
  }

  async function attach(input: {
    readonly nodeId: string;
    readonly terminalId: string;
    readonly workspaceId?: string;
    readonly afterSequence: number;
    readonly readonly: boolean;
    readonly onFrame: (frame: TerminalDataFrame) => void;
    readonly onAttached: () => void;
    readonly onDisconnected: (code: string) => void;
    readonly signal: AbortSignal;
  }): Promise<{ send(frame: object): void; dispose(): void } | undefined> {
    const transport = options.acquire(input.nodeId);
    if (transport === undefined) return undefined;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    let removeAbort = () => undefined;
    let grantedSessionId: string | undefined;
    try {
      const prepared = await new Promise<
        Extract<TerminalDirectServerMessage, { type: 'terminal.direct.prepared' }>
      >((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new TerminalDirectError('TERMINAL_DIRECT_TIMEOUT'));
        }, 5_000);
        const abort = () => {
          pending.delete(requestId);
          reject(new TerminalDirectError('TERMINAL_DIRECT_CANCELLED'));
        };
        removeAbort = () => {
          clearTimeout(timeout);
          input.signal.removeEventListener('abort', abort);
        };
        input.signal.addEventListener('abort', abort, { once: true });
        pending.set(requestId, {
          transport,
          resolve,
          reject
        });
        if (
          input.signal.aborted ||
          !options.send({
            type: 'terminal.direct.prepare',
            requestId,
            nodeId: input.nodeId,
            nodeGeneration: transport.nodeGeneration,
            transportSessionId: transport.transportSessionId,
            terminalId: input.terminalId,
            ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
            afterSequence: input.afterSequence,
            readonly: input.readonly
          })
        )
          abort();
      });
      removeAbort();
      grantedSessionId = prepared.directSessionId;
      if (input.signal.aborted) throw new TerminalDirectError('TERMINAL_DIRECT_CANCELLED');
      const channel = transport.createChannel(`mar-terminal-${prepared.directSessionId}`);
      const session: Active = {
        transport,
        channel,
        onFrame: input.onFrame,
        onAttached: input.onAttached,
        onDisconnected: input.onDisconnected,
        attached: false,
        stopped: false,
        lastHeartbeat: Date.now()
      };
      active.set(prepared.directSessionId, session);
      const dispose = (code?: string) => stop(prepared.directSessionId, session, code);
      channel.addEventListener('open', () => {
        if (session.stopped) return;
        channel.send(
          JSON.stringify({
            type: 'OPEN',
            directSessionId: prepared.directSessionId,
            grant: prepared.grant
          })
        );
      });
      channel.addEventListener('message', (event) => {
        if (session.stopped || typeof event.data !== 'string' || event.data.length > 128 * 1024) {
          dispose('TERMINAL_FRAME_INVALID');
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          dispose('TERMINAL_FRAME_INVALID');
          return;
        }
        if (!session.attached) {
          const attached = terminalDirectAttachedFrameSchema.safeParse(value);
          if (!attached.success || attached.data.terminalId !== input.terminalId) {
            dispose('TERMINAL_ATTACH_FAILED');
            return;
          }
          session.attached = true;
          if (session.attachTimer !== undefined) clearTimeout(session.attachTimer);
          session.onAttached();
          return;
        }
        const frame = terminalDataFrameSchema.safeParse(value);
        if (!frame.success || frame.data.terminalId !== input.terminalId) {
          dispose('TERMINAL_FRAME_INVALID');
          return;
        }
        session.onFrame(frame.data);
      });
      channel.addEventListener('close', () => dispose('TERMINAL_DIRECT_CLOSED'));
      session.attachTimer = setTimeout(() => dispose('TERMINAL_DIRECT_TIMEOUT'), 15_000);
      session.timer = setInterval(() => {
        if (
          Date.now() - session.lastHeartbeat > 30_000 ||
          !options.send({
            type: 'terminal.direct.heartbeat',
            directSessionId: prepared.directSessionId
          })
        )
          dispose('TERMINAL_DIRECT_CONTROL_UNAVAILABLE');
      }, 10_000);
      if (input.signal.aborted) dispose();
      else input.signal.addEventListener('abort', () => dispose(), { once: true });
      return {
        send(frame) {
          if (!session.attached || session.stopped || channel.readyState !== 'open') return;
          if (channel.bufferedAmount > 1024 * 1024) {
            dispose('TERMINAL_BACKPRESSURE');
            return;
          }
          channel.send(JSON.stringify(frame));
        },
        dispose: () => dispose()
      };
    } catch (error) {
      removeAbort();
      if (grantedSessionId !== undefined)
        options.send({ type: 'terminal.direct.cancel', directSessionId: grantedSessionId });
      transport.release();
      if (error instanceof TerminalDirectError) throw error;
      throw new TerminalDirectError('TERMINAL_DIRECT_UNAVAILABLE');
    }
  }

  function invalidate(): void {
    for (const [id, item] of pending) {
      pending.delete(id);
      item.reject(new TerminalDirectError('TERMINAL_DIRECT_CONTROL_UNAVAILABLE'));
    }
    for (const [id, item] of active) stop(id, item, 'TERMINAL_DIRECT_CONTROL_UNAVAILABLE');
  }

  return { attach, handle, invalidate };
}
