import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchLiveService } from '../../src/service/workbench-live-service.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe('Public Workbench Real-Time Connection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares readiness until the handshake, waits across reconnects, and cancels on close', async () => {
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });
    const ready = (socket: FakeWebSocket, id: string) =>
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'workbench.ready',
            workbenchConnectionId: id,
            workbenchResumeToken: `token-${id}`
          })
        })
      );
    try {
      service.connect();
      const initial = service.waitForReady();
      expect(service.waitForReady()).toBe(initial);
      const completed = vi.fn();
      void initial.then(completed);
      FakeWebSocket.instances[0]!.dispatchEvent(new Event('open'));
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
      ready(FakeWebSocket.instances[0]!, 'connection-1');
      await expect(initial).resolves.toBe(true);
      await expect(service.waitForReady()).resolves.toBe(true);

      service.reconnect();
      const replacement = service.waitForReady();
      const resumed = vi.fn();
      void replacement.then(resumed);
      ready(FakeWebSocket.instances[0]!, 'stale-connection');
      await Promise.resolve();
      expect(resumed).not.toHaveBeenCalled();
      FakeWebSocket.instances[1]!.dispatchEvent(new Event('open'));
      ready(FakeWebSocket.instances[1]!, 'connection-2');
      await expect(replacement).resolves.toBe(true);

      service.reconnect();
      const cancelled = service.waitForReady();
      service.close();
      await expect(cancelled).resolves.toBe(false);
      service.connect();
      const reopened = service.waitForReady();
      expect(reopened).not.toBe(cancelled);
      FakeWebSocket.instances[3]!.dispatchEvent(new Event('open'));
      ready(FakeWebSocket.instances[3]!, 'connection-3');
      await expect(reopened).resolves.toBe(true);
    } finally {
      service.close();
    }
  });

  it('sends and receives only strict direct-transfer control frames on the ready socket', () => {
    const sent: string[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instance: FakeWebSocket;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instance = this;
      }
      send(value: string): void {
        sent.push(value);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const onDirectMessage = vi.fn();
    const onInvalidMessage = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage,
      onDirectMessage
    });
    service.connect();
    FakeWebSocket.instance.dispatchEvent(new Event('open'));
    expect(
      service.sendDirect({
        type: 'direct.prepare',
        requestId: 'request-0001',
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        purpose: 'TRANSPORT'
      })
    ).toBe(false);
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'resume-token-1'
        })
      })
    );
    expect(
      service.sendDirect({
        type: 'direct.prepare',
        requestId: 'request-0001',
        nodeId: 'node-1',
        nodeGeneration: 'generation-1',
        purpose: 'TRANSPORT'
      })
    ).toBe(true);
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'direct.prepared',
          requestId: 'request-0001',
          directSessionId: 'session-0001',
          nodeId: 'node-1',
          nodeGeneration: 'generation-1',
          purpose: 'TRANSPORT',
          expiresAt: Date.now() + 60_000
        })
      })
    );
    expect(onDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct.prepared', directSessionId: 'session-0001' })
    );
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'direct.prepared', directSessionId: 'bad' })
      })
    );
    expect(onInvalidMessage).toHaveBeenCalled();
    service.close();
  });

  it('Project a Node takeover reason as an independent prompt event', () => {
    const sent: string[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instance: FakeWebSocket;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instance = this;
      }
      send(value: string): void {
        sent.push(value);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    vi.stubGlobal('sessionStorage', memoryStorage());
    const onNodeConnection = vi.fn();
    const onNodeReplaced = vi.fn();
    const onResyncRequired = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired,
      onNodeConnection,
      onNodeReplaced,
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });
    service.connect();
    FakeWebSocket.instance.dispatchEvent(new Event('open'));
    expect(sent).toEqual([JSON.stringify({ type: 'resume' })]);
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'node',
          nodeId: 'node-a',
          connected: true,
          reason: 'CONNECTION_REPLACED'
        })
      })
    );
    expect(onNodeConnection).toHaveBeenCalledWith('node-a', true);
    expect(onNodeReplaced).toHaveBeenCalledWith('node-a');
    expect(onResyncRequired).toHaveBeenCalledWith('node-a');
    service.close();
  });

  it('Record latency with an application-layer ping after the live channel is ready', () => {
    const sent: string[] = [];
    let now = 100;
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instance: FakeWebSocket;
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instance = this;
      }
      send(value: string): void {
        sent.push(value);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    vi.stubGlobal('performance', { now: () => now });
    const setPingLatency = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn(),
      diagnostics: {
        observeFrame: vi.fn(),
        setConnectionState: vi.fn(),
        resetActiveRuns: vi.fn(),
        setPingLatency
      }
    });
    service.connect();
    FakeWebSocket.instance.dispatchEvent(new Event('open'));
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'resume-1'
        })
      })
    );
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: 'ping', id: '1' });

    now = 137;
    FakeWebSocket.instance.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ type: 'pong', id: '1' }) })
    );
    expect(setPingLatency).toHaveBeenCalledWith(37);
    service.close();
  });

  it('Reconnect proactively when the real-time channel misses a pong before the next heartbeat', async () => {
    vi.useFakeTimers();
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.OPEN;
      readonly send = vi.fn();
      readonly close = vi.fn();
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect: vi.fn(),
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });
    service.connect();
    const first = FakeWebSocket.instances[0]!;
    first.dispatchEvent(new Event('open'));
    first.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'resume-1'
        })
      })
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(first.close).toHaveBeenCalledWith(4000, 'PAGE_VISIBLE_RECONNECT');
    expect(FakeWebSocket.instances).toHaveLength(2);
    service.close();
  });

  it('Trigger one authoritative resynchronization after a successful reconnect', async () => {
    vi.useFakeTimers();
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const onReconnect = vi.fn();
    const onConnectionRestored = vi.fn();
    const onDisconnected = vi.fn();
    const onEvent = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent,
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect,
      onConnectionRestored,
      onDisconnected,
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });

    service.connect();
    expect(service.connected.value).toBe(false);
    FakeWebSocket.instances[0]?.dispatchEvent(new Event('open'));
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'token-1',
          resumed: false
        })
      })
    );
    expect(service.connected.value).toBe(true);
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'event',
          event: { nodeId: 'node-1', sequence: 9, category: 'run', payload: {} }
        })
      })
    );
    FakeWebSocket.instances[0]?.dispatchEvent(new CloseEvent('close'));
    expect(service.connected.value).toBe(false);
    expect(onDisconnected).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[1]?.dispatchEvent(new Event('open'));
    expect(service.connected.value).toBe(false);
    FakeWebSocket.instances[1]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'token-1',
          resumed: true
        })
      })
    );
    expect(service.connected.value).toBe(true);
    FakeWebSocket.instances[1]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'event',
          event: { nodeId: 'node-1', sequence: 1, category: 'run', payload: {} }
        })
      })
    );

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onConnectionRestored).toHaveBeenCalledExactlyOnceWith(true);
    expect(onEvent).toHaveBeenCalledTimes(2);
    service.close();
    expect(service.connected.value).toBe(false);
  });

  it('Replace a possibly half-open live connection when the page becomes visible again', () => {
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readonly close = vi.fn();
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
      send(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const onReconnect = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect,
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });

    service.connect();
    FakeWebSocket.instances[0]?.dispatchEvent(new Event('open'));
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'token-1',
          resumed: false
        })
      })
    );
    service.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]?.close).toHaveBeenCalledWith(4000, 'PAGE_VISIBLE_RECONNECT');
    FakeWebSocket.instances[1]?.dispatchEvent(new Event('open'));
    FakeWebSocket.instances[1]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'token-1',
          resumed: true
        })
      })
    );
    expect(onReconnect).toHaveBeenCalledOnce();
    service.close();
  });

  it('Refresh the authoritative list after token recovery without restoring the Watch repeatedly', async () => {
    vi.useFakeTimers();
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const onReconnect = vi.fn();
    const onConnectionRestored = vi.fn();
    const onReady = vi.fn();
    const service = createWorkbenchLiveService({
      canConnect: () => true,
      onEvent: vi.fn(),
      onResyncRequired: vi.fn(),
      onNodeConnection: vi.fn(),
      onNodeReplaced: vi.fn(),
      onReconnect,
      onConnectionRestored,
      onReady,
      onUnauthenticated: vi.fn(),
      onInvalidMessage: vi.fn()
    });
    service.connect();
    FakeWebSocket.instances[0]?.dispatchEvent(new Event('open'));
    FakeWebSocket.instances[0]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-1',
          workbenchResumeToken: 'token-1',
          resumed: false
        })
      })
    );
    FakeWebSocket.instances[0]?.dispatchEvent(new CloseEvent('close'));
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[1]?.dispatchEvent(new Event('open'));
    FakeWebSocket.instances[1]?.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'workbench.ready',
          workbenchConnectionId: 'connection-2',
          workbenchResumeToken: 'token-2',
          resumed: false
        })
      })
    );
    expect(onReady).toHaveBeenLastCalledWith('connection-2', false);
    expect(onConnectionRestored).toHaveBeenCalledOnce();
    expect(onConnectionRestored).toHaveBeenCalledWith(false);
    expect(onReconnect).not.toHaveBeenCalled();
    service.close();
  });
});
