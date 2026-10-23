import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipService } from '../../src/service/TooltipService.js';
import { tableTooltipOptions } from '../../src/util/tooltip.js';

// These Node fakes exercise coordinator decisions, not browser layout or tooltip rendering.
interface TestEvent {
  readonly type: string;
  readonly target: FakeElement | null;
  readonly relatedTarget?: FakeElement | null | undefined;
  readonly pointerType?: string | undefined;
  readonly buttons?: number | undefined;
  readonly detail?: number | undefined;
  readonly key?: string | undefined;
  readonly isComposing?: boolean | undefined;
  immediatePropagationStopped: boolean;
  stopImmediatePropagation(): void;
}

type TestListener = EventListenerOrEventListenerObject;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<TestListener>>();

  addEventListener(type: string, listener: TestListener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<TestListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestListener | null): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  protected emit(event: TestEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (typeof listener === 'function') listener.call(this, event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
      if (event.immediatePropagationStopped) break;
    }
  }

  dispatch(
    type: string,
    init: Partial<
      Omit<TestEvent, 'type' | 'immediatePropagationStopped' | 'stopImmediatePropagation'>
    > = {}
  ): TestEvent {
    const event: TestEvent = {
      type,
      target: init.target ?? null,
      relatedTarget: init.relatedTarget,
      pointerType: init.pointerType,
      buttons: init.buttons,
      detail: init.detail,
      key: init.key,
      isComposing: init.isComposing,
      immediatePropagationStopped: false,
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      }
    };
    this.emit(event);
    return event;
  }
}

class FakeElement extends FakeEventTarget {
  parentElement: FakeElement | null = null;
  isConnected = true;
  private readonly attributes = new Map<string, string>();

  getClientRects(): DOMRectList {
    return [{}] as unknown as DOMRectList;
  }

  closest(selector: string): FakeElement | null {
    if (selector !== '[inert]') return null;
    if (this.hasAttribute('inert')) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  contains(other: FakeElement | null): boolean {
    for (let element = other; element; element = element.parentElement)
      if (element === this) return true;
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeWindow extends FakeEventTarget {
  getComputedStyle(): CSSStyleDeclaration {
    return { visibility: 'visible' } as CSSStyleDeclaration;
  }
}

class FakeDocument extends FakeEventTarget {
  readonly defaultView = new FakeWindow();
  activeElement: FakeElement | null = null;
  hidden = false;
}

class FakeMutationObserver {
  constructor(_callback: MutationCallback) {}

  observe(_target: Element, _options?: MutationObserverInit): void {}

  disconnect(): void {}
}

const descriptionId = 'shared-tooltip';
const cleanups: Array<() => void> = [];

function createCoordinator() {
  const document = new FakeDocument();
  const service = new TooltipService(document as unknown as Document);
  const cleanup = service.connect(descriptionId);
  cleanups.push(cleanup);
  return { document, service, cleanup };
}

function pointerOver(document: FakeDocument, target: FakeElement, pointerType = 'mouse'): void {
  document.dispatch('pointerover', { target, pointerType, buttons: 0 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('MutationObserver', FakeMutationObserver);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TooltipService', () => {
  it('waits before showing and lets the most recently entered target win', () => {
    const { document, service } = createCoordinator();
    const first = new FakeElement();
    const second = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;

    service.update(first as unknown as Element, 'First hint');
    service.update(second as unknown as Element, 'Second hint');
    pointerOver(document, first);
    vi.advanceTimersByTime(showAfter - 1);
    expect(service.active.value).toBeUndefined();

    pointerOver(document, second);
    vi.advanceTimersByTime(1);
    expect(service.active.value).toBeUndefined();
    vi.advanceTimersByTime(showAfter - 1);
    expect(service.active.value).toMatchObject({ content: 'Second hint', target: second });
  });

  it('updates visible content and removes disabled hints from future targeting', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;

    service.update(target as unknown as Element, 'Initial hint');
    pointerOver(document, target);
    vi.advanceTimersByTime(showAfter);
    target.setAttribute('aria-describedby', 'vue-updated-description');
    service.update(target as unknown as Element, { content: 'Updated hint', placement: 'bottom' });
    expect(service.active.value).toMatchObject({ content: 'Updated hint', placement: 'bottom' });
    expect(target.getAttribute('aria-describedby')).toBe(
      `vue-updated-description ${descriptionId}`
    );

    service.update(target as unknown as Element, { content: 'Updated hint', disabled: true });
    expect(service.active.value).toBeUndefined();
    pointerOver(document, target);
    vi.advanceTimersByTime(showAfter);
    expect(service.active.value).toBeUndefined();
  });

  it('merges its description id without replacing menu accessibility attributes', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;
    target.setAttribute('aria-describedby', 'menu-description');
    target.setAttribute('aria-haspopup', 'menu');
    target.setAttribute('aria-expanded', 'true');

    service.update(target as unknown as Element, 'Menu action hint');
    pointerOver(document, target);
    vi.advanceTimersByTime(showAfter);
    expect(target.getAttribute('aria-describedby')).toBe(`menu-description ${descriptionId}`);
    expect(target.getAttribute('aria-haspopup')).toBe('menu');
    expect(target.getAttribute('aria-expanded')).toBe('true');

    service.remove(target as unknown as Element);
    expect(target.getAttribute('aria-describedby')).toBe('menu-description');
  });

  it('removes the active target and disconnects document event handling on cleanup', () => {
    const { document, service, cleanup } = createCoordinator();
    const removed = new FakeElement();
    const remaining = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;
    service.update(removed as unknown as Element, 'Removable hint');
    service.update(remaining as unknown as Element, { content: 'Remaining hint', touch: true });

    pointerOver(document, removed);
    vi.advanceTimersByTime(showAfter);
    service.remove(removed as unknown as Element);
    expect(service.active.value).toBeUndefined();

    pointerOver(document, remaining);
    vi.advanceTimersByTime(showAfter);
    expect(service.active.value).toMatchObject({ content: 'Remaining hint', target: remaining });
    cleanup();
    expect(service.active.value).toBeUndefined();

    pointerOver(document, remaining);
    document.dispatch('click', { target: remaining, pointerType: 'touch', detail: 1 });
    vi.advanceTimersByTime(showAfter);
    expect(service.active.value).toBeUndefined();
  });

  it('does not consume ordinary keys or Escape until a hint is visible', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;
    const laterKeyHandler = vi.fn();
    document.addEventListener('keydown', laterKeyHandler);
    service.update(target as unknown as Element, 'Keyboard hint');

    const enter = document.dispatch('keydown', { key: 'Enter' });
    expect(enter.immediatePropagationStopped).toBe(false);
    expect(laterKeyHandler).toHaveBeenCalledTimes(1);

    pointerOver(document, target);
    const pendingEscape = document.dispatch('keydown', { key: 'Escape' });
    expect(pendingEscape.immediatePropagationStopped).toBe(false);
    expect(laterKeyHandler).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(showAfter);
    expect(service.active.value).toBeUndefined();

    pointerOver(document, target);
    vi.advanceTimersByTime(showAfter);
    const activeEnter = document.dispatch('keydown', { key: 'Enter' });
    expect(activeEnter.immediatePropagationStopped).toBe(false);
    expect(laterKeyHandler).toHaveBeenCalledTimes(3);

    const composingEscape = document.dispatch('keydown', { key: 'Escape', isComposing: true });
    expect(composingEscape.immediatePropagationStopped).toBe(false);
    expect(laterKeyHandler).toHaveBeenCalledTimes(4);
    expect(service.active.value).toMatchObject({ content: 'Keyboard hint', target });

    const activeEscape = document.dispatch('keydown', { key: 'Escape' });
    expect(activeEscape.immediatePropagationStopped).toBe(true);
    expect(laterKeyHandler).toHaveBeenCalledTimes(4);
    expect(service.active.value).toBeUndefined();
  });

  it('does not show a hint while the document is hidden', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    service.update(target as unknown as Element, 'Background hint');
    document.hidden = true;

    pointerOver(document, target);
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);

    expect(service.active.value).toBeUndefined();
  });

  it('does not activate hints from touch hover or touch-following focus', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    service.update(target as unknown as Element, 'Touch target hint');

    document.dispatch('pointerdown', { target, pointerType: 'touch' });
    pointerOver(document, target, 'touch');
    document.activeElement = target;
    document.dispatch('focusin', { target });
    document.dispatch('click', { target, pointerType: 'touch', detail: 1 });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);

    expect(service.active.value).toBeUndefined();
  });

  it('opens opted-in details on a completed touch tap without requiring focus', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const child = new FakeElement();
    child.parentElement = target;
    service.update(target as unknown as Element, { content: 'Touch details', touch: true });

    document.dispatch('pointerdown', { target: child, pointerType: 'touch' });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter * 2);
    expect(service.active.value).toBeUndefined();
    document.dispatch('click', { target: child, pointerType: 'touch', detail: 1 });
    document.dispatch('pointerout', { target: child, pointerType: 'touch' });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    expect(service.active.value).toMatchObject({ content: 'Touch details', target });

    document.dispatch('pointerdown', { target: new FakeElement(), pointerType: 'touch' });
    expect(service.active.value).toBeUndefined();
    expect(target.hasAttribute('aria-describedby')).toBe(false);
  });

  it('supports touch-generated MouseEvent clicks but not keyboard or programmatic clicks', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    service.update(target as unknown as Element, { content: 'Touch details', touch: true });
    document.dispatch('pointerdown', { target, pointerType: 'touch' });
    document.dispatch('click', { target, detail: 0 });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    expect(service.active.value).toBeUndefined();
    document.dispatch('click', { target, detail: 1 });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    expect(service.active.value?.target).toBe(target);
    document.dispatch('scroll');
    expect(service.active.value).toBeUndefined();
  });

  it('keeps focus-owned hints open across pointer exit, then closes on focus exit', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;
    const hideAfter = tableTooltipOptions.hideAfter;
    service.update(target as unknown as Element, 'Focused hint');
    document.activeElement = target;
    document.dispatch('focusin', { target });
    vi.advanceTimersByTime(showAfter);

    pointerOver(document, target);
    document.dispatch('pointerout', { target, relatedTarget: null });
    vi.advanceTimersByTime(hideAfter * 2);
    expect(service.active.value).toMatchObject({ content: 'Focused hint', target });

    document.activeElement = null;
    document.dispatch('focusout', { target, relatedTarget: null });
    vi.advanceTimersByTime(hideAfter);
    expect(service.active.value).toBeUndefined();
  });

  it('keeps pointer-owned hints when the same target loses focus', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const showAfter = tableTooltipOptions.showAfter;
    const hideAfter = tableTooltipOptions.hideAfter;
    service.update(target as unknown as Element, 'Pointer hint');
    pointerOver(document, target);
    vi.advanceTimersByTime(showAfter);

    document.activeElement = target;
    document.dispatch('focusin', { target });
    const other = new FakeElement();
    document.activeElement = other;
    document.dispatch('focusout', { target, relatedTarget: other });
    document.dispatch('focusin', { target: other });
    vi.advanceTimersByTime(hideAfter * 2);
    expect(service.active.value).toMatchObject({ content: 'Pointer hint', target });

    document.dispatch('pointerout', { target, relatedTarget: null });
    vi.advanceTimersByTime(hideAfter);
    expect(service.active.value).toBeUndefined();
  });

  it('does not reopen an escaped hint when moving between descendants of the same control', () => {
    const { document, service } = createCoordinator();
    const target = new FakeElement();
    const child = new FakeElement();
    child.parentElement = target;
    service.update(target as unknown as Element, 'Control hint');
    pointerOver(document, target);
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    document.dispatch('keydown', { target, key: 'Escape' });
    document.dispatch('pointerover', {
      target: child,
      relatedTarget: target,
      pointerType: 'mouse'
    });
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    expect(service.active.value).toBeUndefined();
    pointerOver(document, child);
    vi.advanceTimersByTime(tableTooltipOptions.showAfter);
    expect(service.active.value?.content).toBe('Control hint');
  });
});
