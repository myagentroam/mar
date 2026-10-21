/** Neutral monotonic generation timing; Runner adapters own native event semantics. */
export interface GenerationTimingResult {
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly tokensPerSecond: number;
}

interface GenerationRequest {
  started: boolean;
  runningAt?: number | undefined;
  lastAt?: number | undefined;
  durationMs: number;
  ended: boolean;
  settled: boolean;
  invalid: boolean;
}

export class GenerationTimingTracker {
  private readonly requests = new Map<string, GenerationRequest>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  timestamp(): number {
    return this.now();
  }

  start(key: string, observedAt?: number): boolean {
    const at = observedAt ?? this.now();
    const request = this.requests.get(key) ?? {
      started: false,
      durationMs: 0,
      ended: false,
      settled: false,
      invalid: false
    };
    this.observe(request, at);
    if (request.ended || request.settled || request.invalid || request.runningAt !== undefined)
      return false;
    request.started = true;
    request.runningAt = at;
    this.requests.set(key, request);
    return true;
  }

  pause(key: string, observedAt?: number): void {
    const request = this.requests.get(key);
    if (request === undefined || request.settled) return;
    const at = observedAt ?? this.now();
    this.observe(request, at);
    if (request.runningAt === undefined) return;
    const duration = at - request.runningAt;
    if (!(duration >= 0)) request.invalid = true;
    else request.durationMs += duration;
    request.runningAt = undefined;
  }

  end(key: string, observedAt?: number): void {
    const request = this.requests.get(key);
    if (request === undefined || request.settled || request.ended) return;
    this.pause(key, observedAt);
    request.ended = true;
  }

  settle(
    key: string,
    outputTokens: number,
    observedAt?: number
  ): GenerationTimingResult | undefined {
    const request = this.requests.get(key);
    if (
      request === undefined ||
      request.settled ||
      !request.started ||
      request.invalid ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    )
      return undefined;
    this.end(key, observedAt);
    request.settled = true;
    if (request.invalid || request.durationMs < 1) return undefined;
    return {
      outputTokens,
      durationMs: request.durationMs,
      tokensPerSecond: Math.round((outputTokens * 100_000) / request.durationMs) / 100
    };
  }

  discard(key: string): void {
    this.requests.delete(key);
  }

  has(key: string): boolean {
    return this.requests.has(key);
  }

  private observe(request: GenerationRequest, observedAt: number): void {
    if (
      !Number.isFinite(observedAt) ||
      (request.lastAt !== undefined && observedAt < request.lastAt)
    )
      request.invalid = true;
    if (Number.isFinite(observedAt)) request.lastAt = observedAt;
  }
}
