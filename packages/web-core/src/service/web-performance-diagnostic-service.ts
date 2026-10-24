import { ref, type Ref } from 'vue';

export type WebPerformanceHealth = 'idle' | 'healthy' | 'warning' | 'critical';
export type WebPerformanceConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface WebPerformanceContext {
  readonly view?: string;
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface WebPerformanceSnapshot {
  readonly connectionState: WebPerformanceConnectionState;
  readonly health: WebPerformanceHealth;
  readonly messagesPerSecond: number;
  readonly peakMessagesPerSecond: number;
  readonly kilobytesPerSecond: number;
  readonly categories: Readonly<Record<string, number>>;
  readonly activeRunSessions: number;
  readonly processing: {
    readonly averageMs: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly longTasks: {
    readonly available: boolean;
    readonly count: number;
    readonly totalDurationMs: number;
  };
  readonly eventLoopDelayMs: number;
  readonly pingLatencyMs?: number;
  readonly domNodes: number;
  readonly messageCards: number;
  readonly heap?: { readonly usedBytes: number; readonly limitBytes: number };
  readonly lastMessageAt?: number;
}

export interface WebPerformanceFrameSample {
  readonly bytes: number;
  readonly durationMs: number;
  readonly message: unknown;
}

interface TimedFrame extends WebPerformanceFrameSample {
  readonly at: number;
  readonly category: string;
  readonly context: WebPerformanceContext;
}

interface LongTaskSample {
  readonly at: number;
  readonly durationMs: number;
  readonly name: string;
  readonly context: WebPerformanceContext;
  readonly attribution: readonly WebPerformanceLongTaskAttribution[];
}

interface InteractionSample {
  readonly at: number;
  readonly name: string;
  readonly durationMs: number;
  readonly processingStartMs?: number;
  readonly processingEndMs?: number;
  readonly interactionId?: number;
  readonly target?: string;
  readonly context: WebPerformanceContext;
}

interface TimedBrowserMetric extends BrowserMetricUpdate {
  readonly at: number;
  readonly context: WebPerformanceContext;
}

export interface WebPerformanceLongTaskAttribution {
  readonly name: string;
  readonly entryType: string;
  readonly startTimeMs: number;
  readonly durationMs: number;
  readonly containerType?: string;
  readonly containerName?: string;
  readonly containerId?: string;
  readonly containerSrc?: string;
}

export interface WebPerformanceFrameDetail {
  readonly observedAtMs: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly category: string;
  readonly context: WebPerformanceContext;
}

export interface WebPerformanceInteractionDetail {
  readonly startTimeMs: number;
  readonly name: string;
  readonly durationMs: number;
  readonly processingStartMs?: number;
  readonly processingEndMs?: number;
  readonly interactionId?: number;
  readonly target?: string;
  readonly context: WebPerformanceContext;
}

export interface WebPerformanceBrowserSampleDetail extends BrowserMetricUpdate {
  readonly sampledAtMs: number;
  readonly context: WebPerformanceContext;
}

export interface WebPerformanceLongTaskDetail {
  readonly name: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly context: WebPerformanceContext;
  readonly attribution: readonly WebPerformanceLongTaskAttribution[];
  readonly relatedInteractions: readonly WebPerformanceInteractionDetail[];
  readonly relatedFrames: readonly WebPerformanceFrameDetail[];
}

export interface WebPerformanceLongAnimationFrameDetail {
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly blockingDurationMs: number;
  readonly context: WebPerformanceContext;
  readonly scripts: readonly {
    readonly functionName: string;
    readonly sourceURL: string;
    readonly sourceCharPosition: number;
    readonly durationMs: number;
    readonly invoker: string;
  }[];
}

export interface WebPerformanceDiagnosticDetail {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly windowMs: number;
  readonly context: WebPerformanceContext;
  readonly snapshot: WebPerformanceSnapshot;
  readonly longTasks: readonly WebPerformanceLongTaskDetail[];
  readonly retainedLongTasks: readonly WebPerformanceLongTaskDetail[];
  readonly longAnimationFrames: readonly WebPerformanceLongAnimationFrameDetail[];
  readonly interactions: readonly WebPerformanceInteractionDetail[];
  readonly frames: readonly WebPerformanceFrameDetail[];
  readonly browserSamples: readonly WebPerformanceBrowserSampleDetail[];
  readonly activeRuns: readonly { readonly runId: string; readonly sessionId: string }[];
  readonly browser: Readonly<Record<string, unknown>>;
}

export interface BrowserMetricUpdate {
  readonly domNodes: number;
  readonly messageCards: number;
  readonly eventLoopDelayMs: number;
  readonly heap?: { readonly usedBytes: number; readonly limitBytes: number };
  readonly longTasks: { readonly count: number; readonly totalDurationMs: number };
}

interface MemoryPerformance extends Performance {
  readonly memory?: { readonly usedJSHeapSize: number; readonly jsHeapSizeLimit: number };
}

interface RetainedRecord<T> {
  readonly capturedAt: number;
  readonly value: T;
}

const ACTIVE_RUN_STATUSES = new Set(['STARTING', 'RUNNING', 'CANCELLING']);
const FRAME_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 1_000;
const STARTUP_GRACE_MS = 5_000;
const SEVERE_TASK_MS = 500;
const RETAINED_TASK_WINDOW_MS = 30 * 60_000;
const RETAINED_TASK_LIMIT = 16;
const RETAINED_TASK_STORAGE_KEY = 'mar.web-performance.severe.v1';

const emptySnapshot = (): WebPerformanceSnapshot => ({
  connectionState: 'connecting',
  health: 'idle',
  messagesPerSecond: 0,
  peakMessagesPerSecond: 0,
  kilobytesPerSecond: 0,
  categories: {},
  activeRunSessions: 0,
  processing: { averageMs: 0, p95Ms: 0, maxMs: 0 },
  longTasks: { available: false, count: 0, totalDurationMs: 0 },
  eventLoopDelayMs: 0,
  domNodes: 0,
  messageCards: 0
});

export function createWebPerformanceDiagnostics(
  options: {
    readonly now?: () => number;
    readonly enabled?: () => boolean;
    readonly context?: () => WebPerformanceContext;
  } = {}
) {
  const now = options.now ?? (() => performance.now());
  const snapshot = ref<WebPerformanceSnapshot>(emptySnapshot());
  const frames: TimedFrame[] = [];
  const activeRuns = new Map<string, string>();
  const longTaskSamples: LongTaskSample[] = [];
  const interactionSamples: InteractionSample[] = [];
  const browserSamples: TimedBrowserMetric[] = [];
  const retained = loadRetained();
  const retainedLongTasks = retained.longTasks;
  const retainedAnimationFrames = retained.longAnimationFrames;
  let browserMetrics: BrowserMetricUpdate = {
    domNodes: 0,
    messageCards: 0,
    eventLoopDelayMs: 0,
    longTasks: { count: 0, totalDurationMs: 0 }
  };
  let connectionState: WebPerformanceConnectionState = 'connecting';
  let lastMessageAt: number | undefined;
  let pingLatencyMs: number | undefined;
  let samplingTimer: ReturnType<typeof setInterval> | undefined;
  let longTaskObserver: PerformanceObserver | undefined;
  let longAnimationFrameObserver: PerformanceObserver | undefined;
  let longTasksAvailable = false;
  let interactionObserver: PerformanceObserver | undefined;
  let expectedTick = 0;
  let startupGraceUntil = 0;

  function enabled(): boolean {
    return options.enabled?.() ?? true;
  }

  function context(): WebPerformanceContext {
    return options.context?.() ?? {};
  }

  function loadRetained(): {
    longTasks: RetainedRecord<WebPerformanceLongTaskDetail>[];
    longAnimationFrames: RetainedRecord<WebPerformanceLongAnimationFrameDetail>[];
  } {
    const empty = { longTasks: [], longAnimationFrames: [] };
    try {
      if (typeof sessionStorage === 'undefined') return empty;
      const stored: unknown = JSON.parse(
        sessionStorage.getItem(RETAINED_TASK_STORAGE_KEY) ?? 'null'
      );
      if (typeof stored !== 'object' || stored === null) return empty;
      const value = stored as Record<string, unknown>;
      const valid = <T>(input: unknown): RetainedRecord<T>[] =>
        Array.isArray(input)
          ? input
              .filter(
                (record): record is RetainedRecord<T> =>
                  typeof record === 'object' &&
                  record !== null &&
                  Number.isFinite((record as RetainedRecord<T>).capturedAt) &&
                  Date.now() - (record as RetainedRecord<T>).capturedAt <=
                    RETAINED_TASK_WINDOW_MS &&
                  typeof (record as RetainedRecord<T>).value === 'object' &&
                  (record as RetainedRecord<T>).value !== null
              )
              .slice(-RETAINED_TASK_LIMIT)
          : [];
      return {
        longTasks: valid<WebPerformanceLongTaskDetail>(value.longTasks),
        longAnimationFrames: valid<WebPerformanceLongAnimationFrameDetail>(
          value.longAnimationFrames
        )
      };
    } catch {
      return empty;
    }
  }

  function persistRetained(): void {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(
        RETAINED_TASK_STORAGE_KEY,
        JSON.stringify({
          longTasks: retainedLongTasks,
          longAnimationFrames: retainedAnimationFrames
        })
      );
    } catch {
      // Storage can be unavailable or full; the in-memory diagnostic remains available.
    }
  }

  function retain<T>(records: RetainedRecord<T>[], value: T): void {
    records.push({ capturedAt: Date.now(), value });
    if (records.length > RETAINED_TASK_LIMIT)
      records.splice(0, records.length - RETAINED_TASK_LIMIT);
    persistRetained();
  }

  function retainedValues<T>(records: readonly RetainedRecord<T>[]): T[] {
    return records
      .filter((record) => Date.now() - record.capturedAt <= RETAINED_TASK_WINDOW_MS)
      .map((record) => record.value);
  }

  function prune(at: number): void {
    while (frames[0] !== undefined && frames[0].at < at - FRAME_WINDOW_MS) frames.shift();
    while (longTaskSamples[0] !== undefined && longTaskSamples[0].at < at - FRAME_WINDOW_MS)
      longTaskSamples.shift();
    while (interactionSamples[0] !== undefined && interactionSamples[0].at < at - FRAME_WINDOW_MS)
      interactionSamples.shift();
    while (browserSamples[0] !== undefined && browserSamples[0].at < at - FRAME_WINDOW_MS)
      browserSamples.shift();
  }

  function health(processingP95Ms: number, at: number): WebPerformanceHealth {
    if (connectionState !== 'connected') return 'idle';
    if (at < startupGraceUntil) return 'healthy';
    const heapRatio =
      browserMetrics.heap === undefined || browserMetrics.heap.limitBytes <= 0
        ? 0
        : browserMetrics.heap.usedBytes / browserMetrics.heap.limitBytes;
    if (
      processingP95Ms >= 50 ||
      browserMetrics.longTasks.totalDurationMs >= 500 ||
      browserMetrics.eventLoopDelayMs >= 200 ||
      heapRatio >= 0.85
    )
      return 'critical';
    if (
      processingP95Ms >= 16 ||
      browserMetrics.longTasks.totalDurationMs >= 100 ||
      browserMetrics.eventLoopDelayMs >= 50 ||
      heapRatio >= 0.7
    )
      return 'warning';
    return 'healthy';
  }

  function refresh(): void {
    const at = now();
    prune(at);
    const recent = frames.filter((frame) => frame.at >= at - RATE_WINDOW_MS);
    const durations = frames.map((frame) => frame.durationMs).sort((left, right) => left - right);
    const durationTotal = durations.reduce((total, duration) => total + duration, 0);
    const categories: Record<string, number> = {};
    for (const frame of recent) categories[frame.category] = (categories[frame.category] ?? 0) + 1;
    const buckets = new Map<number, number>();
    for (const frame of frames) {
      const bucket = Math.floor(frame.at / RATE_WINDOW_MS);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
    const p95Ms = durations[p95Index] ?? 0;
    snapshot.value = {
      connectionState,
      health: health(p95Ms, at),
      messagesPerSecond: recent.length,
      peakMessagesPerSecond: Math.max(0, ...buckets.values()),
      kilobytesPerSecond:
        recent.reduce((total, frame) => total + Math.max(0, frame.bytes), 0) / 1_024,
      categories,
      activeRunSessions: new Set(activeRuns.values()).size,
      processing: {
        averageMs: durations.length === 0 ? 0 : durationTotal / durations.length,
        p95Ms,
        maxMs: durations.at(-1) ?? 0
      },
      longTasks: { ...browserMetrics.longTasks, available: longTasksAvailable },
      eventLoopDelayMs: browserMetrics.eventLoopDelayMs,
      ...(pingLatencyMs === undefined ? {} : { pingLatencyMs }),
      domNodes: browserMetrics.domNodes,
      messageCards: browserMetrics.messageCards,
      ...(browserMetrics.heap === undefined ? {} : { heap: browserMetrics.heap }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt })
    };
  }

  function frameCategory(message: unknown): string {
    if (typeof message !== 'object' || message === null) return 'other';
    const record = message as Record<string, unknown>;
    if (record.type === 'watch.event') return 'watch';
    if (typeof record.type === 'string' && record.type.startsWith('notification.'))
      return 'notification';
    if (record.type !== 'event' || typeof record.event !== 'object' || record.event === null)
      return 'control';
    const category = (record.event as Record<string, unknown>).category;
    return typeof category === 'string' ? category : 'other';
  }

  function observeRun(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const event = (message as Record<string, unknown>).event;
    if (typeof event !== 'object' || event === null) return;
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.category !== 'run') return;
    const payload = eventRecord.payload;
    if (typeof payload !== 'object' || payload === null) return;
    const run = (payload as Record<string, unknown>).run;
    if (typeof run !== 'object' || run === null) return;
    const value = run as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.status !== 'string'
    )
      return;
    if (ACTIVE_RUN_STATUSES.has(value.status)) activeRuns.set(value.id, value.sessionId);
    else activeRuns.delete(value.id);
  }

  function observeFrame(sample: WebPerformanceFrameSample): void {
    if (!enabled()) return;
    const at = now();
    frames.push({ ...sample, at, category: frameCategory(sample.message), context: context() });
    lastMessageAt = Date.now();
    observeRun(sample.message);
  }

  function setConnectionState(next: WebPerformanceConnectionState): void {
    connectionState = next;
    if (next !== 'connected') {
      activeRuns.clear();
      pingLatencyMs = undefined;
    }
    refresh();
  }

  function resetActiveRuns(): void {
    activeRuns.clear();
    refresh();
  }

  function setPingLatency(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    pingLatencyMs = Math.max(0, durationMs);
    refresh();
  }

  function updateBrowserMetrics(update: BrowserMetricUpdate): void {
    browserMetrics = update;
    browserSamples.push({ ...update, at: now(), context: context() });
    refresh();
  }

  function collectBrowserMetrics(delayMs: number): void {
    const memory = (performance as MemoryPerformance).memory;
    const at = now();
    prune(at);
    browserMetrics = {
      domNodes: document.getElementsByTagName('*').length,
      messageCards: document.querySelectorAll('.conversation-item').length,
      eventLoopDelayMs: Math.max(0, delayMs),
      longTasks: {
        count: longTaskSamples.length,
        totalDurationMs: longTaskSamples.reduce((total, sample) => total + sample.durationMs, 0)
      },
      ...(memory === undefined
        ? {}
        : { heap: { usedBytes: memory.usedJSHeapSize, limitBytes: memory.jsHeapSizeLimit } })
    };
    browserSamples.push({ ...browserMetrics, at, context: context() });
    refresh();
  }

  function longTaskAttribution(entry: PerformanceEntry): WebPerformanceLongTaskAttribution[] {
    const values = (entry as PerformanceEntry & { readonly attribution?: readonly unknown[] })
      .attribution;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (typeof value !== 'object' || value === null) return [];
      const record = value as Record<string, unknown>;
      const optional = (key: string): string | undefined =>
        typeof record[key] === 'string' && record[key] !== '' ? record[key] : undefined;
      const containerType = optional('containerType');
      const containerName = optional('containerName');
      const containerId = optional('containerId');
      const rawContainerSrc = optional('containerSrc');
      let containerSrc: string | undefined;
      if (rawContainerSrc !== undefined) {
        try {
          const url = new URL(
            rawContainerSrc,
            typeof location === 'undefined' ? undefined : location.href
          );
          containerSrc = `${url.origin}${url.pathname}`;
        } catch {
          containerSrc = undefined;
        }
      }
      return [
        {
          name: optional('name') ?? '',
          entryType: optional('entryType') ?? '',
          startTimeMs: typeof record.startTime === 'number' ? record.startTime : 0,
          durationMs: typeof record.duration === 'number' ? record.duration : 0,
          ...(containerType === undefined ? {} : { containerType }),
          ...(containerName === undefined ? {} : { containerName }),
          ...(containerId === undefined ? {} : { containerId }),
          ...(containerSrc === undefined ? {} : { containerSrc })
        }
      ];
    });
  }

  function interactionTarget(entry: PerformanceEntry): string | undefined {
    const target = (entry as PerformanceEntry & { readonly target?: EventTarget | null }).target;
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return undefined;
    const id = target.id === '' ? '' : `#${target.id}`;
    const classes = [...target.classList]
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join('');
    return `${target.tagName.toLowerCase()}${id}${classes}`;
  }

  function browserEnvironment(): Readonly<Record<string, unknown>> {
    const navigatorValue = typeof navigator === 'undefined' ? undefined : navigator;
    return {
      performanceTimeOrigin:
        typeof performance === 'undefined' ? undefined : performance.timeOrigin,
      visibility: typeof document === 'undefined' ? undefined : document.visibilityState,
      pathname: typeof location === 'undefined' ? undefined : location.pathname,
      viewport:
        typeof window === 'undefined'
          ? undefined
          : {
              width: window.innerWidth,
              height: window.innerHeight,
              devicePixelRatio: window.devicePixelRatio
            },
      userAgent: navigatorValue?.userAgent,
      language: navigatorValue?.language,
      hardwareConcurrency: navigatorValue?.hardwareConcurrency
    };
  }

  function longTaskDetail(task: LongTaskSample): WebPerformanceLongTaskDetail {
    const interactions = interactionSamples.map(({ at: startTimeMs, ...sample }) => ({
      startTimeMs,
      ...sample
    }));
    const frameDetails = frames.map(
      ({ at: observedAtMs, bytes, durationMs, category, context }) => ({
        observedAtMs,
        bytes,
        durationMs,
        category,
        context
      })
    );
    return {
      name: task.name,
      startTimeMs: task.at,
      endTimeMs: task.at + task.durationMs,
      occurredAt: new Date(performance.timeOrigin + task.at).toISOString(),
      durationMs: task.durationMs,
      context: task.context,
      attribution: task.attribution,
      relatedInteractions: interactions.filter(
        (interaction) =>
          interaction.startTimeMs <= task.at + task.durationMs + 250 &&
          interaction.startTimeMs + interaction.durationMs >= task.at - 250
      ),
      relatedFrames: frameDetails.filter(
        (frame) =>
          frame.observedAtMs >= task.at - 250 &&
          frame.observedAtMs <= task.at + task.durationMs + 250
      )
    };
  }

  function animationFrameScripts(
    entry: PerformanceEntry
  ): WebPerformanceLongAnimationFrameDetail['scripts'] {
    const scripts = (entry as PerformanceEntry & { readonly scripts?: readonly unknown[] }).scripts;
    if (!Array.isArray(scripts)) return [];
    return scripts.slice(0, 8).map((script) => {
      const record = (typeof script === 'object' && script !== null ? script : {}) as Record<
        string,
        unknown
      >;
      const text = (key: string): string =>
        typeof record[key] === 'string' ? (record[key] as string).slice(0, 256) : '';
      let sourceURL = '';
      try {
        const url = new URL(
          text('sourceURL'),
          typeof location === 'undefined' ? undefined : location.href
        );
        sourceURL = `${url.origin}${url.pathname}`;
      } catch {
        // Ignore malformed or unavailable script URLs.
      }
      return {
        functionName: text('sourceFunctionName'),
        sourceURL,
        sourceCharPosition:
          typeof record.sourceCharPosition === 'number' ? record.sourceCharPosition : 0,
        durationMs: typeof record.duration === 'number' ? record.duration : 0,
        invoker: text('invoker')
      };
    });
  }

  function detail(): WebPerformanceDiagnosticDetail {
    const at = now();
    prune(at);
    const frameDetails = frames.map(
      ({ at: observedAtMs, bytes, durationMs, category, context }) => ({
        observedAtMs,
        bytes,
        durationMs,
        category,
        context
      })
    );
    const interactionDetails = interactionSamples.map(({ at: startTimeMs, ...sample }) => ({
      startTimeMs,
      ...sample
    }));
    const longTasks = longTaskSamples.map(longTaskDetail);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      windowMs: FRAME_WINDOW_MS,
      context: context(),
      snapshot: snapshot.value,
      longTasks,
      retainedLongTasks: retainedValues(retainedLongTasks),
      longAnimationFrames: retainedValues(retainedAnimationFrames),
      interactions: interactionDetails,
      frames: frameDetails,
      browserSamples: browserSamples.map(({ at: sampledAtMs, ...sample }) => ({
        sampledAtMs,
        ...sample
      })),
      activeRuns: [...activeRuns].map(([runId, sessionId]) => ({ runId, sessionId })),
      browser: browserEnvironment()
    };
  }

  function start(): void {
    if (!enabled() || samplingTimer !== undefined) return;
    startupGraceUntil = now() + STARTUP_GRACE_MS;
    expectedTick = now() + RATE_WINDOW_MS;
    samplingTimer = setInterval(() => {
      const at = now();
      if (document.hidden || !enabled()) {
        expectedTick = at + RATE_WINDOW_MS;
        return;
      }
      collectBrowserMetrics(at - expectedTick);
      expectedTick = at + RATE_WINDOW_MS;
    }, RATE_WINDOW_MS);
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
          longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.startTime < startupGraceUntil) continue;
              const sample = {
                at: entry.startTime,
                durationMs: entry.duration,
                name: entry.name,
                context: context(),
                attribution: longTaskAttribution(entry)
              };
              longTaskSamples.push(sample);
              if (entry.duration >= SEVERE_TASK_MS) {
                retain(retainedLongTasks, longTaskDetail(sample));
              }
            }
          });
          longTaskObserver.observe({ entryTypes: ['longtask'] });
          longTasksAvailable = true;
        }
      } catch {
        longTaskObserver?.disconnect();
        longTaskObserver = undefined;
      }
      try {
        interactionObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const record = entry as PerformanceEntry & {
              readonly processingStart?: number;
              readonly processingEnd?: number;
              readonly interactionId?: number;
            };
            const target = interactionTarget(entry);
            interactionSamples.push({
              at: entry.startTime,
              name: entry.name,
              durationMs: entry.duration,
              ...(typeof record.processingStart === 'number'
                ? { processingStartMs: record.processingStart }
                : {}),
              ...(typeof record.processingEnd === 'number'
                ? { processingEndMs: record.processingEnd }
                : {}),
              ...(typeof record.interactionId === 'number'
                ? { interactionId: record.interactionId }
                : {}),
              ...(target === undefined ? {} : { target }),
              context: context()
            });
          }
        });
        interactionObserver.observe({
          type: 'event',
          buffered: true,
          durationThreshold: 16
        } as PerformanceObserverInit & { readonly durationThreshold: number });
      } catch {
        interactionObserver = undefined;
      }
      try {
        if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
          longAnimationFrameObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration < SEVERE_TASK_MS) continue;
              const frame = entry as PerformanceEntry & { readonly blockingDuration?: number };
              retain(retainedAnimationFrames, {
                startTimeMs: entry.startTime,
                endTimeMs: entry.startTime + entry.duration,
                occurredAt: new Date(performance.timeOrigin + entry.startTime).toISOString(),
                durationMs: entry.duration,
                blockingDurationMs: frame.blockingDuration ?? 0,
                context: context(),
                scripts: animationFrameScripts(entry)
              });
            }
          });
          longAnimationFrameObserver.observe({ type: 'long-animation-frame' });
        }
      } catch {
        longAnimationFrameObserver = undefined;
      }
    }
    collectBrowserMetrics(0);
  }

  function dispose(): void {
    if (samplingTimer !== undefined) clearInterval(samplingTimer);
    samplingTimer = undefined;
    longTaskObserver?.disconnect();
    longTaskObserver = undefined;
    longTasksAvailable = false;
    longAnimationFrameObserver?.disconnect();
    longAnimationFrameObserver = undefined;
    interactionObserver?.disconnect();
    interactionObserver = undefined;
    frames.length = 0;
    activeRuns.clear();
    longTaskSamples.length = 0;
    interactionSamples.length = 0;
    browserSamples.length = 0;
    browserMetrics = {
      domNodes: 0,
      messageCards: 0,
      eventLoopDelayMs: 0,
      longTasks: { count: 0, totalDurationMs: 0 }
    };
    lastMessageAt = undefined;
    pingLatencyMs = undefined;
    refresh();
  }

  return {
    snapshot: snapshot as Readonly<Ref<WebPerformanceSnapshot>>,
    observeFrame,
    setConnectionState,
    resetActiveRuns,
    setPingLatency,
    updateBrowserMetrics,
    detail,
    refresh,
    start,
    dispose
  };
}
