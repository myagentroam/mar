import {
  terminalDataFrameSchema,
  terminalDirectNodeCommandSchema,
  terminalDirectOpenFrameSchema,
  type TerminalDirectNodeCommand
} from '@myagentroam/protocol';
import type { TerminalManager } from '../terminal.js';
import type { RTCPeerConnection } from 'node-datachannel/polyfill';

type Prepare = Extract<TerminalDirectNodeCommand, { type: 'terminal.direct.prepare' }>;

interface Session {
  readonly command: Prepare;
  readonly peer: RTCPeerConnection;
  channel?: RTCDataChannel;
  attachmentId?: string;
  opened: boolean;
  expiresAt: number;
  lastHeartbeat: number;
}

const MAX_SESSIONS = 128;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;
const HEARTBEAT_GRACE_MS = 30_000;

export class TerminalDirectService {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly stopListening: () => void;
  private readonly now: () => number;

  constructor(
    private readonly manager: TerminalManager,
    private readonly sendReady: (sessionId: string, phase?: 'ATTACHED') => void,
    private readonly verifyTransport: (command: Prepare, peer: RTCPeerConnection) => boolean,
    now: () => number = Date.now
  ) {
    this.now = now;
    this.stopListening = manager.onFrame((frame) => {
      for (const session of this.sessions.values())
        if (session.opened && session.command.terminalId === frame.terminalId)
          this.sendFrame(session, frame);
    });
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
        command.openExpiresAt <= this.now() ||
        command.expiresAt <= this.now()
      )
        return true;
      this.sessions.set(command.directSessionId, {
        command,
        peer,
        opened: false,
        expiresAt: command.expiresAt,
        lastHeartbeat: this.now()
      });
      this.sendReady(command.directSessionId);
      return true;
    }
    const session = this.sessions.get(command.directSessionId);
    if (session === undefined) return true;
    if (command.type === 'terminal.direct.cancel') this.remove(session);
    else if (session.expiresAt > this.now() && command.expiresAt > this.now()) {
      session.expiresAt = command.expiresAt;
      session.lastHeartbeat = this.now();
    } else this.remove(session);
    return true;
  }

  open(transportId: string, channel: RTCDataChannel, raw: unknown): void {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4_096) {
      channel.close();
      return;
    }
    let parsed: ReturnType<typeof terminalDirectOpenFrameSchema.safeParse>;
    try {
      parsed = terminalDirectOpenFrameSchema.safeParse(JSON.parse(raw));
    } catch {
      channel.close();
      return;
    }
    const session = parsed.success ? this.sessions.get(parsed.data.directSessionId) : undefined;
    if (
      session === undefined ||
      session.channel !== undefined ||
      session.opened ||
      session.command.transportSessionId !== transportId ||
      session.command.grant !== (parsed.success ? parsed.data.grant : undefined) ||
      session.command.openExpiresAt <= this.now() ||
      session.expiresAt <= this.now() ||
      !this.verifyTransport(session.command, session.peer)
    ) {
      channel.close();
      return;
    }
    session.channel = channel;
    channel.onclose = () => this.remove(session);
    try {
      const terminal = this.manager.get(session.command.terminalId);
      if (
        terminal.state !== 'RUNNING' ||
        terminal.workspaceId !== (session.command.workspaceId ?? null)
      )
        throw new Error('TERMINAL_NOT_FOUND');
      const attachment = this.manager.authorizeAttach({
        terminalId: session.command.terminalId,
        afterSequence: session.command.afterSequence,
        readonly: session.command.readonly
      });
      session.attachmentId = attachment.attachmentId;
      session.opened = true;
      channel.send(
        JSON.stringify({
          type: 'ATTACHED',
          terminalId: session.command.terminalId,
          afterSequence: session.command.afterSequence
        })
      );
      for (const frame of attachment.frames) this.sendFrame(session, frame);
      channel.onmessage = (event) => this.accept(session, event.data);
      this.manager.startCommand(session.command.terminalId);
      void Promise.resolve()
        .then(() => this.sendReady(session.command.directSessionId, 'ATTACHED'))
        .catch(() => console.warn('AUDIT_RECEIPT_UNAVAILABLE'));
    } catch (error) {
      this.remove(
        session,
        error instanceof Error && error.message === 'TERMINAL_ATTACH_CONFLICT'
          ? 'TERMINAL_ATTACH_CONFLICT'
          : 'TERMINAL_ATTACH_FAILED'
      );
    }
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
    this.stopListening();
  }

  private accept(session: Session, raw: unknown): void {
    if (
      !session.opened ||
      typeof raw !== 'string' ||
      Buffer.byteLength(raw) > MAX_FRAME_BYTES ||
      session.expiresAt <= this.now()
    ) {
      this.remove(session, 'TERMINAL_FRAME_REJECTED');
      return;
    }
    try {
      const frame = terminalDataFrameSchema.parse(JSON.parse(raw));
      if (
        frame.terminalId !== session.command.terminalId ||
        !['input', 'resize', 'close'].includes(frame.type) ||
        session.attachmentId === undefined
      )
        throw new Error('TERMINAL_FRAME_INVALID');
      void this.manager
        .acceptFrame(session.attachmentId, frame)
        .catch(() => this.remove(session, 'TERMINAL_FRAME_REJECTED'));
    } catch {
      this.remove(session, 'TERMINAL_FRAME_REJECTED');
    }
  }

  private sendFrame(session: Session, frame: unknown): void {
    const channel = session.channel;
    if (channel?.readyState !== 'open') {
      this.remove(session);
      return;
    }
    const value = JSON.stringify(frame);
    if (channel.bufferedAmount + Buffer.byteLength(value) > MAX_BUFFERED_BYTES) {
      this.remove(session, 'TERMINAL_BACKPRESSURE');
      return;
    }
    try {
      channel.send(value);
    } catch {
      this.remove(session);
    }
  }

  private remove(session: Session, code?: string): void {
    if (!this.sessions.delete(session.command.directSessionId)) return;
    if (session.attachmentId !== undefined) this.manager.detach(session.attachmentId);
    if (code !== undefined && session.channel?.readyState === 'open') {
      try {
        session.channel.send(
          JSON.stringify({ type: 'error', terminalId: session.command.terminalId, code })
        );
      } catch {
        // A closing channel must not prevent attachment cleanup.
      }
    }
    session.channel?.close();
  }
}
