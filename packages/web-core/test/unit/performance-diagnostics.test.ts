import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPerformanceDiagnostics } from '../../src/service/web-performance-diagnostic-service.js';
import { installPerformanceObserver } from './support/performance-observer-fixture.js';

describe('WebPerformanceDiagnosticService', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('Long Task collection availability', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      vi.stubGlobal('document', {
        hidden: false,
        getElementsByTagName: () => [],
        querySelectorAll: () => []
      });
    });
    afterEach(() => vi.useRealTimers());

    it.each(['missing', 'unsupported', 'constructor', 'observe'] as const)(
      'exports unavailable collection without changing overall health when observer is %s',
      (mode) => {
        const observer = installPerformanceObserver({
          supportedEntryTypes: mode === 'unsupported' ? ['event'] : ['longtask', 'event'],
          ...(mode === 'constructor' || mode === 'observe' ? { failure: mode } : {})
        });
        if (mode === 'missing') vi.stubGlobal('PerformanceObserver', undefined);
        const diagnostics = createWebPerformanceDiagnostics({ now: () => Date.now() });
        try {
          expect(diagnostics.snapshot.value.longTasks).toMatchObject({ available: false });
          diagnostics.start();
          diagnostics.setConnectionState('connected');
          vi.advanceTimersByTime(6_000);
          expect(diagnostics.snapshot.value.longTasks).toEqual({
            available: false,
            count: 0,
            totalDurationMs: 0
          });
          expect(diagnostics.snapshot.value.health).toBe('healthy');
          const exported = JSON.parse(JSON.stringify(diagnostics.detail()));
          expect(exported.snapshot.longTasks.available).toBe(false);
          expect(exported.longTasks).toEqual([]);
          if (mode === 'unsupported') {
            expect(observer.observe).not.toHaveBeenCalledWith({ entryTypes: ['longtask'] });
            expect(observer.callbacks.has('event')).toBe(true);
          }
          if (mode === 'observe') expect(observer.disconnect).toHaveBeenCalledOnce();
        } finally {
          diagnostics.dispose();
        }
      }
    );

    it('distinguishes an available empty window from samples and resets availability and samples across restarts', () => {
      const observer = installPerformanceObserver();
      const diagnostics = createWebPerformanceDiagnostics({ now: () => Date.now() });
      try {
        diagnostics.start();
        diagnostics.setConnectionState('connected');
        expect(diagnostics.snapshot.value.longTasks).toEqual({
          available: true,
          count: 0,
          totalDurationMs: 0
        });
        observer.callbacks.get('longtask')?.([
          { name: 'warmup', startTime: 2_000, duration: 900 } as PerformanceEntry,
          { name: 'self', startTime: 6_500, duration: 120 } as PerformanceEntry
        ]);
        vi.advanceTimersByTime(6_000);
        expect(diagnostics.snapshot.value.longTasks).toEqual({
          available: true,
          count: 1,
          totalDurationMs: 120
        });
        expect(diagnostics.snapshot.value.health).toBe('warning');
        expect(diagnostics.detail().longTasks.map((task) => task.name)).toEqual(['self']);
        expect(JSON.parse(JSON.stringify(diagnostics.detail())).snapshot.longTasks.available).toBe(
          true
        );
        vi.advanceTimersByTime(10_001);
        expect(diagnostics.snapshot.value.longTasks).toEqual({
          available: true,
          count: 0,
          totalDurationMs: 0
        });
        observer.callbacks.get('longtask')?.([
          { name: 'before-dispose', startTime: Date.now(), duration: 80 } as PerformanceEntry
        ]);
        vi.advanceTimersByTime(1_000);
        expect(diagnostics.snapshot.value.longTasks.count).toBe(1);
        diagnostics.dispose();
        expect(diagnostics.snapshot.value.longTasks).toEqual({
          available: false,
          count: 0,
          totalDurationMs: 0
        });
        expect(diagnostics.detail().longTasks).toEqual([]);
        expect(diagnostics.detail().browserSamples).toEqual([]);
        vi.stubGlobal('PerformanceObserver', undefined);
        diagnostics.start();
        expect(diagnostics.snapshot.value.longTasks).toMatchObject({ available: false, count: 0 });
        diagnostics.dispose();
        installPerformanceObserver();
        diagnostics.start();
        expect(diagnostics.snapshot.value.longTasks).toEqual({
          available: true,
          count: 0,
          totalDurationMs: 0
        });
        expect(diagnostics.detail().longTasks).toEqual([]);
      } finally {
        diagnostics.dispose();
      }
    });

    it('retains severe Long Tasks beyond the live window and a page reload', () => {
      const stored = new Map<string, string>();
      vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value)
      });
      const observer = installPerformanceObserver();
      const diagnostics = createWebPerformanceDiagnostics({ now: () => Date.now() });
      diagnostics.start();
      vi.advanceTimersByTime(6_000);
      observer.callbacks.get('longtask')?.([
        { name: 'severe', startTime: 7_000, duration: 900 } as PerformanceEntry,
        { name: 'ordinary', startTime: 7_001, duration: 120 } as PerformanceEntry
      ]);
      expect(diagnostics.detail().retainedLongTasks.map((task) => task.name)).toEqual(['severe']);

      vi.advanceTimersByTime(11_000);
      expect(diagnostics.detail().longTasks).toEqual([]);
      expect(diagnostics.detail().retainedLongTasks.map((task) => task.name)).toEqual(['severe']);
      diagnostics.dispose();

      const restored = createWebPerformanceDiagnostics({ now: () => Date.now() });
      expect(restored.detail().retainedLongTasks.map((task) => task.name)).toEqual(['severe']);
      restored.dispose();
      vi.advanceTimersByTime(30 * 60_000 + 1);
      const expired = createWebPerformanceDiagnostics({ now: () => Date.now() });
      expect(expired.detail().retainedLongTasks).toEqual([]);
      expired.dispose();
    });

    it('retains severe animation frames with bounded script attribution and sanitized URLs', () => {
      const stored = new Map<string, string>();
      vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value)
      });
      const observer = installPerformanceObserver({
        supportedEntryTypes: ['longtask', 'event', 'long-animation-frame']
      });
      const diagnostics = createWebPerformanceDiagnostics({
        now: () => Date.now(),
        context: () => ({ view: 'nodes', sessionId: 'session-1' })
      });
      diagnostics.start();
      vi.advanceTimersByTime(6_000);
      observer.callbacks.get('long-animation-frame')?.([
        {
          name: 'long-animation-frame',
          startTime: 7_000,
          duration: 850,
          blockingDuration: 600,
          scripts: Array.from({ length: 12 }, (_, index) => ({
            sourceFunctionName: `render-${index}`,
            sourceURL: `https://console.example/assets/index-${index}.js?private=query`,
            sourceCharPosition: index,
            duration: 500,
            invoker: 'requestAnimationFrame'
          }))
        } as unknown as PerformanceEntry
      ]);

      const frames = diagnostics.detail().longAnimationFrames;
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        durationMs: 850,
        blockingDurationMs: 600,
        context: { view: 'nodes', sessionId: 'session-1' }
      });
      expect(frames[0]?.scripts).toHaveLength(8);
      expect(frames[0]?.scripts[0]).toEqual({
        functionName: 'render-0',
        sourceURL: 'https://console.example/assets/index-0.js',
        sourceCharPosition: 0,
        durationMs: 500,
        invoker: 'requestAnimationFrame'
      });
      diagnostics.dispose();
      const restored = createWebPerformanceDiagnostics({ now: () => Date.now() });
      expect(restored.detail().longAnimationFrames).toEqual(frames);
      restored.dispose();
    });

    it('bounds retained history and tolerates malformed or unavailable storage', () => {
      vi.stubGlobal('sessionStorage', {
        getItem: () => '{malformed',
        setItem: () => {
          throw new Error('storage unavailable');
        }
      });
      const observer = installPerformanceObserver();
      const diagnostics = createWebPerformanceDiagnostics({ now: () => Date.now() });
      diagnostics.start();
      vi.advanceTimersByTime(6_000);
      for (let index = 0; index < 20; index += 1) {
        observer.callbacks.get('longtask')?.([
          {
            name: `severe-${index}`,
            startTime: 7_000 + index * 1_000,
            duration: 600
          } as PerformanceEntry
        ]);
      }
      const retained = diagnostics.detail().retainedLongTasks;
      expect(retained).toHaveLength(16);
      expect(retained[0]?.name).toBe('severe-4');
      expect(retained[15]?.name).toBe('severe-19');
      diagnostics.dispose();
    });
  });

  it('Statistics of real-time throughput and categories by scrolling window', () => {
    let now = 10_000;
    const diagnostics = createWebPerformanceDiagnostics({ now: () => now });

    diagnostics.observeFrame({
      bytes: 1_024,
      durationMs: 4,
      message: { type: 'event', event: { nodeId: 'node-1', sequence: 1, category: 'conversation' } }
    });
    diagnostics.observeFrame({
      bytes: 512,
      durationMs: 8,
      message: { type: 'watch.event', event: {} }
    });
    diagnostics.refresh();

    expect(diagnostics.snapshot.value.messagesPerSecond).toBe(2);
    expect(diagnostics.snapshot.value.kilobytesPerSecond).toBe(1.5);
    expect(diagnostics.snapshot.value.categories).toMatchObject({ conversation: 1, watch: 1 });
    expect(diagnostics.snapshot.value.processing.averageMs).toBe(6);
    expect(diagnostics.snapshot.value.processing.p95Ms).toBe(8);

    now += 1_100;
    diagnostics.refresh();
    expect(diagnostics.snapshot.value.messagesPerSecond).toBe(0);
    expect(diagnostics.snapshot.value.peakMessagesPerSecond).toBe(2);
  });

  it('Record round-trip latency for Workbench WebSocket pings', () => {
    const diagnostics = createWebPerformanceDiagnostics({ now: () => 1_000 });

    diagnostics.setPingLatency(37.4);

    expect(diagnostics.snapshot.value.pingLatencyMs).toBe(37.4);
    expect(diagnostics.detail().snapshot.pingLatencyMs).toBe(37.4);

    diagnostics.setConnectionState('disconnected');
    expect(diagnostics.snapshot.value.pingLatencyMs).toBeUndefined();
  });

  it('deduplicates active Runs by Session across Node callbacks and clears them on connection failure', () => {
    const diagnostics = createWebPerformanceDiagnostics({ now: () => 1_000 });
    const frame = (id: string, sessionId: string, status: string, nodeId: string) => ({
      bytes: 100,
      durationMs: 1,
      message: {
        type: 'event',
        event: {
          nodeId,
          sequence: 1,
          category: 'run',
          payload: { run: { id, sessionId, status } }
        }
      }
    });

    diagnostics.observeFrame(frame('run-1', 'session-1', 'RUNNING', 'node-1'));
    diagnostics.observeFrame(frame('run-2', 'session-1', 'STARTING', 'node-1'));
    diagnostics.observeFrame(frame('run-3', 'session-2', 'CANCELLING', 'node-2'));
    diagnostics.refresh();
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(2);

    diagnostics.observeFrame(frame('run-1', 'session-1', 'SUCCEEDED', 'node-1'));
    diagnostics.refresh();
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(2);
    diagnostics.observeFrame(frame('run-2', 'session-1', 'FAILED', 'node-1'));
    diagnostics.refresh();
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(1);

    diagnostics.setConnectionState('disconnected');
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(0);
    expect(diagnostics.snapshot.value.connectionState).toBe('disconnected');
  });

  it('Clean up live samples and active Runs when stopping desktop sampling to avoid displaying old status after the mobile end is switched back', () => {
    const diagnostics = createWebPerformanceDiagnostics({ now: () => 1_000 });
    diagnostics.observeFrame({
      bytes: 100,
      durationMs: 2,
      message: {
        type: 'event',
        event: {
          category: 'run',
          payload: { run: { id: 'run-1', sessionId: 'session-1', status: 'RUNNING' } }
        }
      }
    });
    diagnostics.refresh();
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(1);

    diagnostics.dispose();
    expect(diagnostics.snapshot.value.activeRunSessions).toBe(0);
    expect(diagnostics.snapshot.value.messagesPerSecond).toBe(0);
    expect(diagnostics.snapshot.value.lastMessageAt).toBeUndefined();
  });

  it('Status is only determined based on processing blocking, long tasks, main thread latency and memory pressure', () => {
    const diagnostics = createWebPerformanceDiagnostics({ now: () => 1_000 });
    diagnostics.setConnectionState('connected');
    diagnostics.updateBrowserMetrics({
      domNodes: 500,
      messageCards: 20,
      eventLoopDelayMs: 60,
      heap: { usedBytes: 75, limitBytes: 100 },
      longTasks: { count: 1, totalDurationMs: 120 }
    });
    expect(diagnostics.snapshot.value.health).toBe('warning');

    diagnostics.updateBrowserMetrics({
      domNodes: 500,
      messageCards: 20,
      eventLoopDelayMs: 220,
      heap: { usedBytes: 90, limitBytes: 100 },
      longTasks: { count: 2, totalDurationMs: 600 }
    });
    expect(diagnostics.snapshot.value.health).toBe('critical');
  });

  it('Do not judge the blocking of the page start preheating stage as an abnormal runtime', () => {
    let now = 1_000;
    vi.stubGlobal('document', {
      hidden: false,
      getElementsByTagName: () => [],
      querySelectorAll: () => []
    });
    const diagnostics = createWebPerformanceDiagnostics({ now: () => now });
    diagnostics.start();
    diagnostics.setConnectionState('connected');
    diagnostics.updateBrowserMetrics({
      domNodes: 1_000,
      messageCards: 20,
      eventLoopDelayMs: 250,
      longTasks: { count: 3, totalDurationMs: 600 }
    });
    expect(diagnostics.snapshot.value.health).toBe('healthy');

    now += 5_001;
    diagnostics.updateBrowserMetrics({
      domNodes: 1_000,
      messageCards: 20,
      eventLoopDelayMs: 250,
      longTasks: { count: 3, totalDurationMs: 600 }
    });
    expect(diagnostics.snapshot.value.health).toBe('critical');
    diagnostics.dispose();
  });

  it('Export individual Long Tasks, associated interactions, live frames, and page contexts instead of just copying card rollups', () => {
    let now = 1_000;
    const observerCallbacks = new Map<string, (entries: PerformanceEntry[]) => void>();
    class FakePerformanceObserver {
      static supportedEntryTypes = ['longtask', 'event'];
      constructor(
        private readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void
      ) {}
      observe(options: { entryTypes?: string[]; type?: string }): void {
        const type = options.type ?? options.entryTypes?.[0];
        if (type !== undefined)
          observerCallbacks.set(type, (entries) => this.callback({ getEntries: () => entries }));
      }
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    vi.stubGlobal('document', {
      hidden: false,
      visibilityState: 'visible',
      getElementsByTagName: () => [],
      querySelectorAll: () => []
    });
    const diagnostics = createWebPerformanceDiagnostics({
      now: () => now,
      context: () => ({
        view: 'NODES',
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1'
      })
    });
    diagnostics.start();
    now = 7_200;
    observerCallbacks.get('event')?.([
      {
        name: 'click',
        entryType: 'event',
        startTime: 7_010,
        duration: 72,
        processingStart: 7_012,
        processingEnd: 7_080,
        interactionId: 42
      } as unknown as PerformanceEntry
    ]);
    observerCallbacks.get('longtask')?.([
      {
        name: 'self',
        entryType: 'longtask',
        startTime: 7_020,
        duration: 61,
        attribution: [
          {
            name: 'script',
            entryType: 'taskattribution',
            startTime: 7_020,
            duration: 61,
            containerType: 'window',
            containerName: 'Workbench',
            containerId: 'app',
            containerSrc: ''
          }
        ]
      } as unknown as PerformanceEntry
    ]);
    diagnostics.observeFrame({
      bytes: 512,
      durationMs: 4,
      message: { type: 'event', event: { category: 'conversation' } }
    });
    diagnostics.updateBrowserMetrics({
      domNodes: 2_500,
      messageCards: 20,
      eventLoopDelayMs: 18,
      heap: { usedBytes: 100, limitBytes: 1_000 },
      longTasks: { count: 1, totalDurationMs: 61 }
    });

    const detail = diagnostics.detail();
    expect(detail.schemaVersion).toBe(1);
    expect(detail.context).toEqual({
      view: 'NODES',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1'
    });
    expect(detail.longTasks).toEqual([
      expect.objectContaining({
        startTimeMs: 7_020,
        durationMs: 61,
        context: expect.objectContaining({ workspaceId: 'workspace-1' }),
        attribution: [expect.objectContaining({ containerId: 'app' })]
      })
    ]);
    expect(detail.interactions).toEqual([
      expect.objectContaining({
        startTimeMs: 7_010,
        name: 'click',
        durationMs: 72,
        interactionId: 42
      })
    ]);
    expect(detail.frames).toEqual([
      expect.objectContaining({
        observedAtMs: 7_200,
        category: 'conversation',
        bytes: 512,
        durationMs: 4
      })
    ]);
    expect(detail.frames[0]).not.toHaveProperty('message');
    expect(detail.longTasks[0]?.relatedFrames[0]).not.toHaveProperty('message');
    expect(detail.browserSamples.at(-1)).toEqual(
      expect.objectContaining({ sampledAtMs: 7_200, domNodes: 2_500, eventLoopDelayMs: 18 })
    );
    diagnostics.dispose();
  });
});
