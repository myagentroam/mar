import type { NodeEnvelope } from '@myagentroam/protocol';
import { nodeLog } from './operational.js';

const MAX_FRAMES_PER_TURN = 32;
const MAX_BYTES_PER_TURN = 256 * 1024;
const SOCKET_NORMAL_DIRECT_WATER_BYTES = 256 * 1024;
const SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const BACKPRESSURE_RETRY_MS = 5;
const OUTBOUND_QUEUE_TTL_MS = 30_000;

interface QueuedEnvelope {
  readonly envelope: NodeEnvelope;
  readonly expiresAt: number;
}

interface WritableControlSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(value: string): void;
}

/** Keeps control responses responsive while reliable Workbench events are busy. */
export class ControlOutboundScheduler {
  private readonly high: QueuedEnvelope[] = [];
  private readonly normal: QueuedEnvelope[] = [];
  private scheduled = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private backpressureStartedAt: number | undefined;
  private backpressureLogged = false;
  private maximumHighDepth = 0;
  private maximumNormalDepth = 0;

  constructor(
    private readonly socket: () => WritableControlSocket | undefined,
    private readonly onExpired: () => void = () => undefined
  ) {}

  enqueue(envelope: NodeEnvelope, priority: 'high' | 'normal'): void {
    const socket = this.socket();
    const bufferedAmount = socket?.bufferedAmount ?? 0;
    if (
      socket !== undefined &&
      socket.readyState === 1 &&
      this.high.length === 0 &&
      (priority === 'high' || this.normal.length === 0) &&
      bufferedAmount <= SOCKET_NORMAL_DIRECT_WATER_BYTES
    ) {
      socket.send(JSON.stringify(envelope));
      return;
    }
    (priority === 'high' ? this.high : this.normal).push({
      envelope,
      expiresAt: Date.now() + OUTBOUND_QUEUE_TTL_MS
    });
    this.maximumHighDepth = Math.max(this.maximumHighDepth, this.high.length);
    this.maximumNormalDepth = Math.max(this.maximumNormalDepth, this.normal.length);
    this.scheduleExpiry();
    this.schedule();
  }

  resume(): void {
    this.schedule();
  }

  reset(): void {
    this.high.length = 0;
    this.normal.length = 0;
    this.scheduled = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.finishBackpressure('reset');
  }

  private schedule(): void {
    if (this.scheduled || this.retryTimer !== undefined) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const socket = this.socket();
    if (socket === undefined || socket.readyState !== 1) return;
    if ((socket.bufferedAmount ?? 0) > SOCKET_HIGH_WATER_BYTES) {
      this.waitForBackpressure(socket, 'high');
      return;
    }
    let frames = 0;
    let bytes = 0;
    while (frames < MAX_FRAMES_PER_TURN) {
      const queue = this.high.length > 0 ? this.high : this.normal;
      const queued = queue[0];
      if (queued === undefined) break;
      // High-frequency Workbench events can arrive in bursts. Stop normal traffic early so a later
      // HTTP/control response keeps WebSocket buffer headroom instead of waiting behind the burst.
      if (
        queue === this.normal &&
        (socket.bufferedAmount ?? 0) > SOCKET_NORMAL_DIRECT_WATER_BYTES
      ) {
        this.waitForBackpressure(socket, 'normal');
        return;
      }
      const serialized = JSON.stringify(queued.envelope);
      const size = Buffer.byteLength(serialized);
      if (frames > 0 && bytes + size > MAX_BYTES_PER_TURN) break;
      queue.shift();
      socket.send(serialized);
      frames += 1;
      bytes += size;
      if ((socket.bufferedAmount ?? 0) > SOCKET_HIGH_WATER_BYTES) break;
    }
    if (this.high.length > 0 || this.normal.length > 0) this.schedule();
    else {
      if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
      this.finishBackpressure('drained');
    }
  }

  private waitForBackpressure(socket: WritableControlSocket, level: 'high' | 'normal'): void {
    this.backpressureStartedAt ??= Date.now();
    if (!this.backpressureLogged && Date.now() - this.backpressureStartedAt >= 250) {
      this.backpressureLogged = true;
      nodeLog('control.outbound.backpressure', {
        level,
        bufferedBytes: socket.bufferedAmount,
        highDepth: this.high.length,
        normalDepth: this.normal.length
      });
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.schedule();
    }, BACKPRESSURE_RETRY_MS);
  }

  private finishBackpressure(reason: 'drained' | 'reset'): void {
    if (this.backpressureLogged)
      nodeLog('control.outbound.backpressure.recovered', {
        reason,
        durationMs: Date.now() - (this.backpressureStartedAt ?? Date.now()),
        maximumHighDepth: this.maximumHighDepth,
        maximumNormalDepth: this.maximumNormalDepth
      });
    this.backpressureStartedAt = undefined;
    this.backpressureLogged = false;
    this.maximumHighDepth = 0;
    this.maximumNormalDepth = 0;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) return;
    const expiresAt = Math.min(
      this.high[0]?.expiresAt ?? Number.POSITIVE_INFINITY,
      this.normal[0]?.expiresAt ?? Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(expiresAt)) return;
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        if (
          (this.high[0]?.expiresAt ?? Number.POSITIVE_INFINITY) > Date.now() &&
          (this.normal[0]?.expiresAt ?? Number.POSITIVE_INFINITY) > Date.now()
        ) {
          this.scheduleExpiry();
          return;
        }
        this.reset();
        this.onExpired();
      },
      Math.max(0, expiresAt - Date.now())
    );
    this.expiryTimer.unref();
  }
}
