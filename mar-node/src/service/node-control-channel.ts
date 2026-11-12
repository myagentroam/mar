import WebSocket from 'ws';
import { createEnvelope, type NodeCapabilities, type NodeEnvelope } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import { ControlOutboundScheduler } from '../control-outbound-scheduler.js';
import { nodeConnectEndpoint } from '../connection/endpoints.js';

const MAX_PREAUTH_FRAMES = 1024;
const MAX_PREAUTH_BYTES = 8 * 1024 * 1024;

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
  private inboundMuted = false;
  private authenticated = false;
  private preauthFrames = 0;
  private preauthBytes = 0;
  private readonly outbound = new ControlOutboundScheduler(
    () => (this.authenticated ? this.socket : undefined),
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
    this.inboundMuted = false;
    const socket = new WebSocket(nodeConnectEndpoint(config.serverUrl));
    this.socket = socket;
    socket.once('open', () => {
      this.attempts = 0;
      if (config.nodeId !== undefined && config.credential !== undefined)
        socket.send(
          JSON.stringify(
            createEnvelope('authenticate', { nodeId: config.nodeId, credential: config.credential })
          )
        );
      else if (config.registrationToken !== undefined)
        socket.send(
          JSON.stringify(
            createEnvelope('register', {
              registrationToken: config.registrationToken,
              capabilities: this.options.capabilities()
            })
          )
        );
      else socket.close(4000, 'NODE_CREDENTIAL_MISSING');
    });
    socket.on('message', (raw) => {
      if (this.socket === socket && !this.inboundMuted) this.options.onMessage(raw.toString());
    });
    socket.once('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.authenticated = false;
      this.preauthFrames = 0;
      this.preauthBytes = 0;
      this.outbound.reset();
      const reasonText = reason.toString();
      this.options.onClose(code, reasonText);
      if (!(code === 4000 && reasonText === 'NODE_CONNECTION_REPLACED')) this.scheduleReconnect();
    });
    socket.once('error', () => undefined);
  }

  connected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }
  /** Stop admitting new work while allowing final owned cleanup events to be sent. */
  muteInbound(): void {
    this.inboundMuted = true;
  }
  connection(): object | undefined {
    return this.socket;
  }
  ready(capabilities: NodeCapabilities, connection: object | undefined = this.socket): boolean {
    if (
      connection === undefined ||
      connection !== this.socket ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return false;
    this.socket.send(JSON.stringify(createEnvelope('capabilities', capabilities)));
    this.authenticated = true;
    this.preauthFrames = 0;
    this.preauthBytes = 0;
    this.outbound.resume();
    return true;
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
    this.authenticated = false;
    this.preauthFrames = 0;
    this.preauthBytes = 0;
  }

  send(type: string, payload: unknown, replyTo?: string): void {
    this.sendEnvelope(
      createEnvelope(type, payload, { ...(replyTo === undefined ? {} : { replyTo }) })
    );
  }

  sendEnvelope(envelope: NodeEnvelope): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (!this.authenticated) {
      // ready() sends the latest capability snapshot; an older queued snapshot
      // must not overwrite it after authentication.
      if (envelope.type === 'capabilities') return;
      this.preauthFrames++;
      this.preauthBytes += Buffer.byteLength(JSON.stringify(envelope));
      if (this.preauthFrames > MAX_PREAUTH_FRAMES || this.preauthBytes > MAX_PREAUTH_BYTES) {
        this.socket.close(1013, 'NODE_CONTROL_PREAUTH_BACKPRESSURE');
        return;
      }
    }
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
