import WebSocket from 'ws';
import { createEnvelope, type NodeCapabilities, type NodeEnvelope } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import { ControlOutboundScheduler } from '../control-outbound-scheduler.js';
import { nodeConnectEndpoint } from '../connection/endpoints.js';
import { nodeLog } from '../operational.js';

const MAX_PREAUTH_FRAMES = 1024;
const MAX_PREAUTH_BYTES = 8 * 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 45_000;

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

/** Owns one control socket, its send queue, bounded establishment and liveness, and reconnect timers. */
export class NodeControlChannel {
  private socket: WebSocket | undefined;
  private inboundMuted = false;
  private authenticated = false;
  private capabilityReportId: string | undefined;
  private preauthFrames = 0;
  private preauthBytes = 0;
  private readonly outbound = new ControlOutboundScheduler(
    () => (this.authenticated ? this.socket : undefined),
    () => this.socket?.close(1013, 'NODE_CONTROL_BACKPRESSURE_TIMEOUT')
  );
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectionTimer: NodeJS.Timeout | undefined;
  private livenessTimer: NodeJS.Timeout | undefined;
  private lastPongAt = 0;
  private lastPongMonotonicAt = 0;
  private pendingPing: Buffer | undefined;
  private pingSequence = 0;
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
    this.clearConnectionTimers();
    this.authenticated = false;
    this.capabilityReportId = undefined;
    this.preauthFrames = 0;
    this.preauthBytes = 0;
    this.outbound.reset();
    this.options.onConnecting(this.attempts);
    this.inboundMuted = false;
    const socket = new WebSocket(nodeConnectEndpoint(config.serverUrl));
    this.socket = socket;
    // One deadline covers DNS/TCP/TLS, the WebSocket upgrade and registration/authentication.
    this.connectionTimer = setTimeout(() => {
      this.expire(
        socket,
        socket.readyState === WebSocket.CONNECTING
          ? 'NODE_CONTROL_CONNECT_TIMEOUT'
          : 'NODE_CONTROL_AUTHENTICATION_TIMEOUT'
      );
    }, CONNECTION_TIMEOUT_MS);
    this.connectionTimer.unref();
    socket.once('open', () => {
      if (this.socket !== socket) return;
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
      if (this.socket !== socket) return;
      if (!this.inboundMuted) this.options.onMessage(raw.toString());
    });
    socket.on('pong', (payload) => {
      if (this.socket !== socket || !this.pendingPing?.equals(payload)) return;
      if (this.livenessExpired()) {
        this.expire(socket, 'NODE_CONTROL_HEARTBEAT_TIMEOUT');
        return;
      }
      this.pendingPing = undefined;
      this.recordPong();
    });
    socket.once('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.clearConnectionTimers();
      this.socket = undefined;
      this.authenticated = false;
      this.capabilityReportId = undefined;
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
    this.clearConnectionTimers();
    const report = createEnvelope('capabilities', capabilities);
    this.capabilityReportId = report.id;
    this.socket.send(JSON.stringify(report));
    this.authenticated = true;
    this.attempts = 0;
    this.preauthFrames = 0;
    this.preauthBytes = 0;
    // Authentication starts the budget; only the matching pong renews it afterward.
    this.recordPong();
    const socket = this.socket;
    this.livenessTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.livenessExpired()) this.expire(socket, 'NODE_CONTROL_HEARTBEAT_TIMEOUT');
      else if (this.pendingPing === undefined) {
        this.pendingPing = Buffer.from(String(this.pingSequence++));
        socket.ping(this.pendingPing);
      }
    }, PING_INTERVAL_MS);
    this.livenessTimer.unref();
    this.outbound.resume();
    return true;
  }

  acceptCapabilitiesAck(requestId: string): boolean {
    if (!this.connected() || requestId !== this.capabilityReportId) return false;
    this.capabilityReportId = undefined;
    return true;
  }
  close(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
  }
  stop(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearConnectionTimers();
    this.outbound.reset();
    this.socket?.close();
    this.socket = undefined;
    this.authenticated = false;
    this.capabilityReportId = undefined;
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
    if (envelope.type === 'capabilities') this.capabilityReportId = envelope.id;
    this.outbound.enqueue(envelope, envelope.type === 'workbench.event' ? 'normal' : 'high');
  }

  private recordPong(): void {
    this.lastPongAt = Date.now();
    this.lastPongMonotonicAt = performance.now();
  }

  private livenessExpired(): boolean {
    // Wall time includes suspend; monotonic time prevents clock rollback from extending liveness.
    const elapsed = Math.max(
      Date.now() - this.lastPongAt,
      performance.now() - this.lastPongMonotonicAt
    );
    return elapsed >= LIVENESS_TIMEOUT_MS;
  }

  private clearConnectionTimers(): void {
    if (this.connectionTimer !== undefined) clearTimeout(this.connectionTimer);
    if (this.livenessTimer !== undefined) clearInterval(this.livenessTimer);
    this.connectionTimer = undefined;
    this.livenessTimer = undefined;
    this.pendingPing = undefined;
  }

  private expire(socket: WebSocket, code: string): void {
    if (this.socket !== socket) return;
    nodeLog('node.connection.timeout', { code });
    // A close handshake can itself wait on a suspended or half-open peer.
    socket.terminate();
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
