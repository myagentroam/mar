import { inject, readonly, shallowRef, type InjectionKey } from 'vue';

export interface PwaUpdate {
  readonly mode: 'worker' | 'online';
  readonly action: 'activate' | 'reload';
  readonly version: string;
  readonly buildId: string;
}

export interface PwaApplicationState {
  readonly offline: 'preparing' | 'ready' | 'degraded' | 'online';
  readonly checked: boolean;
  readonly update?: PwaUpdate;
  readonly reload?: PwaUpdate;
}

interface WorkerStatus {
  readonly buildId: string;
  readonly version: string;
  readonly supported: boolean;
  readonly degraded: boolean;
  readonly entry: boolean;
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.buildId === 'string' &&
    candidate.buildId.length > 0 &&
    typeof candidate.version === 'string' &&
    candidate.version.length > 0 &&
    typeof candidate.supported === 'boolean' &&
    typeof candidate.degraded === 'boolean' &&
    typeof candidate.entry === 'boolean'
  );
}

/** Owns one mounted Console's registration, update checks and activation/reload lifecycle. */
export function createPwaApplicationService(
  container: ServiceWorkerContainer | undefined,
  identity?: { readonly version: string; readonly buildId: string }
) {
  let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;
  let registrationRejected = false;
  let disposed = false;
  let pageController = container?.controller;
  let reloadingForUpdate = false;
  const pending = new Set<() => void>();
  const listeners = new Set<(value: PwaApplicationState) => void>();
  const observedWorkers = new Map<ServiceWorker, () => void>();
  const state = shallowRef<PwaApplicationState>({
    offline: container === undefined ? 'online' : 'preparing',
    checked: false
  });
  let cleanupRegistration: (() => void) | undefined;
  let cleanupLifecycle: (() => void) | undefined;
  let checking: Promise<void> | undefined;
  let checkingUpdate = false;
  let checkAgain = false;
  let startupRegistration = true;
  let reloadCandidate: ServiceWorker | null = null;
  let applying: Promise<'APPLIED' | 'UNAVAILABLE'> | undefined;
  const reloadNavigation =
    typeof performance !== 'undefined' &&
    typeof performance.getEntriesByType === 'function' &&
    performance
      .getEntriesByType('navigation')
      .some((entry) => (entry as PerformanceNavigationTiming).type === 'reload');

  function publish(next: PwaApplicationState): void {
    if (disposed) return;
    state.value = next;
    for (const listener of listeners) listener(next);
  }

  function subscribe(listener: (value: PwaApplicationState) => void): () => void {
    listeners.add(listener);
    listener(state.value);
    return () => listeners.delete(listener);
  }

  function message(worker: ServiceWorker, data: object, timeoutMs = 3_000): Promise<unknown> {
    if (disposed || typeof MessageChannel === 'undefined') return Promise.resolve(undefined);
    const channel = new MessageChannel();
    const reply = new Promise<unknown>((resolve, reject) => {
      channel.port1.onmessage = (event) => resolve(event.data);
      try {
        worker.postMessage(data, [channel.port2]);
      } catch (error) {
        reject(error);
      }
    });
    return bounded(reply, timeoutMs).finally(() => {
      channel.port1.close();
      channel.port2.close();
    });
  }

  async function status(worker: ServiceWorker | null): Promise<WorkerStatus | undefined> {
    if (worker === null) return undefined;
    const value = await message(worker, { type: 'MAR_PWA_STATUS' });
    return isWorkerStatus(value) ? value : undefined;
  }

  function observeWorker(worker: ServiceWorker | null): void {
    if (worker === null || worker.state === 'redundant' || observedWorkers.has(worker)) return;
    const changed = () => {
      if (worker.state === 'redundant') {
        const remove = observedWorkers.get(worker);
        if (remove === undefined) return;
        remove();
        observedWorkers.delete(worker);
      }
      backgroundCheck(false);
    };
    worker.addEventListener('statechange', changed);
    observedWorkers.set(worker, () => worker.removeEventListener('statechange', changed));
  }

  function observeRegistration(value: ServiceWorkerRegistration): void {
    if (identity === undefined || disposed) return;
    const updated = () => {
      observeWorker(value.installing);
      observeWorker(value.waiting);
      observeWorker(value.active);
      backgroundCheck(false);
    };
    value.addEventListener('updatefound', updated);
    cleanupRegistration = () => value.removeEventListener('updatefound', updated);
    observeWorker(value.installing);
    observeWorker(value.waiting);
    observeWorker(value.active);
    backgroundCheck();
  }

  function observeLifecycle(): void {
    if (identity === undefined || cleanupLifecycle !== undefined || disposed) return;
    const controllerChanged = () => {
      pageController ??= container?.controller;
      backgroundCheck(false);
    };
    const visible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        backgroundCheck();
    };
    const online = () => backgroundCheck();
    container?.addEventListener('controllerchange', controllerChanged);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    cleanupLifecycle = () => {
      container?.removeEventListener('controllerchange', controllerChanged);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', visible);
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
    };
  }

  function backgroundCheck(updateRegistration = true): void {
    void checkForUpdate(updateRegistration).catch(() => undefined);
  }

  function bounded<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T | undefined> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: T | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        pending.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const timeout = setTimeout(cancel, timeoutMs);
      pending.add(cancel);
      void promise.then(finish, cancel);
    });
  }

  function start(): Promise<ServiceWorkerRegistration | undefined> {
    if (disposed) return Promise.resolve(undefined);
    observeLifecycle();
    if (container === undefined) {
      backgroundCheck(false);
      return Promise.resolve(undefined);
    }
    if (registration === undefined) {
      registrationRejected = false;
      try {
        registration = container
          .register('/service-worker.js', { scope: '/' })
          .then((value) => {
            if (startupRegistration) {
              startupRegistration = false;
              // Only a target already waiting at reload startup may interrupt this new page.
              if (reloadNavigation) reloadCandidate = value.waiting;
            }
            observeRegistration(value);
            return value;
          })
          .catch(() => {
            startupRegistration = false;
            registration = undefined;
            registrationRejected = true;
            return undefined;
          });
      } catch {
        startupRegistration = false;
        registrationRejected = true;
        return Promise.resolve(undefined);
      }
      if (identity !== undefined && checking === undefined) queueMicrotask(() => backgroundCheck());
    }
    return registration;
  }

  async function onlineVersion(): Promise<PwaUpdate | undefined> {
    if (identity === undefined) return undefined;
    const abort = new AbortController();
    const value = await bounded(
      (async (): Promise<unknown> => {
        const response = await fetch('/web-version.json', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: abort.signal
        });
        if (!response.ok) throw new Error('Web version unavailable');
        return response.json();
      })()
    );
    abort.abort();
    if (value === undefined) throw new Error('Web version unavailable');
    if (typeof value !== 'object' || value === null) throw new Error('Invalid web version');
    const data = value as Record<string, unknown>;
    if (
      typeof data.version !== 'string' ||
      typeof data.hash !== 'string' ||
      !data.version ||
      !data.hash
    ) {
      throw new Error('Invalid web version');
    }
    return data.hash === identity.buildId && data.version === identity.version
      ? undefined
      : { mode: 'online', action: 'reload', version: data.version, buildId: data.hash };
  }

  async function checkForUpdate(updateRegistration = true): Promise<void> {
    if (identity === undefined || disposed) return;
    if (checking !== undefined) {
      if (updateRegistration && !checkingUpdate) {
        await checking.catch(() => undefined);
        return checkForUpdate(true);
      }
      if (!updateRegistration) checkAgain = true;
      return checking;
    }
    checkingUpdate = updateRegistration;
    checking = Promise.resolve().then(async () => {
      const value = container === undefined ? undefined : await bounded(start());
      if (disposed) return;
      if (
        container !== undefined &&
        value === undefined &&
        !(registrationRejected && container.controller === null)
      ) {
        throw new Error('Worker registration unavailable');
      }
      const updateSucceeded =
        value === undefined ||
        !updateRegistration ||
        (await bounded(value.update().then(() => true))) === true;
      if (disposed) return;
      const active = value?.active ?? null;
      const waiting = value?.waiting ?? null;
      const startupTarget = reloadCandidate;
      reloadCandidate = null;
      observeWorker(value?.installing ?? null);
      observeWorker(waiting);
      observeWorker(active);
      const [activeStatus, waitingStatus] = await Promise.all([status(active), status(waiting)]);
      if (disposed) return;
      if (active === null && container?.controller != null)
        throw new Error('Controller identity unavailable');
      if (active !== null && activeStatus === undefined)
        throw new Error('Active worker unavailable');
      if (waiting !== null && waitingStatus === undefined)
        throw new Error('Waiting worker unavailable');
      if (value?.installing && active === null && waiting === null) {
        publish({ offline: 'preparing', checked: true });
        if (!updateSucceeded) throw new Error('Update check failed');
        return;
      }
      if (activeStatus?.supported === true || waitingStatus?.supported === true) {
        const offline =
          activeStatus?.degraded === true ||
          (activeStatus?.supported === true && !activeStatus.entry)
            ? 'degraded'
            : active !== null &&
                container?.controller === active &&
                activeStatus?.supported === true &&
                activeStatus.buildId === identity.buildId &&
                activeStatus.entry
              ? 'ready'
              : 'preparing';
        let update: PwaUpdate | undefined;
        let reload: PwaUpdate | undefined;
        if (
          waiting !== null &&
          waitingStatus?.supported === true &&
          waitingStatus.entry &&
          !waitingStatus.degraded
        ) {
          const prepared: PwaUpdate = {
            mode: 'worker',
            action: 'activate',
            version: waitingStatus.version,
            buildId: waitingStatus.buildId
          };
          if (waitingStatus.buildId !== identity.buildId) update = prepared;
          else reload = prepared;
        } else if (
          waiting === null &&
          activeStatus?.supported === true &&
          activeStatus.entry &&
          !activeStatus.degraded &&
          activeStatus.buildId !== identity.buildId
        ) {
          reload = {
            mode: 'worker',
            action: 'reload',
            version: activeStatus.version,
            buildId: activeStatus.buildId
          };
        }
        publish({
          offline,
          checked: true,
          ...(update === undefined ? {} : { update }),
          ...(reload === undefined ? {} : { reload })
        });
        if (waiting !== null && waiting === startupTarget && (update ?? reload) !== undefined)
          await applyUpdate();
        if (waitingStatus?.supported === true && (!waitingStatus.entry || waitingStatus.degraded))
          throw new Error('Waiting worker not ready');
        if (!updateSucceeded) throw new Error('Update check failed');
        return;
      }
      const update = await onlineVersion();
      publish(
        update === undefined
          ? { offline: 'online', checked: true }
          : { offline: 'online', checked: true, update }
      );
      if (!updateSucceeded) throw new Error('Update check failed');
    });
    try {
      await checking;
    } finally {
      checking = undefined;
      if (checkAgain && !disposed) {
        checkAgain = false;
        queueMicrotask(() => backgroundCheck(false));
      }
    }
  }

  async function activeWorker(timeoutMs = 5_000): Promise<ServiceWorker | undefined> {
    if (container === undefined || disposed) return undefined;
    if (container.controller !== null) return container.controller;
    return new Promise((resolve) => {
      let finished = false;
      let resolvedRegistration: ServiceWorkerRegistration | undefined;
      const workers = new Set<ServiceWorker>();
      const finish = (worker: ServiceWorker | undefined) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        container.removeEventListener('controllerchange', changed);
        resolvedRegistration?.removeEventListener('updatefound', changed);
        for (const worker of workers) worker.removeEventListener('statechange', changed);
        pending.delete(cancel);
        resolve(worker);
      };
      const cancel = () => finish(undefined);
      const changed = () => {
        if (container.controller !== null) finish(container.controller);
        else if (resolvedRegistration?.active != null) finish(resolvedRegistration.active);
        else {
          for (const worker of [resolvedRegistration?.installing, resolvedRegistration?.waiting]) {
            if (worker == null || workers.has(worker)) continue;
            workers.add(worker);
            worker.addEventListener('statechange', changed);
          }
        }
      };
      const timeout = setTimeout(() => finish(undefined), timeoutMs);
      pending.add(cancel);
      container.addEventListener('controllerchange', changed);
      void start().then((value) => {
        if (finished || value === undefined) return;
        resolvedRegistration = value;
        value.addEventListener('updatefound', changed);
        changed();
      });
      changed();
    });
  }

  function isReloadingForUpdate(): boolean {
    return (
      reloadingForUpdate ||
      (pageController != null &&
        container?.controller != null &&
        container.controller !== pageController)
    );
  }

  function reloadForUpdate(): void {
    reloadingForUpdate = true;
    window.location.reload();
  }

  function applyUpdate(): Promise<'APPLIED' | 'UNAVAILABLE'> {
    if (applying !== undefined) return applying;
    applying = performApplyUpdate().finally(() => {
      applying = undefined;
    });
    return applying;
  }

  async function performApplyUpdate(): Promise<'APPLIED' | 'UNAVAILABLE'> {
    if (identity === undefined || disposed) return 'UNAVAILABLE';
    const update = state.value.update ?? state.value.reload;
    if (update === undefined) return 'UNAVAILABLE';
    const clearUpdate = () => {
      if ((state.value.update ?? state.value.reload) === update)
        publish({ offline: state.value.offline, checked: state.value.checked });
    };
    if (update.mode === 'online') {
      reloadForUpdate();
      return 'APPLIED';
    }
    const value = await bounded(start());
    if (value === undefined || container === undefined || disposed) return 'UNAVAILABLE';
    const waiting = value.waiting;
    if (waiting !== null) {
      const waitingStatus = await status(waiting);
      if (
        waitingStatus?.supported !== true ||
        !waitingStatus.entry ||
        waitingStatus.degraded ||
        waitingStatus.buildId !== update.buildId
      ) {
        if (
          waitingStatus?.buildId === update.buildId &&
          (!waitingStatus.entry || waitingStatus.degraded)
        )
          clearUpdate();
        return 'UNAVAILABLE';
      }
      if (disposed) return 'UNAVAILABLE';
      let cancelWait: () => void = () => undefined;
      const changed = new Promise<boolean>((resolve) => {
        let finished = false;
        const finish = (ok: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          container.removeEventListener('controllerchange', onChange);
          pending.delete(cancel);
          resolve(ok);
        };
        const onChange = () => finish(container.controller === waiting);
        const cancel = () => finish(false);
        const timeout = setTimeout(cancel, 10_000);
        cancelWait = cancel;
        pending.add(cancel);
        container.addEventListener('controllerchange', onChange);
      });
      const result = await message(waiting, {
        type: 'MAR_PWA_APPLY',
        pageBuildId: identity.buildId
      });
      if (
        typeof result !== 'object' ||
        result === null ||
        (result as { applied?: unknown }).applied !== true
      ) {
        cancelWait();
        if (
          typeof result === 'object' &&
          result !== null &&
          (result as { reason?: unknown }).reason === 'UNAVAILABLE'
        )
          clearUpdate();
        return 'UNAVAILABLE';
      }
      if (!(await changed) || disposed) return 'UNAVAILABLE';
      reloadForUpdate();
      return 'APPLIED';
    }
    const active = value.active;
    const activeStatus = await status(active);
    if (
      active === null ||
      container.controller !== active ||
      activeStatus?.supported !== true ||
      !activeStatus.entry ||
      activeStatus.degraded ||
      activeStatus.buildId !== update.buildId ||
      activeStatus.buildId === identity.buildId
    )
      return 'UNAVAILABLE';
    if (disposed) return 'UNAVAILABLE';
    reloadForUpdate();
    return 'APPLIED';
  }

  function dispose(): void {
    disposed = true;
    cleanupRegistration?.();
    cleanupLifecycle?.();
    for (const remove of observedWorkers.values()) remove();
    observedWorkers.clear();
    listeners.clear();
    for (const cancel of pending) cancel();
  }

  return {
    start,
    activeWorker,
    checkForUpdate,
    applyUpdate,
    isReloadingForUpdate,
    state: readonly(state),
    subscribe,
    dispose
  };
}

export type PwaApplicationService = ReturnType<typeof createPwaApplicationService>;
export const PWA_APPLICATION_SERVICE_KEY: InjectionKey<PwaApplicationService> =
  Symbol('pwa-application');

export function usePwaApplicationService(): PwaApplicationService {
  const service = inject(PWA_APPLICATION_SERVICE_KEY);
  if (service === undefined) throw new Error('PWA application service was not provided');
  return service;
}
