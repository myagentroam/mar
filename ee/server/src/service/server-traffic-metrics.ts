export type TrafficChannel = 'http' | 'node' | 'workbench' | 'terminal';
export type TrafficDirection = 'in' | 'out';

const SAMPLE_RETENTION = 60;
const LOG_INTERVAL_SECONDS = 10;
export const LARGE_TRAFFIC_FRAME_BYTES = 256 * 1024;

export interface TrafficCounters {
  readonly inBytes: number;
  readonly outBytes: number;
  readonly inMessages: number;
  readonly outMessages: number;
  readonly largeFrames: number;
  readonly backpressureEvents: number;
  readonly maxBufferedBytes: number;
}

export interface ServerTrafficSample extends TrafficCounters {
  readonly timestamp: number;
  readonly channels: Readonly<Record<TrafficChannel, TrafficCounters>>;
}

interface MutableCounters {
  inBytes: number;
  outBytes: number;
  inMessages: number;
  outMessages: number;
  largeFrames: number;
  backpressureEvents: number;
  maxBufferedBytes: number;
}

type TrafficLog = (event: string, fields: Record<string, unknown>) => void;

export class ServerTrafficMetrics {
  private current = emptyChannels();
  private readonly samples: ServerTrafficSample[] = [];
  private readonly timer: NodeJS.Timeout;
  private secondsSinceLog = 0;

  constructor(
    private readonly log: TrafficLog = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.timer = setInterval(() => this.sample(), 1_000);
    this.timer.unref();
  }

  record(channel: TrafficChannel, direction: TrafficDirection, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    const size = Math.round(bytes);
    const counters = this.current[channel];
    if (direction === 'in') {
      counters.inBytes += size;
      counters.inMessages += 1;
    } else {
      counters.outBytes += size;
      counters.outMessages += 1;
    }
    if (size >= LARGE_TRAFFIC_FRAME_BYTES) {
      counters.largeFrames += 1;
      this.log('server.traffic.large-frame', { channel, direction, bytes: size });
    }
  }

  backpressure(channel: Exclude<TrafficChannel, 'http'>, bufferedBytes: number): void {
    const counters = this.current[channel];
    counters.backpressureEvents += 1;
    counters.maxBufferedBytes = Math.max(counters.maxBufferedBytes, Math.max(0, bufferedBytes));
    this.log('server.traffic.backpressure', {
      channel,
      bufferedBytes: Math.max(0, bufferedBytes)
    });
  }

  snapshot(): { readonly sampledAt: number; readonly samples: readonly ServerTrafficSample[] } {
    return { sampledAt: this.now(), samples: [...this.samples] };
  }

  close(): void {
    clearInterval(this.timer);
  }

  sample(): void {
    const channels = freezeChannels(this.current);
    const sample: ServerTrafficSample = {
      timestamp: this.now(),
      ...sumCounters(Object.values(channels)),
      channels
    };
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_RETENTION) this.samples.shift();
    this.current = emptyChannels();
    this.secondsSinceLog += 1;
    if (this.secondsSinceLog < LOG_INTERVAL_SECONDS) return;
    this.secondsSinceLog = 0;
    const recent = this.samples.slice(-LOG_INTERVAL_SECONDS);
    const aggregate = sumCounters(recent);
    this.log('server.traffic.summary', {
      intervalSeconds: recent.length,
      ...aggregate,
      channels: Object.fromEntries(
        (Object.keys(channels) as TrafficChannel[]).map((channel) => [
          channel,
          sumCounters(recent.map((item) => item.channels[channel]))
        ])
      )
    });
  }
}

function emptyCounters(): MutableCounters {
  return {
    inBytes: 0,
    outBytes: 0,
    inMessages: 0,
    outMessages: 0,
    largeFrames: 0,
    backpressureEvents: 0,
    maxBufferedBytes: 0
  };
}

function emptyChannels(): Record<TrafficChannel, MutableCounters> {
  return {
    http: emptyCounters(),
    node: emptyCounters(),
    workbench: emptyCounters(),
    terminal: emptyCounters()
  };
}

function freezeChannels(
  channels: Record<TrafficChannel, MutableCounters>
): Record<TrafficChannel, TrafficCounters> {
  return {
    http: { ...channels.http },
    node: { ...channels.node },
    workbench: { ...channels.workbench },
    terminal: { ...channels.terminal }
  };
}

function sumCounters(values: readonly TrafficCounters[]): TrafficCounters {
  return values.reduce<TrafficCounters>(
    (result, value) => ({
      inBytes: result.inBytes + value.inBytes,
      outBytes: result.outBytes + value.outBytes,
      inMessages: result.inMessages + value.inMessages,
      outMessages: result.outMessages + value.outMessages,
      largeFrames: result.largeFrames + value.largeFrames,
      backpressureEvents: result.backpressureEvents + value.backpressureEvents,
      maxBufferedBytes: Math.max(result.maxBufferedBytes, value.maxBufferedBytes)
    }),
    emptyCounters()
  );
}
