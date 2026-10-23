import type { createTerminalDirectClient } from './TerminalDirectClient.js';
import { TerminalDirectError } from './TerminalDirectClient.js';
import { createTerminalRelayService } from './TerminalRelayService.js';
import { translate } from './LocalePreferenceService.js';

type RelayOptions = Parameters<typeof createTerminalRelayService>[0];
type DirectClient = Pick<ReturnType<typeof createTerminalDirectClient>, 'attach'>;

export interface TerminalServiceOptions extends RelayOptions {
  readonly direct?: DirectClient;
}

const TERMINAL_END_CODES = new Set(['TERMINAL_CLOSED', 'TERMINAL_NOT_FOUND']);
const DENIED_CODES = new Set([
  'TERMINAL_NOT_AUTHORIZED',
  'RESOURCE_ACCESS_DENIED',
  'WORKSPACE_ACCESS_DENIED',
  'SESSION_UNAUTHENTICATED',
  'USER_AUTHORIZATION_REQUIRED',
  'TERMINAL_WORKSPACE_MISMATCH',
  'TERMINAL_GIT_OWNER_REQUIRED',
  'NODE_ACCESS_DENIED'
]);

export function createTerminalService(options: TerminalServiceOptions) {
  let relay: ReturnType<typeof createTerminalRelayService> | undefined;
  let direct: { send(frame: object): void; dispose(): void } | undefined;
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let lastSequence = 0;
  let delay = 1_000;
  let generation = 0;
  let disposed = false;
  let attached = false;
  let terminalUnavailable = false;
  let attachmentConflicts = 0;

  function stopTimers(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (countdown !== undefined) clearInterval(countdown);
    timer = undefined;
    countdown = undefined;
  }

  function stopPath(): void {
    attached = false;
    abort?.abort();
    abort = undefined;
    relay?.dispose();
    relay = undefined;
    direct?.dispose();
    direct = undefined;
  }

  function terminalFailure(code: string): boolean {
    if (code === 'TERMINAL_ATTACH_CONFLICT') {
      attachmentConflicts += 1;
      generation += 1;
      stopPath();
      scheduleReconnect();
      return true;
    }
    if (TERMINAL_END_CODES.has(code)) {
      terminalUnavailable = true;
      options.onTerminalUnavailable(code);
      return true;
    }
    if (DENIED_CODES.has(code)) {
      terminalUnavailable = true;
      options.onErrorFrame(code);
      return true;
    }
    return false;
  }

  function scheduleReconnect(): void {
    if (disposed || terminalUnavailable || timer !== undefined) return;
    const deadline = Date.now() + delay;
    const status = () =>
      options.onReconnectStatus(
        attachmentConflicts >= 3
          ? translate('generated.terminalRelayService.terminalOccupiedRetrying')
          : translate(
              'generated.terminalRelayService.terminalConnectionLostReconnectingInSeconds',
              {
                value0: Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))
              }
            )
      );
    status();
    countdown = setInterval(status, 250);
    timer = setTimeout(() => {
      stopTimers();
      options.onReconnectStatus(
        attachmentConflicts >= 3
          ? translate('generated.terminalRelayService.terminalOccupiedRetrying')
          : translate('generated.terminalRelayService.reconnectingTerminal')
      );
      void connect();
    }, delay);
    delay = Math.min(delay * 2, 10_000);
  }

  function onAttached(): void {
    attached = true;
    attachmentConflicts = 0;
    delay = 1_000;
    stopTimers();
    options.onReconnectStatus(undefined);
    options.onAttached();
  }

  function onOutput(data: string, sequence?: number): void {
    if (sequence !== undefined) {
      if (sequence <= lastSequence) return;
      lastSequence = sequence;
    }
    options.onOutput(data);
  }

  function beginRelay(epoch: number): void {
    if (disposed || terminalUnavailable || epoch !== generation) return;
    relay?.dispose();
    relay = createTerminalRelayService({
      ...options,
      managed: true,
      afterSequence: () => lastSequence,
      onSequence: (sequence) => {
        lastSequence = sequence;
      },
      onOutput: (data) => onOutput(data),
      onAttached: () => {
        if (epoch === generation) onAttached();
      },
      onDisconnected: (code) => {
        if (epoch !== generation || disposed || terminalUnavailable) return;
        if (terminalFailure(code)) return;
        stopPath();
        scheduleReconnect();
      },
      onErrorFrame: (code) => {
        if (epoch === generation && !terminalFailure(code)) options.onErrorFrame(code);
      },
      onReconnectStatus: () => undefined,
      onTerminalUnavailable: (code) => {
        if (epoch !== generation) return;
        terminalUnavailable = true;
        options.onTerminalUnavailable(code);
      }
    });
    void relay.attach();
  }

  async function connect(forceRelay = false): Promise<void> {
    if (disposed || terminalUnavailable) return;
    generation += 1;
    const epoch = generation;
    stopPath();
    const controller = new AbortController();
    abort = controller;
    if (forceRelay || options.direct === undefined) {
      beginRelay(epoch);
      return;
    }
    try {
      const connection = await options.direct.attach({
        nodeId: options.nodeId,
        terminalId: options.terminalId,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        afterSequence: lastSequence,
        readonly: false,
        onFrame: (frame) => {
          if (epoch !== generation || disposed) return;
          if (frame.type === 'output') onOutput(frame.data, frame.sequence);
          else if (frame.type === 'exit') options.onExited();
          else if (frame.type === 'error') {
            if (terminalFailure(frame.code)) return;
            options.onErrorFrame(frame.code);
          }
        },
        onAttached: () => {
          if (epoch === generation) onAttached();
        },
        onDisconnected: (code) => {
          if (epoch !== generation || disposed || terminalUnavailable) return;
          if (terminalFailure(code)) return;
          void connect(true);
        },
        signal: controller.signal
      });
      if (epoch !== generation || disposed) {
        connection?.dispose();
        return;
      }
      if (connection === undefined) beginRelay(epoch);
      else direct = connection;
    } catch (error) {
      if (epoch !== generation || disposed) return;
      const code =
        error instanceof TerminalDirectError ? error.code : 'TERMINAL_DIRECT_UNAVAILABLE';
      if (!terminalFailure(code)) beginRelay(epoch);
    }
  }

  function send(frame: object): void {
    if (!attached || disposed) return;
    if (direct !== undefined) direct.send(frame);
    else relay?.send(frame);
  }

  function reconnect(): void {
    if (disposed || terminalUnavailable) return;
    void connect();
  }

  function dispose(): void {
    disposed = true;
    generation += 1;
    stopTimers();
    stopPath();
    options.onReconnectStatus(undefined);
  }

  return { attach: connect, send, reconnect, dispose };
}
