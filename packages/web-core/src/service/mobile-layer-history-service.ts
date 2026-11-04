import { watch, type WatchStopHandle } from 'vue';
import { MOBILE_WORKBENCH_VIEWPORT_QUERY } from '../util/mobile-workbench.js';

const KEY = '__marTemporaryLayer';
let sequence = 0;

interface Layer {
  readonly id: string;
  readonly close: () => unknown;
  entryOwner: Layer | undefined;
  active: boolean;
  pending: boolean;
  entered: boolean;
  parent: unknown;
  parentUrl: string;
  state: Record<string, unknown>;
  url: string;
}

/** Owns temporary same-document entries, not application route navigation. */
export function createMobileLayerHistoryCoordinator() {
  const layers: Layer[] = [];
  let restoring:
    | {
        readonly layer: Layer;
        readonly url: string;
        ancestors: readonly { readonly marker: unknown; readonly url: string }[];
        remaining: number;
        route: { readonly state: Record<string, unknown>; readonly url: string } | undefined;
      }
    | undefined;
  let releasing = false;
  let releaseState: Record<string, unknown> | undefined;
  let releaseUrl = '';
  let listening = false;
  let releaseParent: unknown;
  let releaseParentUrl = '';

  function state(): Record<string, unknown> {
    return window.history.state ?? {};
  }

  function marker(): unknown {
    return state()[KEY];
  }

  function sync(): void {
    if (releasing || restoring !== undefined) return;
    const current = layers.find(
      (layer) => layer.id === marker() && layer.url === window.location.href
    );
    if (
      current !== undefined &&
      !current.active &&
      !layers.some((layer) => layer.active && layer.entryOwner === current)
    ) {
      releasing = true;
      releaseState = state();
      releaseUrl = window.location.href;
      releaseParent = current.parent;
      releaseParentUrl = current.parentUrl;
      window.history.back();
      return;
    }
    if (current !== undefined) {
      current.state = state();
      current.url = window.location.href;
    }
    for (const layer of layers) {
      if (!layer.active || layer.entered) continue;
      // Back-triggered close guards may mount asynchronously. Their nested
      // confirmation shares the restored entry instead of pushing without
      // fresh user activation and making all same-document entries skippable.
      if (current?.pending) {
        layer.entryOwner = current;
        layer.parent = current.parent;
        layer.parentUrl = current.parentUrl;
        layer.entered = true;
        continue;
      }
      layer.parent = marker();
      layer.parentUrl = window.location.href;
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
      if (marker() !== releaseParent || window.location.href !== releaseParentUrl) {
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
      captureRoute();
      sync();
      return;
    }
    if (restoring !== undefined) {
      const restoration = restoring;
      restoring = undefined;
      const top = restoration.layer;
      const entry = top.entryOwner ?? top;
      if (marker() !== entry.id || window.location.href !== restoration.url) {
        // A queued Back can overtake forward restoration. Resume only through
        // known ancestors, with a hop budget bounded by the owned chain.
        if (
          restoration.remaining > 0 &&
          restoration.ancestors.some(
            (ancestor) => ancestor.marker === marker() && ancestor.url === window.location.href
          )
        ) {
          restoration.remaining--;
          restoring = restoration;
          window.history.forward();
          return;
        }
        sync();
        return;
      }
      if (restoration.route !== undefined) {
        window.history.replaceState(restoration.route.state, '', restoration.route.url);
        entry.state = state();
        entry.url = window.location.href;
      }
      if (top.active) requestClose(top);
      sync();
      return;
    }
    const top = [...layers].reverse().find((layer) => layer.active && layer.entered);
    if (top === undefined) return;
    const entry = top.entryOwner ?? top;
    const ancestors: { marker: unknown; url: string }[] = [];
    for (let ancestor: Layer | undefined = entry; ancestor !== undefined;) {
      const parent: unknown = ancestor.parent;
      ancestors.push({ marker: parent, url: ancestor.parentUrl });
      ancestor = layers.find((layer) => layer.id === parent);
    }
    if (
      !ancestors.some(
        (ancestor) => ancestor.marker === marker() && ancestor.url === window.location.href
      )
    )
      return;
    // Reuse the departed entry before guarded close. Pushing from popstate
    // marks same-document entries skippable by Chromium's Back/gesture UI.
    restoring = {
      layer: top,
      url: entry.url,
      ancestors,
      remaining: ancestors.length,
      route: undefined
    };
    window.history.forward();
  }

  function requestClose(top: Layer): void {
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
      entryOwner: undefined,
      active: true,
      pending: false,
      entered: false,
      parent: marker(),
      parentUrl: window.location.href,
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
      if (
        layer.entered &&
        marker() !== layer.id &&
        restoring?.layer !== layer &&
        restoring?.layer.entryOwner !== layer &&
        !layers.some((child) => child.active && child.entryOwner === layer) &&
        !(releasing && releaseParent === layer.id)
      ) {
        // Non-top owners cannot prune history beneath a child. Once released,
        // their markers are ordinary expired state, not future cleanup orders.
        layers.splice(layers.indexOf(layer), 1);
      }
      // A child already being released will reach this parent next. Retain it
      // until that in-flight cleanup can finish both released owners in order.
      sync();
    };
  }

  function captureRoute(): void {
    if (
      restoring !== undefined &&
      restoring.ancestors.some((ancestor) => ancestor.marker === marker())
    ) {
      const entry = restoring.layer.entryOwner ?? restoring.layer;
      restoring.route = {
        state: { ...state(), [KEY]: entry.id },
        url: window.location.href
      };
      restoring.ancestors = restoring.ancestors.map((ancestor) =>
        ancestor.marker === marker() ? { ...ancestor, url: window.location.href } : ancestor
      );
    }
    if (releasing && (marker() === releaseState?.[KEY] || marker() === releaseParent)) {
      releaseState = state();
      releaseUrl = window.location.href;
      if (marker() === releaseParent) releaseParentUrl = window.location.href;
      return;
    }
    const current = layers.find((layer) => layer.id === marker());
    if (current !== undefined) {
      current.state = state();
      current.url = window.location.href;
    }
    for (const layer of layers) {
      // A captured route may update the parent while its child is restoring.
      if (layer.parent === marker()) layer.parentUrl = window.location.href;
    }
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
