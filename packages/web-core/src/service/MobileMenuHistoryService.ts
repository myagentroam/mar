import { watch, type WatchStopHandle } from 'vue';

const HISTORY_KEY = '__marMobileMenu';
let sequence = 0;
let pendingRelease: Promise<void> | undefined;

function releaseEntry(): Promise<void> {
  if (pendingRelease !== undefined) return pendingRelease;
  pendingRelease = new Promise<void>((resolve) => {
    const complete = () => {
      window.removeEventListener('popstate', complete);
      pendingRelease = undefined;
      resolve();
    };
    window.addEventListener('popstate', complete);
    window.history.back();
  });
  return pendingRelease;
}

export function createMobileMenuHistoryService(options: {
  readonly isOpen: () => boolean;
  readonly close: () => void;
  readonly syncRoute: () => void;
}) {
  const owner = `menu-${Date.now()}-${++sequence}`;
  let ownsEntry = false;
  let started = false;
  let stopWatching: WatchStopHandle | undefined;

  function currentOwner(): unknown {
    const state: unknown = window.history.state;
    return typeof state === 'object' && state !== null
      ? (state as Record<string, unknown>)[HISTORY_KEY]
      : undefined;
  }

  function sync(): void {
    if (!started || pendingRelease !== undefined) return;
    if (options.isOpen()) {
      if (ownsEntry) return;
      if (currentOwner() !== owner)
        window.history.pushState({ ...window.history.state, [HISTORY_KEY]: owner }, '');
      ownsEntry = true;
    } else if (ownsEntry) {
      ownsEntry = false;
      if (currentOwner() !== owner) return;
      void releaseEntry().then(() => {
        if (!started) return;
        options.syncRoute();
        sync();
      });
    }
  }

  function onPopState(): void {
    if (!ownsEntry || currentOwner() === owner) return;
    ownsEntry = false;
    options.close();
    options.syncRoute();
  }

  function start(): void {
    if (started) return;
    started = true;
    window.addEventListener('popstate', onPopState);
    stopWatching = watch(options.isOpen, sync, { immediate: true, flush: 'post' });
    if (pendingRelease !== undefined) void pendingRelease.then(sync);
  }

  function dispose(): void {
    if (!started) return;
    started = false;
    stopWatching?.();
    window.removeEventListener('popstate', onPopState);
    if (ownsEntry && currentOwner() === owner) void releaseEntry();
    ownsEntry = false;
  }

  return { start, dispose };
}
