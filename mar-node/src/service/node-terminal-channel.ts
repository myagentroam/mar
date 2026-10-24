import WebSocket from 'ws';
import { terminalDataFrameSchema, type TerminalDataFrame } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import type { TerminalManager } from '../terminal.js';
import { nodeTerminalConnectEndpoint, isPlainRecord } from '../util/node-operation-parsers.js';
import { TerminalRelayState } from './terminal-relay-state.js';
import { TerminalRelaySender } from '@myagentroam/marctl/src/terminal-relay-sender.mjs';

interface NodeTerminalChannelOptions {
  readonly config: () => NodeConfig | undefined;
  readonly controlConnected: () => boolean;
  readonly stopped: () => boolean;
  readonly reconnect: boolean;
  readonly reconnectDelay: (attempt: number) => number;
  readonly manager: TerminalManager;
}

export class NodeTerminalChannel {
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private readonly state = new TerminalRelayState();
  private sender: TerminalRelaySender | undefined;
  private readonly pausedTerminals = new Set<string>();

  constructor(private readonly options: NodeTerminalChannelOptions) {
    options.manager.onFrame((frame) => this.publish(frame));
  }

  connect(): void {
    const config = this.options.config();
    if (
      config?.nodeId === undefined ||
      config.credential === undefined ||
      this.options.stopped() ||
      (this.socket !== undefined &&
        (this.socket.readyState === this.socket.OPEN ||
          this.socket.readyState === this.socket.CONNECTING))
    )
      return;
    const socket = new WebSocket(nodeTerminalConnectEndpoint(config.serverUrl));
    this.socket = socket;
    socket.once('open', () =>
      this.send({ type: 'authenticate', nodeId: config.nodeId, credential: config.credential })
    );
    socket.on('message', (raw, isBinary) =>
      isBinary ? socket.close(4002, 'TERMINAL_MESSAGE_INVALID') : this.handle(raw.toString())
    );
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.releaseAttachments();
      this.scheduleReconnect();
    });
    socket.once('error', () => undefined);
  }

  disconnect(): void {
    this.releaseAttachments();
    this.socket?.close();
  }

  stop(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.releaseAttachments();
    this.socket?.close();
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (
      this.options.stopped() ||
      !this.options.reconnect ||
      !this.options.controlConnected() ||
      this.reconnectTimer !== undefined
    )
      return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.options.reconnectDelay(this.attempts++));
  }

  private handle(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.invalid();
      return;
    }
    if (!isPlainRecord(message) || typeof message.type !== 'string') {
      this.invalid();
      return;
    }
    if (message.type === 'authenticated') {
      if (
        typeof message.nodeId !== 'string' ||
        Object.keys(message).some((key) => key !== 'type' && key !== 'nodeId')
      )
        this.invalid();
      else this.attempts = 0;
      return;
    }
    if (message.type === 'attach') {
      if (
        typeof message.ticket !== 'string' ||
        typeof message.terminalId !== 'string' ||
        typeof message.attachmentId !== 'string' ||
        !Number.isSafeInteger(message.latestSequence) ||
        (message.latestSequence as number) < 0 ||
        Object.keys(message).some(
          (key) => !['type', 'ticket', 'terminalId', 'attachmentId', 'latestSequence'].includes(key)
        )
      ) {
        this.invalid();
        return;
      }
      this.state.attachments.set(message.ticket, {
        terminalId: message.terminalId,
        attachmentId: message.attachmentId
      });
      const synchronization = this.options.manager.synchronizeAttachment({
        terminalId: message.terminalId,
        attachmentId: message.attachmentId,
        afterSequence: message.latestSequence
      });
      if (!synchronization.active) {
        this.state.attachments.delete(message.ticket);
        this.send({
          type: 'detach',
          ticket: message.ticket,
          reason: 'TERMINAL_ATTACH_FAILED'
        });
        return;
      }
      this.send({
        type: 'attached',
        ticket: message.ticket,
        terminalId: message.terminalId
      });
      for (const frame of synchronization.frames) this.sendFrame(message.ticket, frame);
      this.options.manager.startCommand(message.terminalId);
      return;
    }
    if (message.type === 'detach' || message.type === 'close') {
      if (
        typeof message.ticket !== 'string' ||
        Object.keys(message).some((key) => !['type', 'ticket'].includes(key))
      ) {
        this.invalid();
        return;
      }
      const attachment = this.state.attachments.get(message.ticket);
      if (attachment === undefined) return;
      this.sender?.cancel(message.ticket);
      this.state.attachments.delete(message.ticket);
      if (message.type === 'detach') this.options.manager.detach(attachment.attachmentId);
      else
        void this.options.manager
          .acceptFrame(attachment.attachmentId, {
            type: 'close',
            terminalId: attachment.terminalId
          })
          .catch(() => undefined);
      return;
    }
    if (message.type === 'frame') {
      if (
        typeof message.ticket !== 'string' ||
        Object.keys(message).some((key) => !['type', 'ticket', 'frame'].includes(key))
      ) {
        this.invalid();
        return;
      }
      const parsed = terminalDataFrameSchema.safeParse(message.frame);
      const attachment = this.state.attachments.get(message.ticket);
      if (!parsed.success || !['input', 'resize', 'close'].includes(parsed.data.type)) {
        this.invalid();
        return;
      }
      if (attachment === undefined) return;
      if (parsed.data.terminalId !== attachment.terminalId) {
        this.invalid();
        return;
      }
      void this.options.manager.acceptFrame(attachment.attachmentId, parsed.data).catch(() => {
        this.rejectAttachment(message.ticket as string, attachment, 'TERMINAL_FRAME_REJECTED');
      });
      return;
    }
    if (message.type === 'shutdown' && Object.keys(message).length === 1) {
      this.releaseAttachments();
      void this.options.manager.shutdown();
      return;
    }
    this.invalid();
  }

  private publish(frame: TerminalDataFrame): void {
    for (const [ticket, attachment] of this.state.attachments) {
      if (attachment.terminalId !== frame.terminalId) continue;
      this.sendFrame(ticket, frame);
    }
  }
  private sendFrame(ticket: string, frame: TerminalDataFrame): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== socket.OPEN) return;
    this.sender ??= new TerminalRelaySender(socket, {
      onPendingChange: (keys) => this.updatePausedTerminals(keys)
    });
    const attachment = this.state.attachments.get(ticket);
    void this.sender.send(JSON.stringify({ type: 'frame', ticket, frame }), ticket).then(
      () => {
        if (frame.type === 'exit' && this.state.attachments.get(ticket) === attachment)
          this.state.attachments.delete(ticket);
      },
      (error) => {
        if (this.state.attachments.get(ticket) !== attachment || attachment === undefined) return;
        if (error?.code === 'TERMINAL_RELAY_BUFFER_EXCEEDED')
          this.rejectAttachment(ticket, attachment, 'TERMINAL_BACKPRESSURE');
        else socket.close(1011, 'TERMINAL_SEND_FAILED');
      }
    );
  }

  private updatePausedTerminals(keys: ReadonlySet<string>): void {
    const pending = new Map<string, Set<string>>();
    for (const key of keys) {
      const attachment = this.state.attachments.get(key);
      if (attachment !== undefined) {
        const ids = pending.get(attachment.terminalId) ?? new Set<string>();
        ids.add(attachment.attachmentId);
        pending.set(attachment.terminalId, ids);
      }
    }
    for (const terminalId of this.pausedTerminals) {
      if (pending.has(terminalId)) continue;
      this.pausedTerminals.delete(terminalId);
      this.options.manager.setOutputBackpressure(terminalId, new Set());
    }
    for (const [terminalId, attachmentIds] of pending) {
      this.pausedTerminals.add(terminalId);
      this.options.manager.setOutputBackpressure(terminalId, attachmentIds);
    }
  }

  private rejectAttachment(
    ticket: string,
    attachment: { readonly terminalId: string; readonly attachmentId: string },
    code: string
  ): void {
    if (this.state.attachments.get(ticket) !== attachment) return;
    this.state.attachments.delete(ticket);
    this.sender?.cancel(ticket);
    this.options.manager.detach(attachment.attachmentId);
    this.send({
      type: 'frame',
      ticket,
      frame: { type: 'error', terminalId: attachment.terminalId, code }
    });
  }
  private send(message: object): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, 'TERMINAL_SEND_FAILED');
    }
  }
  private invalid(): void {
    this.socket?.close(4002, 'TERMINAL_MESSAGE_INVALID');
  }

  private releaseAttachments(): void {
    for (const attachment of this.state.attachments.values())
      this.options.manager.detach(attachment.attachmentId);
    this.state.attachments.clear();
    this.sender?.close();
    this.sender = undefined;
  }
}
