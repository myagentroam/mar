import type { CDPSession } from 'playwright';

const levels = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200] as const;

/** Owns the layout zoom of one remote tab, isolated from the page's JS state. */
export class BrowserPageZoom {
  private script: string | undefined;
  private index = 4;

  get percent(): number {
    return levels[this.index]!;
  }

  async change(
    connect: () => Promise<CDPSession>,
    direction: 'in' | 'out' | 'reset'
  ): Promise<void> {
    const next = direction === 'reset' ? 4 : this.index + (direction === 'in' ? 1 : -1);
    const percent = levels[next];
    if (!percent || next === this.index) return;
    const session = await connect();
    const previous = this.script;
    if (!previous) await session.send('Page.enable');
    const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: zoomScript(percent / 100),
      worldName: 'mar-tab-zoom',
      runImmediately: true
    });
    this.script = identifier;
    this.index = next;
    if (previous)
      await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous });
  }
}

// Keep injected JavaScript independent of build-time transforms and their helpers.
function zoomScript(factor: number): string {
  return `(() => {
  if (window !== window.top) return;
  const world = globalThis;
  world.marClearZoom?.();
  delete world.marClearZoom;
  const factor = ${factor};
  if (factor === 1) return;
  function apply() {
    const root = document.documentElement;
    if (!root) return;
    const { style } = root;
    if (!style) return;
    const original = style.getPropertyValue('zoom');
    const priority = style.getPropertyPriority('zoom');
    const zoom = String(factor);
    style.setProperty('zoom', zoom, 'important');
    world.marClearZoom = () => {
      if (style.getPropertyValue('zoom') === zoom && style.getPropertyPriority('zoom') === 'important')
        style.setProperty('zoom', original, priority);
    };
  }
  if (document.documentElement) apply();
  else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      apply();
    });
    observer.observe(document, { childList: true });
    world.marClearZoom = () => observer.disconnect();
  }
  })();`;
}
