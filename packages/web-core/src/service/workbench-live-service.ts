import { readonly, ref } from 'vue';
import {
  directBrowserMessageSchema,
  directServerMessageSchema,
  terminalDirectBrowserMessageSchema,
  terminalDirectServerMessageSchema,
  remoteDesktopDirectBrowserMessageSchema,
  remoteDesktopDirectServerMessageSchema,
  remoteDesktopRelayBrowserMessageSchema,
  remoteDesktopRelayServerMessageSchema,
  type DirectBrowserMessage,
  type DirectServerMessage,
  type TerminalDirectBrowserMessage,
  type TerminalDirectServerMessage,
  type RemoteDesktopDirectBrowserMessage,
  type RemoteDesktopDirectServerMessage,
  type RemoteDesktopRelayBrowserMessage,
  type RemoteDesktopRelayServerMessage
} from '@myagentroam/protocol';

export interface WorkbenchLiveEvent {
  readonly nodeId: string;
  readonly sequence: number;
  readonly category: 'node' | 'session' | 'conversation' | 'run' | 'queue' | 'workspace';
  readonly payload: unknown;
}

interface WorkbenchLiveConnectionOptions {
  readonly endpoint?: () => string;
  readonly canConnect: () => boolean;
  readonly onEvent: (event: WorkbenchLiveEvent) => void;
  readonly onNotificationMessage?: (message: unknown) => boolean;
  readonly onResyncRequired: (nodeId: string) => void;
  readonly onNodeConnection: (nodeId: string, connected: boolean) => void;
  readonly onNodeUpgrade?: (nodeId: string, snapshot: unknown) => void;
  readonly onNodeReplaced: (nodeId: string) => void;
  readonly onReconnect: () => void;
  readonly onConnectionRestored?: (resumed: boolean) => void;
  readonly onDisconnected?: () => void;
  readonly onUnauthenticated: () => void;
  readonly onInvalidMessage: () => void;
  readonly onReady?: (connectionId: string, resumed: boolean) => void;
  readonly onWatchEvent?: (event: unknown) => void;
  readonly onDirectMessage?: (message: DirectServerMessage) => void;
  readonly onTerminalDirectMessage?: (message: TerminalDirectServerMessage) => void;
  readonly onDesktopDirectMessage?: (message: RemoteDesktopDirectServerMessage) => void;
  readonly onDesktopRelayMessage?: (message: RemoteDesktopRelayServerMessage) => void;
  readonly diagnostics?: {
    observeFrame(sample: {
      readonly bytes: number;
      readonly durationMs: number;
      readonly message: unknown;
    }): void;
    setConnectionState(state: 'connecting' | 'connected' | 'disconnected'): void;
    resetActiveRuns(): void;
    setPingLatency?(durationMs: number): void;
  };
}

const PING_INTERVAL_MS = 10_000;

export function createWorkbenchLiveService(options: WorkbenchLiveConnectionOptions) {
  const sequences = new Map<string, number>();
  const disconnectedNodes = new Set<string>();
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 500;
  let hasOpened = false;
  let workbenchConnectionId: string | undefined;
  let workbenchResumeToken: string | undefined;
  let reconnectingSocket = false;
  const connected = ref(false);
  let pendingReady:
    { readonly promise: Promise<boolean>; readonly resolve: (ready: boolean) => void } | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let nextPingId = 0;
  const pendingPings = new Map<string, number>();

  function stopPing(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
    pendingPings.clear();
  }

  function ping(): void {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    if (pendingPings.size > 0) {
      reconnect();
      return;
    }
    const id = String(++nextPingId);
    pendingPings.set(id, performance.now());
    socket.send(JSON.stringify({ type: 'ping', id }));
  }

  function startPing(): void {
    stopPing();
    ping();
    pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  function socketUrl(): string {
    const endpoint = new URL(options.endpoint?.() ?? '/api/workbench/live', window.location.origin);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    return endpoint.toString();
  }

  function restore(): void {
    // Reconnects load authoritative state instead of restoring event history.
  }

  function waitForReady(): Promise<boolean> {
    if (connected.value) return Promise.resolve(true);
    if (pendingReady === undefined) {
      let resolve!: (ready: boolean) => void;
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      pendingReady = { promise, resolve };
    }
    return pendingReady.promise;
  }

  function finishReady(ready: boolean): void {
    const pending = pendingReady;
    pendingReady = undefined;
    pending?.resolve(ready);
  }

  function handleMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (
      message.type === 'workbench.ready' &&
      typeof message.workbenchConnectionId === 'string' &&
      typeof message.workbenchResumeToken === 'string'
    ) {
      options.diagnostics?.setConnectionState('connected');
      workbenchConnectionId = message.workbenchConnectionId;
      workbenchResumeToken = message.workbenchResumeToken;
      const resumed = message.resumed === true;
      connected.value = true;
      options.onReady?.(workbenchConnectionId, resumed);
      finishReady(true);
      if (reconnectingSocket) options.onConnectionRestored?.(resumed);
      if (reconnectingSocket && resumed) options.onReconnect();
      reconnectingSocket = false;
      startPing();
      return;
    }
    if (message.type === 'pong' && typeof message.id === 'string') {
      const startedAt = pendingPings.get(message.id);
      if (startedAt !== undefined) {
        pendingPings.delete(message.id);
        options.diagnostics?.setPingLatency?.(performance.now() - startedAt);
      }
      return;
    }
    if (message.type === 'watch.event' && message.event !== undefined) {
      options.onWatchEvent?.(message.event);
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('direct.')) {
      const direct = directServerMessageSchema.safeParse(message);
      if (!direct.success) {
        options.onInvalidMessage();
        return;
      }
      options.onDirectMessage?.(direct.data);
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('terminal.direct.')) {
      const direct = terminalDirectServerMessageSchema.safeParse(message);
      if (!direct.success) {
        options.onInvalidMessage();
        return;
      }
      options.onTerminalDirectMessage?.(direct.data);
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('desktop.direct.')) {
      const parsed = remoteDesktopDirectServerMessageSchema.safeParse(message);
      if (!parsed.success) options.onInvalidMessage();
      else options.onDesktopDirectMessage?.(parsed.data);
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('desktop.relay.')) {
      const parsed = remoteDesktopRelayServerMessageSchema.safeParse(message);
      if (!parsed.success) options.onInvalidMessage();
      else options.onDesktopRelayMessage?.(parsed.data);
      return;
    }
    if (options.onNotificationMessage?.(message)) return;
    if (message.type === 'resync-required' && typeof message.nodeId === 'string') {
      options.diagnostics?.resetActiveRuns();
      sequences.delete(message.nodeId);
      options.onResyncRequired(message.nodeId);
      return;
    }
    if (message.type === 'node.upgrade' && typeof message.nodeId === 'string') {
      options.onNodeUpgrade?.(message.nodeId, message.snapshot);
      return;
    }
    if (
      message.type === 'node' &&
      typeof message.nodeId === 'string' &&
      typeof message.connected === 'boolean'
    ) {
      let needsResync = false;
      if (!message.connected) {
        disconnectedNodes.add(message.nodeId);
        sequences.delete(message.nodeId);
      } else if (disconnectedNodes.delete(message.nodeId)) {
        sequences.delete(message.nodeId);
        needsResync = true;
      }
      options.onNodeConnection(message.nodeId, message.connected);
      if (message.reason === 'CONNECTION_REPLACED') {
        options.diagnostics?.resetActiveRuns();
        sequences.delete(message.nodeId);
        options.onNodeReplaced(message.nodeId);
        needsResync = true;
      }
      if (needsResync) options.onResyncRequired(message.nodeId);
      return;
    }
    if (message.type !== 'event' || typeof message.event !== 'object' || message.event === null)
      return;
    const event = message.event as Partial<WorkbenchLiveEvent>;
    if (
      typeof event.nodeId !== 'string' ||
      !Number.isInteger(event.sequence) ||
      typeof event.category !== 'string'
    )
      return;
    const sequence = event.sequence as number;
    if (sequence <= (sequences.get(event.nodeId) ?? 0)) return;
    sequences.set(event.nodeId, sequence);
    options.onEvent(event as WorkbenchLiveEvent);
  }

  function connect(): void {
    if (!options.canConnect() || socket !== undefined) return;
    options.diagnostics?.setConnectionState('connecting');
    const next = new WebSocket(socketUrl());
    socket = next;
    next.addEventListener('open', () => {
      if (socket !== next) return;
      const reconnecting = hasOpened;
      hasOpened = true;
      reconnectDelay = 500;
      sequences.clear();
      reconnectingSocket = reconnecting;
      connected.value = false;
      next.send(
        JSON.stringify({
          type: 'resume',
          ...(workbenchConnectionId === undefined ? {} : { workbenchConnectionId }),
          ...(workbenchResumeToken === undefined ? {} : { workbenchResumeToken })
        })
      );
    });
    next.addEventListener('message', (raw) => {
      if (socket !== next) return;
      const startedAt = performance.now();
      const text = String(raw.data);
      let message: unknown;
      try {
        message = JSON.parse(text) as unknown;
        handleMessage(message);
      } catch {
        options.onInvalidMessage();
      } finally {
        options.diagnostics?.observeFrame({
          bytes: text.length,
          durationMs: performance.now() - startedAt,
          message
        });
      }
    });
    next.addEventListener('close', (event) => {
      if (socket !== next) return;
      socket = undefined;
      connected.value = false;
      stopPing();
      options.diagnostics?.setConnectionState('disconnected');
      options.onDisconnected?.();
      if (event.code === 4001 && event.reason === 'UNAUTHENTICATED') {
        finishReady(false);
        options.onUnauthenticated();
        return;
      }
      if (!options.canConnect()) {
        finishReady(false);
        return;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  }

  function close(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    connected.value = false;
    finishReady(false);
    stopPing();
    options.diagnostics?.setConnectionState('disconnected');
    current?.close(1000, 'PAGE_CLOSED');
  }

  function reconnect(): void {
    if (!options.canConnect()) return;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    connected.value = false;
    stopPing();
    options.diagnostics?.setConnectionState('connecting');
    current?.close(4000, 'PAGE_VISIBLE_RECONNECT');
    connect();
  }

  function sendDirect(message: DirectBrowserMessage): boolean {
    const parsed = directBrowserMessageSchema.safeParse(message);
    if (
      !parsed.success ||
      !connected.value ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    )
      return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  function sendTerminalDirect(message: TerminalDirectBrowserMessage): boolean {
    const parsed = terminalDirectBrowserMessageSchema.safeParse(message);
    if (
      !parsed.success ||
      !connected.value ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN
    )
      return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  function sendDesktopDirect(message: RemoteDesktopDirectBrowserMessage): boolean {
    const parsed = remoteDesktopDirectBrowserMessageSchema.safeParse(message);
    if (!parsed.success || !connected.value || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  function sendDesktopRelay(message: RemoteDesktopRelayBrowserMessage): boolean {
    const parsed = remoteDesktopRelayBrowserMessageSchema.safeParse(message);
    if (!parsed.success || !connected.value || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(parsed.data));
    return true;
  }

  function updateShareVisitor(visitor: import('@myagentroam/protocol').SessionShareVisitor): void {
    if (connected.value && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'session-share.visitor', visitor }));
  }
  return {
    connected: readonly(connected),
    waitForReady,
    restore,
    connect,
    reconnect,
    close,
    sendDirect,
    sendTerminalDirect,
    sendDesktopDirect,
    sendDesktopRelay,
    updateShareVisitor
  };
}
