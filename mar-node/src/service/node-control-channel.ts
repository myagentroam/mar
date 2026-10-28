import WebSocket from 'ws';
import { createEnvelope, type NodeCapabilities, type NodeEnvelope } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import { ControlOutboundScheduler } from '../control-outbound-scheduler.js';
import { nodeConnectEndpoint } from '../connection/endpoints.js';

interface NodeControlChannelOptions {
  readonly config: () => NodeConfig | undefined;
  readonly capabilities: () => NodeCapabilities;
  readonly stopped: () => boolean;
  readonly reconnect: boolean;
  readonly reconnectDelay: (attempt: number) => number;
  readonly onConnecting: (attempt: number) => void;
  readonly onReconnectScheduled: () => void;
  readonly onMessage: (raw: string) => void;
  readonly onClose: (code: number, reason: string) => void;
}

export class NodeControlChannel {
  private socket: WebSocket | undefined;
  private readonly outbound = new ControlOutboundScheduler(
    () => this.socket,
    () => this.socket?.close(1013, 'NODE_CONTROL_BACKPRESSURE_TIMEOUT')
  );
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempts = 0;

  constructor(private readonly options: NodeControlChannelOptions) {}

  connect(): void {
    const config = this.options.config();
    if (
      config === undefined ||
      this.options.stopped() ||
      (this.socket !== undefined &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING))
    )
      return;
    this.options.onConnecting(this.attempts);
    const socket = new WebSocket(nodeConnectEndpoint(config.serverUrl));
    this.socket = socket;
    socket.once('open', () => {
      this.attempts = 0;
      if (config.nodeId !== undefined && config.credential !== undefined)
        this.send('authenticate', { nodeId: config.nodeId, credential: config.credential });
      else if (config.registrationToken !== undefined)
        this.send('register', {
          registrationToken: config.registrationToken,
          capabilities: this.options.capabilities()
        });
      else socket.close(4000, 'NODE_CREDENTIAL_MISSING');
    });
    socket.on('message', (raw) => this.options.onMessage(raw.toString()));
    socket.once('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.outbound.reset();
      const reasonText = reason.toString();
      this.options.onClose(code, reasonText);
      if (!(code === 4000 && reasonText === 'NODE_CONNECTION_REPLACED')) this.scheduleReconnect();
    });
    socket.once('error', () => undefined);
  }

  connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  close(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }
  stop(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.outbound.reset();
    this.socket?.close();
    this.socket = undefined;
  }

  send(type: string, payload: unknown, replyTo?: string): void {
    this.sendEnvelope(
      createEnvelope(type, payload, { ...(replyTo === undefined ? {} : { replyTo }) })
    );
  }

  sendEnvelope(envelope: NodeEnvelope): void {
    if (!this.connected()) return;
    this.outbound.enqueue(envelope, envelope.type === 'workbench.event' ? 'normal' : 'high');
  }

  private scheduleReconnect(): void {
    if (this.options.stopped() || !this.options.reconnect || this.reconnectTimer !== undefined)
      return;
    this.options.onReconnectScheduled();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.options.reconnectDelay(this.attempts++));
  }
}
