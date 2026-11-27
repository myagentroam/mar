import {
  terminalDirectNodeCommandSchema,
  type TerminalDirectNodeCommand
} from '@myagentroam/protocol';
import type { TerminalManager } from '../terminal.js';
import type { NodeStream } from '@myagentroam/protocol/node-stream';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';
import { TerminalStreamService } from './terminal-stream-service.js';

type Prepare = Extract<TerminalDirectNodeCommand, { type: 'terminal.direct.prepare' }>;

interface Session {
  readonly command: Prepare;
  readonly peer: RTCPeerConnection;
  stream?: NodeStream;
  expiresAt: number;
  lastHeartbeat: number;
}

const MAX_SESSIONS = 128;
const HEARTBEAT_GRACE_MS = 30_000;

/** Owns Direct Terminal grants and leases, not the ICE peer or Terminal process. */
export class TerminalDirectService {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingGrants = new Map<string, Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(
    manager: TerminalManager,
    private readonly sendReady: (sessionId: string, phase?: 'ATTACHED') => void,
    private readonly verifyTransport: (command: Prepare, peer: RTCPeerConnection) => boolean,
    now: () => number = Date.now,
    private readonly streams = new TerminalStreamService(manager)
  ) {
    this.now = now;
    this.timer = setInterval(() => {
      for (const session of [...this.sessions.values()])
        if (
          session.expiresAt <= this.now() ||
          this.now() - session.lastHeartbeat > HEARTBEAT_GRACE_MS
        )
          this.remove(session);
    }, 5_000);
    this.timer.unref?.();
  }

  handle(value: unknown, getPeer: (id: string) => RTCPeerConnection | undefined): boolean {
    const parsed = terminalDirectNodeCommandSchema.safeParse(value);
    if (!parsed.success) return false;
    const command = parsed.data;
    if (command.type === 'terminal.direct.prepare') {
      const peer = getPeer(command.transportSessionId);
      if (
        peer === undefined ||
        !this.verifyTransport(command, peer) ||
        this.sessions.size >= MAX_SESSIONS ||
        this.sessions.has(command.directSessionId) ||
        this.pendingGrants.has(command.grant) ||
        command.openExpiresAt <= this.now() ||
        command.expiresAt <= this.now()
      )
        return true;
      const session: Session = {
        command,
        peer,
        expiresAt: command.expiresAt,
        lastHeartbeat: this.now()
      };
      this.sessions.set(command.directSessionId, session);
      this.pendingGrants.set(command.grant, session);
      this.sendReady(command.directSessionId);
      return true;
    }
    const session = this.sessions.get(command.directSessionId);
    if (session === undefined) return true;
    if (command.type === 'terminal.direct.cancel') this.remove(session, command.code);
    else if (session.expiresAt > this.now() && command.expiresAt > this.now()) {
      session.expiresAt = command.expiresAt;
      session.lastHeartbeat = this.now();
    } else this.remove(session);
    return true;
  }

  consume(transportId: string, grant: string, signal: AbortSignal): NodeStreamHandler | undefined {
    const session = this.pendingGrants.get(grant);
    if (!this.canOpen(session, transportId)) return undefined;
    this.pendingGrants.delete(grant);
    const { command } = session;
    const abort = () => this.remove(session);
    signal.addEventListener('abort', abort, { once: true });
    return async (stream) => {
      if (this.sessions.get(command.directSessionId) !== session) {
        signal.removeEventListener('abort', abort);
        stream.reset('RESOURCE_DENIED');
        return;
      }
      session.stream = stream;
      try {
        await this.streams.attach(
          {
            terminalId: command.terminalId,
            workspaceId: command.workspaceId ?? null,
            afterSequence: command.afterSequence,
            readonly: command.readonly,
            closeOnDisconnect: command.closeOnDisconnect === true
          },
          stream,
          signal,
          () => this.attached(command.directSessionId)
        );
      } finally {
        signal.removeEventListener('abort', abort);
        delete session.stream;
        this.remove(session);
      }
    };
  }

  private attached(sessionId: string): void {
    void Promise.resolve()
      .then(() => this.sendReady(sessionId, 'ATTACHED'))
      .catch(() => console.warn('AUDIT_RECEIPT_UNAVAILABLE'));
  }

  private canOpen(session: Session | undefined, transportId: string): session is Session {
    return (
      session !== undefined &&
      session.command.transportSessionId === transportId &&
      session.command.openExpiresAt > this.now() &&
      session.expiresAt > this.now() &&
      this.verifyTransport(session.command, session.peer)
    );
  }

  removeTransport(transportId: string): void {
    for (const session of [...this.sessions.values()])
      if (session.command.transportSessionId === transportId) this.remove(session);
  }

  close(): void {
    for (const session of [...this.sessions.values()]) this.remove(session);
  }

  dispose(): void {
    this.close();
    clearInterval(this.timer);
  }

  private remove(session: Session, code?: string): void {
    if (this.sessions.get(session.command.directSessionId) !== session) return;
    this.sessions.delete(session.command.directSessionId);
    if (this.pendingGrants.get(session.command.grant) === session)
      this.pendingGrants.delete(session.command.grant);
    if (session.stream !== undefined) {
      if (code === 'TERMINAL_NOT_AUTHORIZED') session.stream.reset('RESOURCE_DENIED');
      else session.stream.close();
    }
  }
}
