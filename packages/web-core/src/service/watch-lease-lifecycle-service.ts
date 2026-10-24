import { ApiError } from '../util/api-error.js';

export function createWatchLeaseLifecycleService(options: {
  readonly heartbeatMs: number;
  readonly requestTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly maxFailures: number;
  readonly eligible: (targetKey: string) => boolean;
  readonly renew: (
    targetKey: string,
    signal: AbortSignal,
    mode: 'initial' | 'renew'
  ) => Promise<void>;
  readonly onExpired: () => void;
  readonly recovery?: {
    readonly retryable: (error: unknown) => boolean;
    readonly onFailure: (error: unknown) => void;
  };
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let targetKey: string | undefined;
  let lastConfirmedAt: number | undefined;
  let failures = 0;
  let paused = false;
  let recovering = false;
  let recoveryFailures = 0;

  function stop(): void {
    if (timer !== undefined) clearTimeout(timer);
    activeController?.abort(new ApiError('WATCH_CANCELLED', 'The watch was stopped or replaced.'));
    timer = undefined;
    activeController = undefined;
    inFlight = undefined;
    targetKey = undefined;
    lastConfirmedAt = undefined;
    failures = 0;
    paused = false;
    recovering = false;
    recoveryFailures = 0;
  }

  function pause(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    paused = true;
  }

  async function execute(
    currentTargetKey: string,
    mode: 'initial' | 'renew',
    controller: AbortController
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort(new ApiError('WATCH_REQUEST_TIMEOUT', 'The watch request timed out.')),
      options.requestTimeoutMs
    );
    try {
      await options.renew(currentTargetKey, controller.signal, mode);
      if (activeController !== controller || targetKey !== currentTargetKey) return;
      lastConfirmedAt = Date.now();
      failures = 0;
      recovering = false;
      recoveryFailures = 0;
    } catch (caught) {
      if (activeController !== controller || targetKey !== currentTargetKey) return;
      const error =
        controller.signal.aborted && caught instanceof Error && caught.name === 'AbortError'
          ? controller.signal.reason
          : caught;
      if (options.recovery !== undefined && (mode === 'renew' || recovering)) {
        options.recovery.onFailure(error);
        if (mode === 'initial') recoveryFailures += 1;
        if (
          !paused &&
          options.recovery.retryable(error) &&
          recoveryFailures < options.maxFailures
        ) {
          recovering = true;
        } else {
          pause();
          options.onExpired();
        }
        return;
      }
      if (mode === 'initial') {
        paused = true;
        failures = 0;
        lastConfirmedAt = undefined;
        throw error;
      }
      failures += 1;
      const confirmationExpired =
        lastConfirmedAt !== undefined &&
        Date.now() - lastConfirmedAt >= options.confirmationTimeoutMs;
      if (failures >= options.maxFailures || confirmationExpired) {
        options.onExpired();
        failures = 0;
        lastConfirmedAt = undefined;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  function launch(currentTargetKey: string, mode: 'initial' | 'renew'): Promise<void> | undefined {
    if (
      paused ||
      inFlight !== undefined ||
      targetKey !== currentTargetKey ||
      !options.eligible(currentTargetKey)
    )
      return inFlight;
    const controller = new AbortController();
    activeController = controller;
    const operation = execute(currentTargetKey, mode, controller).finally(() => {
      if (inFlight !== operation) return;
      inFlight = undefined;
      activeController = undefined;
      schedule(currentTargetKey);
    });
    inFlight = operation;
    return operation;
  }

  function schedule(currentTargetKey: string): void {
    if (timer !== undefined) clearTimeout(timer);
    if (paused || targetKey !== currentTargetKey) return;
    timer = setTimeout(() => {
      timer = undefined;
      void launch(currentTargetKey, recovering ? 'initial' : 'renew')?.catch(() => undefined);
    }, options.heartbeatMs);
  }

  function start(currentTargetKey: string, skipInitial = false): Promise<void> | undefined {
    if (!options.eligible(currentTargetKey)) {
      stop();
      return undefined;
    }
    if (targetKey === currentTargetKey) {
      if (inFlight !== undefined) return inFlight;
      if (timer !== undefined) return undefined;
    }
    stop();
    paused = false;
    targetKey = currentTargetKey;
    if (!skipInitial) return launch(currentTargetKey, 'initial');
    schedule(currentTargetKey);
    return undefined;
  }

  function confirm(currentTargetKey: string): void {
    if (targetKey !== currentTargetKey) return;
    lastConfirmedAt = Date.now();
    failures = 0;
  }

  return {
    start,
    pause,
    stop,
    confirm,
    isWatching: (currentTargetKey: string) => targetKey === currentTargetKey
  };
}
