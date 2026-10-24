import { watch, type WatchStopHandle } from 'vue';
import { MOBILE_WORKBENCH_VIEWPORT_QUERY } from '../util/mobile-workbench.js';

const KEY = '__marTemporaryLayer';
let sequence = 0;

interface Layer {
  readonly id: string;
  readonly close: () => unknown;
  active: boolean;
  pending: boolean;
  entered: boolean;
  parent: unknown;
  state: Record<string, unknown>;
  url: string;
}

/** Owns temporary same-document entries, not application route navigation. */
export function createMobileLayerHistoryCoordinator() {
  const layers: Layer[] = [];
  let releasing = false;
  let releaseState: Record<string, unknown> | undefined;
  let releaseUrl = '';
  let listening = false;
  let releaseParent: unknown;

  function state(): Record<string, unknown> {
    return window.history.state ?? {};
  }

  function marker(): unknown {
    return state()[KEY];
  }

  function sync(): void {
    if (releasing) return;
    const current = layers.find((layer) => layer.id === marker());
    if (current !== undefined && !current.active) {
      releasing = true;
      releaseState = state();
      releaseUrl = window.location.href;
      releaseParent = current.parent;
      window.history.back();
      return;
    }
    if (current?.active) {
      current.state = state();
      current.url = window.location.href;
    }
    for (const layer of layers) {
      if (!layer.active || layer.entered) continue;
      layer.parent = marker();
      window.history.pushState({ ...state(), [KEY]: layer.id }, '');
      layer.state = state();
      layer.url = window.location.href;
      layer.entered = true;
    }
    if (!layers.some((layer) => layer.active)) {
      layers.length = 0;
      window.removeEventListener('popstate', onPopState);
      listening = false;
    }
  }

  function onPopState(): void {
    if (releasing) {
      releasing = false;
      if (marker() !== releaseParent) {
        // A route or a foreign history entry changed during cleanup. It is not
        // ours to repair or traverse; new layers may only register hereafter.
        releaseState = undefined;
        sync();
        return;
      }
      const parent = marker();
      const next = { ...releaseState };
      if (parent === undefined) delete next[KEY];
      else next[KEY] = parent;
      window.history.replaceState(
        Object.keys(next).length === 0 && window.history.state === null ? null : next,
        '',
        releaseUrl
      );
      releaseState = undefined;
      sync();
      return;
    }
    const top = [...layers].reverse().find((layer) => layer.active && layer.entered);
    if (top === undefined || marker() !== top.parent) return;
    // Restore ownership before guarded close: a nested confirmation must have
    // its own entry, and cancelling it must retain the original layer.
    window.history.pushState(top.state, '', top.url);
    if (top.pending) return;
    top.pending = true;
    const complete = () => {
      top.pending = false;
    };
    try {
      // Domain close handlers retain responsibility for error feedback. A
      // rejected close never consumes the restored guard or escapes as an
      // unhandled rejection from the browser event listener.
      void Promise.resolve(top.close()).then(complete, complete);
    } catch {
      complete();
    }
  }

  function register(close: () => unknown): () => void {
    const layer: Layer = {
      id: `layer-${Date.now()}-${++sequence}`,
      close,
      active: true,
      pending: false,
      entered: false,
      parent: marker(),
      state: state(),
      url: window.location.href
    };
    layers.push(layer);
    if (!listening) {
      window.addEventListener('popstate', onPopState);
      listening = true;
    }
    sync();
    return () => {
      if (!layer.active) return;
      layer.active = false;
      if (layer.entered && marker() !== layer.id) {
        // Non-top owners cannot prune history beneath a child. Once released,
        // their markers are ordinary expired state, not future cleanup orders.
        layers.splice(layers.indexOf(layer), 1);
      }
      sync();
    };
  }

  function captureRoute(): void {
    if (releasing && marker() === releaseState?.[KEY]) {
      releaseState = state();
      releaseUrl = window.location.href;
      return;
    }
    const current = layers.find((layer) => layer.active && layer.id === marker());
    if (current === undefined) return;
    current.state = state();
    current.url = window.location.href;
  }

  return { register, captureRoute };
}

const coordinator = createMobileLayerHistoryCoordinator();

export const captureMobileLayerRoute = () => coordinator.captureRoute();

export function createMobileLayerHistoryService(options: {
  readonly isOpen: () => boolean;
  readonly close: () => unknown;
}) {
  let stop: WatchStopHandle | undefined;
  let release: (() => void) | undefined;
  let query: MediaQueryList | undefined;

  function sync(): void {
    const open = options.isOpen() && query?.matches;
    if (open && release === undefined) release = coordinator.register(options.close);
    else if (!open && release !== undefined) {
      const previous = release;
      release = undefined;
      previous();
    }
  }

  function start(): void {
    if (stop !== undefined) return;
    query = window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY);
    query.addEventListener('change', sync);
    stop = watch(options.isOpen, sync, { immediate: true, flush: 'post' });
  }

  function dispose(): void {
    stop?.();
    stop = undefined;
    query?.removeEventListener('change', sync);
    query = undefined;
    const previous = release;
    release = undefined;
    previous?.();
  }

  return { start, dispose };
}
