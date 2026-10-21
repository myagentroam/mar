import type { ScopedHttpService } from './ScopedHttpService.js';
import { translate } from './LocalePreferenceService.js';

interface TerminalRelayServiceOptions {
  readonly terminalId: string;
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly http: ScopedHttpService;
  readonly onAttached: () => void;
  readonly onOutput: (data: string) => void;
  readonly onExited: () => void;
  readonly onTerminalUnavailable: (code: string) => void;
  readonly onErrorFrame: (code: string) => void;
  readonly onReconnectStatus: (message: string | undefined) => void;
  readonly onNotice: (message: string) => void;
  readonly managed?: boolean;
  readonly afterSequence?: () => number;
  readonly onSequence?: (sequence: number) => void;
  readonly onDisconnected?: (code: string) => void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const ATTACH_TIMEOUT_MS = 20_000;

export function createTerminalRelayService(options: TerminalRelayServiceOptions) {
  let socket: WebSocket | undefined;
  let lastSequence = 0;
  let reconnectTimer: number | undefined;
  let countdownTimer: number | undefined;
  let attachTimer: number | undefined;
  let attachAbortController: AbortController | undefined;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let attaching = false;
  let attached = false;
  let terminalUnavailable = false;
  let disposed = false;
  let managedNotified = false;

  function connectUrl(ticket: string): string {
    const endpoint = new URL(
      `/api/terminals/${encodeURIComponent(options.terminalId)}/connect`,
      window.location.origin
    );
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('ticket', ticket);
    return endpoint.toString();
  }

  function send(frame: object): void {
    if (attached && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function clearReconnectTimers(): void {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
    reconnectTimer = undefined;
    countdownTimer = undefined;
  }

  function clearAttachTimer(): void {
    if (attachTimer !== undefined) window.clearTimeout(attachTimer);
    attachTimer = undefined;
  }

  function scheduleReconnect(): void {
    if (options.managed) {
      if (!disposed && !terminalUnavailable && !managedNotified) {
        managedNotified = true;
        options.onDisconnected?.('TERMINAL_RELAY_CLOSED');
      }
      return;
    }
    if (disposed || terminalUnavailable || reconnectTimer !== undefined) return;
    const delay = reconnectDelay;
    const deadline = Date.now() + delay;
    const updateCountdown = () =>
      options.onReconnectStatus(
        translate('generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds', {
          value0: Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))
        })
      );
    updateCountdown();
    countdownTimer = window.setInterval(updateCountdown, 250);
    reconnectTimer = window.setTimeout(() => {
      clearReconnectTimers();
      options.onReconnectStatus(translate('generated.terminalRelayService.reconnectingTerminal'));
      void attach();
    }, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  async function attach(): Promise<void> {
    if (disposed || socket !== undefined || attaching) return;
    attaching = true;
    const abortController = new AbortController();
    attachAbortController = abortController;
    const requestTimeout = window.setTimeout(() => abortController.abort(), ATTACH_TIMEOUT_MS);
    try {
      const ticket = await options.http.request<{ ticket: string }>(
        `/api/terminals/${encodeURIComponent(options.terminalId)}/attach-ticket`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId: options.nodeId,
            ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
            afterSequence: options.afterSequence?.() ?? lastSequence
          }),
          signal: abortController.signal
        }
      );
      if (disposed) return;
      const current = new WebSocket(connectUrl(ticket.ticket));
      socket = current;
      attached = false;
      attachTimer = window.setTimeout(() => {
        if (socket === current && !attached) current.close(4000, 'TERMINAL_ATTACH_TIMEOUT');
      }, ATTACH_TIMEOUT_MS);
      current.addEventListener('message', (event) => handleMessage(current, event));
      current.addEventListener('close', () => {
        if (socket !== current) return;
        clearAttachTimer();
        socket = undefined;
        attached = false;
        if (terminalUnavailable) return;
        scheduleReconnect();
      });
      current.addEventListener('error', () => undefined);
    } catch (error) {
      if (options.managed && error !== null && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        if (
          typeof code === 'string' &&
          ['SESSION_UNAUTHENTICATED', 'RESOURCE_ACCESS_DENIED', 'WORKSPACE_ACCESS_DENIED'].includes(
            code
          )
        ) {
          terminalUnavailable = true;
          options.onDisconnected?.(code);
          return;
        }
      }
      scheduleReconnect();
    } finally {
      window.clearTimeout(requestTimeout);
      if (attachAbortController === abortController) attachAbortController = undefined;
      attaching = false;
    }
  }

  function handleMessage(current: WebSocket, event: MessageEvent): void {
    if (socket !== current) return;
    let frame: {
      readonly type: string;
      readonly terminalId: string;
      readonly sequence?: number;
      readonly data?: string;
      readonly code?: string;
    };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      options.onNotice(
        translate('generated.terminalRelayService.theTerminalRelayReturnedInvalidDataReconnecting')
      );
      current.close();
      return;
    }
    if (frame.terminalId !== options.terminalId) return;
    if (frame.type === 'attach') {
      attached = true;
      managedNotified = false;
      clearAttachTimer();
      clearReconnectTimers();
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      options.onReconnectStatus(undefined);
      options.onAttached();
    } else if (frame.type === 'output' && typeof frame.data === 'string') {
      if (typeof frame.sequence === 'number') lastSequence = Math.max(lastSequence, frame.sequence);
      if (typeof frame.sequence === 'number') {
        if (options.afterSequence !== undefined && frame.sequence <= options.afterSequence())
          return;
        options.onSequence?.(frame.sequence);
      }
      options.onOutput(frame.data);
    } else if (frame.type === 'exit') {
      options.onExited();
    } else if (frame.type === 'error') {
      const code = frame.code ?? 'TERMINAL_ERROR';
      if (code === 'TERMINAL_CLOSED' || code === 'TERMINAL_NOT_FOUND') {
        terminalUnavailable = true;
        options.onTerminalUnavailable(code);
        current.close(1000, code);
      } else options.onErrorFrame(code);
    }
  }

  function reconnect(): void {
    if (disposed) return;
    const current = socket;
    socket = undefined;
    attached = false;
    clearAttachTimer();
    current?.close(1000, 'TERMINAL_RELAY_RECONNECT');
    scheduleReconnect();
  }

  function dispose(): void {
    disposed = true;
    clearReconnectTimers();
    clearAttachTimer();
    attachAbortController?.abort();
    attachAbortController = undefined;
    options.onReconnectStatus(undefined);
    socket?.close();
    socket = undefined;
    attached = false;
  }

  return { attach, send, reconnect, dispose };
}
