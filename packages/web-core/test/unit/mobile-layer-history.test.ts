import { nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMobileLayerHistoryCoordinator,
  createMobileLayerHistoryService
} from '../../src/service/mobile-layer-history-service.js';

interface HistoryEntry {
  state: Record<string, unknown>;
  url: string;
}

class FakeHistory {
  readonly entries: HistoryEntry[];
  private index = 0;
  private readonly traversals: number[] = [];

  constructor(
    initialState: Record<string, unknown>,
    initialUrl: string,
    private readonly dispatchPopState: () => void
  ) {
    this.entries = [{ state: structuredClone(initialState), url: initialUrl }];
  }

  get state(): Record<string, unknown> {
    return this.entries[this.index]!.state;
  }

  get currentUrl(): string {
    return this.entries[this.index]!.url;
  }

  get queuedTraversals(): number {
    return this.traversals.length;
  }

  pushState(data: unknown, _title: string, url?: string | URL | null): void {
    const entry = this.makeEntry(data, url);
    this.entries.splice(this.index + 1);
    this.entries.push(entry);
    this.index += 1;
  }

  replaceState(data: unknown, _title: string, url?: string | URL | null): void {
    this.entries[this.index] = this.makeEntry(data, url);
  }

  back(): void {
    this.go(-1);
  }

  forward(): void {
    this.go(1);
  }

  go(delta: number): void {
    if (delta !== 0) this.traversals.push(delta);
  }

  flushTraversal(): boolean {
    const delta = this.traversals.shift();
    if (delta === undefined) return false;

    const nextIndex = this.index + delta;
    if (nextIndex < 0 || nextIndex >= this.entries.length) return true;

    this.index = nextIndex;
    this.dispatchPopState();
    return true;
  }

  private makeEntry(data: unknown, url?: string | URL | null): HistoryEntry {
    const nextUrl =
      url === undefined || url === null || String(url) === ''
        ? this.currentUrl
        : new URL(String(url), this.currentUrl).href;
    return { state: structuredClone(data) as Record<string, unknown>, url: nextUrl };
  }
}

interface FakeMediaQueryList {
  readonly matches: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setMatches(matches: boolean): void;
}

function createFakeMediaQuery(initialMatches: boolean): FakeMediaQueryList {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  return {
    get matches() {
      return matches;
    },
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener);
    },
    setMatches(next) {
      if (matches === next) return;
      matches = next;
      for (const listener of listeners) listener();
    }
  };
}

function installFakeBrowser(
  initialState: Record<string, unknown> = { page: 'workbench' },
  initialUrl = 'https://console.example/workspaces/w-17?tab=files#preview',
  mediaQuery = createFakeMediaQuery(false)
) {
  type Listener = EventListenerOrEventListenerObject;
  const listeners = new Map<string, Set<Listener>>();
  const windowObject: {
    addEventListener(type: string, listener: Listener | null): void;
    removeEventListener(type: string, listener: Listener | null): void;
    dispatchEvent(event: Event): boolean;
    history: FakeHistory;
    location: { readonly href: string };
    matchMedia(query: string): MediaQueryList;
  } = {
    addEventListener(type, listener) {
      if (listener === null) return;
      const entries = listeners.get(type) ?? new Set<Listener>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      if (listener !== null) listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        if (typeof listener === 'function') listener.call(windowObject, event);
        else listener.handleEvent(event);
      }
      return true;
    },
    history: undefined as unknown as FakeHistory,
    location: undefined as unknown as { readonly href: string },
    matchMedia: () => mediaQuery as unknown as MediaQueryList
  };
  const history = new FakeHistory(initialState, initialUrl, () => {
    windowObject.dispatchEvent(new Event('popstate'));
  });
  windowObject.history = history;
  windowObject.location = {
    get href() {
      return history.currentUrl;
    }
  };
  vi.stubGlobal('window', windowObject);

  return {
    history,
    mediaQuery,
    popstateListenerCount: () => listeners.get('popstate')?.size ?? 0
  };
}

function markerKey(state: Record<string, unknown>, routeState: Record<string, unknown>): string {
  const addedKeys = Object.keys(state).filter((key) => !(key in routeState));
  expect(addedKeys).toHaveLength(1);
  return addedKeys[0]!;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mobile temporary-layer history', () => {
  it('returns through nested layers one at a time', async () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17', selectedTab: 'files' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    let releaseParent = () => {};
    let releaseChild = () => {};
    const closeParent = vi.fn(() => releaseParent());
    const closeChild = vi.fn(() => releaseChild());

    releaseParent = coordinator.register(closeParent);
    const key = markerKey(browser.history.state, routeState);
    const parentToken = browser.history.state[key];
    releaseChild = coordinator.register(closeChild);
    const childToken = browser.history.state[key];

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state[key]).toBe(childToken);
    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();

    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state[key]).toBe(parentToken);
    expect(closeParent).not.toHaveBeenCalled();

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state[key]).toBe(parentToken);
    await flushMicrotasks();
    expect(closeParent).toHaveBeenCalledTimes(1);
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual(routeState);
  });

  it('restores the layer guard synchronously and ignores repeated returns while close is pending', async () => {
    const routeState = { page: 'workbench', draft: 'keep me' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    let resolveClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        })
    );
    const release = coordinator.register(close);
    const key = markerKey(browser.history.state, routeState);
    const token = browser.history.state[key];

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state[key]).toBe(token);
    expect(close).toHaveBeenCalledTimes(1);

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state[key]).toBe(token);
    await flushMicrotasks();
    expect(close).toHaveBeenCalledTimes(1);

    resolveClose();
    await flushMicrotasks();
    release();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual(routeState);
  });

  it('releasing a non-top layer does not move history or disturb the top layer', () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    const releaseParent = coordinator.register(closeParent);
    const key = markerKey(browser.history.state, routeState);
    const releaseChild = coordinator.register(closeChild);
    const childToken = browser.history.state[key];
    const childUrl = browser.history.currentUrl;

    releaseParent();

    expect(browser.history.queuedTraversals).toBe(0);
    expect(browser.history.state[key]).toBe(childToken);
    expect(browser.history.currentUrl).toBe(childUrl);
    expect(closeParent).not.toHaveBeenCalled();
    expect(closeChild).not.toHaveBeenCalled();

    releaseChild();
  });

  it('does not auto-skip the stale entry left by a released non-top layer', () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    const releaseParent = coordinator.register(vi.fn());
    const key = markerKey(browser.history.state, routeState);
    const parentToken = browser.history.state[key];
    const releaseChild = coordinator.register(vi.fn());

    releaseParent();
    releaseChild();
    expect(browser.history.queuedTraversals).toBe(1);
    expect(browser.history.flushTraversal()).toBe(true);

    expect(browser.history.state[key]).toBe(parentToken);
    expect(browser.history.queuedTraversals).toBe(0);
  });

  it('finishes parent cleanup when it is released during its child cleanup', () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    const releaseParent = coordinator.register(closeParent);
    const releaseChild = coordinator.register(closeChild);

    releaseChild();
    expect(browser.history.queuedTraversals).toBe(1);
    releaseParent();
    expect(browser.history.queuedTraversals).toBe(1);
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.queuedTraversals).toBe(1);
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual(routeState);
    expect(browser.history.queuedTraversals).toBe(0);
    expect(browser.popstateListenerCount()).toBe(0);
    expect(closeParent).not.toHaveBeenCalled();
    expect(closeChild).not.toHaveBeenCalled();
  });

  it('keeps a reopened preview independent of a released parent and child', () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    const releaseParent = coordinator.register(vi.fn());
    const key = markerKey(browser.history.state, routeState);
    const releaseChild = coordinator.register(vi.fn());
    releaseChild();
    releaseParent();
    const closeNew = vi.fn();
    const releaseNew = coordinator.register(closeNew);

    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toMatchObject(routeState);
    expect(browser.history.state[key]).toBeDefined();
    expect(browser.history.queuedTraversals).toBe(0);
    expect(closeNew).not.toHaveBeenCalled();
    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(closeNew).toHaveBeenCalledOnce();
    releaseNew();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual(routeState);
    expect(browser.history.queuedTraversals).toBe(0);
    expect(browser.popstateListenerCount()).toBe(0);
  });

  it('preserves current route updates while released parent and child entries drain', () => {
    const browser = installFakeBrowser({ route: 'old' });
    const coordinator = createMobileLayerHistoryCoordinator();
    const releaseParent = coordinator.register(vi.fn());
    const releaseChild = coordinator.register(vi.fn());
    releaseChild();
    releaseParent();
    const url = 'https://console.example/new?filter=active';
    browser.history.replaceState(
      { ...browser.history.state, route: 'new', filter: 'active' },
      '',
      url
    );
    coordinator.captureRoute();

    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual({ route: 'new', filter: 'active' });
    expect(browser.history.currentUrl).toBe(url);
    expect(browser.history.queuedTraversals).toBe(0);
    expect(browser.popstateListenerCount()).toBe(0);
  });

  it('isolates a reopened layer from a pending pop belonging to its previous instance', async () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    let resolveOldClose!: () => void;
    const closeOld = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOldClose = resolve;
        })
    );
    const releaseOld = coordinator.register(closeOld);
    const key = markerKey(browser.history.state, routeState);

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(closeOld).toHaveBeenCalledTimes(1);
    releaseOld();
    const closeNew = vi.fn();
    const releaseNew = coordinator.register(closeNew);
    await flushMicrotasks();
    expect(closeOld).toHaveBeenCalledTimes(1);

    expect(browser.history.flushTraversal()).toBe(true);
    const newToken = browser.history.state[key];
    expect(newToken).toBeDefined();
    expect(browser.history.queuedTraversals).toBe(0);

    browser.history.back();
    expect(browser.history.flushTraversal()).toBe(true);
    resolveOldClose();
    await flushMicrotasks();
    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(closeNew).toHaveBeenCalledTimes(1);
    releaseNew();
    expect(browser.history.flushTraversal()).toBe(true);
  });

  it('preserves route state and URL while releasing its own temporary entry', () => {
    const routeState = {
      page: 'workbench',
      route: { workspaceId: 'w-17', query: 'search=notes' },
      selection: ['file-a', 'file-b']
    };
    const url = 'https://console.example/workspaces/w-17?search=notes#file-a';
    const browser = installFakeBrowser(routeState, url);
    const coordinator = createMobileLayerHistoryCoordinator();
    const release = coordinator.register(vi.fn());

    expect(browser.history.state).toMatchObject(routeState);
    expect(browser.history.currentUrl).toBe(url);
    release();
    expect(browser.history.flushTraversal()).toBe(true);

    expect(browser.history.state).toEqual(routeState);
    expect(browser.history.currentUrl).toBe(url);
  });

  it('keeps child route changes after returning through the child and its parent', async () => {
    const browser = installFakeBrowser({ route: 'old' }, 'https://console.example/old');
    const coordinator = createMobileLayerHistoryCoordinator();
    let releaseParent = () => {};
    let releaseChild = () => {};
    releaseParent = coordinator.register(() => releaseParent());
    releaseChild = coordinator.register(() => releaseChild());
    const url = 'https://console.example/new?filter=active';
    browser.history.replaceState(
      { ...browser.history.state, route: 'new', filter: 'active' },
      '',
      url
    );
    coordinator.captureRoute();
    for (let i = 0; i < 2; i++) {
      browser.history.back();
      expect(browser.history.flushTraversal()).toBe(true);
      await flushMicrotasks();
      expect(browser.history.flushTraversal()).toBe(true);
      expect(browser.history.currentUrl).toBe(url);
    }
    expect(browser.history.state).toEqual({ route: 'new', filter: 'active' });
    expect(browser.history.queuedTraversals).toBe(0);
  });

  it('does not revive an unmounted layer when Forward reaches its stale entry', () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const browser = installFakeBrowser(routeState);
    const coordinator = createMobileLayerHistoryCoordinator();
    const close = vi.fn();
    const release = coordinator.register(close);
    const key = markerKey(browser.history.state, routeState);
    const staleToken = browser.history.state[key];

    release();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.state).toEqual(routeState);
    expect(browser.popstateListenerCount()).toBe(0);

    browser.history.forward();
    expect(browser.history.flushTraversal()).toBe(true);

    expect(browser.history.state[key]).toBe(staleToken);
    expect(browser.history.queuedTraversals).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(browser.popstateListenerCount()).toBe(0);
  });

  it('preserves route updates made while a button-close history release is pending', () => {
    const browser = installFakeBrowser({ route: 'old' });
    const coordinator = createMobileLayerHistoryCoordinator();
    const release = coordinator.register(vi.fn());
    release();
    const url = 'https://console.example/new';
    browser.history.replaceState({ ...browser.history.state, route: 'new' }, '', url);
    coordinator.captureRoute();
    expect(browser.history.flushTraversal()).toBe(true);
    expect(browser.history.currentUrl).toBe(url);
    expect(browser.history.state).toEqual({ route: 'new' });
  });

  it('keeps an open surface open while desktop/mobile history ownership changes', async () => {
    const routeState = { page: 'workbench', workspaceId: 'w-17' };
    const mediaQuery = createFakeMediaQuery(false);
    const browser = installFakeBrowser(routeState, undefined, mediaQuery);
    const isOpen = ref(true);
    const close = vi.fn();
    const service = createMobileLayerHistoryService({ isOpen: () => isOpen.value, close });

    service.start();
    await nextTick();
    expect(browser.history.entries).toHaveLength(1);

    mediaQuery.setMatches(true);
    expect(browser.history.entries).toHaveLength(2);
    expect(isOpen.value).toBe(true);

    mediaQuery.setMatches(false);
    expect(browser.history.queuedTraversals).toBe(1);
    expect(browser.history.flushTraversal()).toBe(true);
    await flushMicrotasks();
    expect(isOpen.value).toBe(true);
    expect(close).not.toHaveBeenCalled();

    mediaQuery.setMatches(true);
    expect(browser.history.state).toMatchObject(routeState);
    expect(isOpen.value).toBe(true);
    expect(close).not.toHaveBeenCalled();

    service.dispose();
    expect(browser.history.flushTraversal()).toBe(true);
    await flushMicrotasks();
    expect(isOpen.value).toBe(true);
  });
});
