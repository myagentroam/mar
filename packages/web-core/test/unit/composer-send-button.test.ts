import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import ComposerSendButton from '../../src/view/composer/ComposerSendButton.vue?unit-render';
import { renderComponent, textContent } from './support/component-renderer.js';

const mounted: { unmount(): void }[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture() {
  const send = vi.fn();
  const steer = vi.fn();
  const props = reactive({
    disabled: false,
    mobileViewport: true,
    canSteer: true,
    contextKey: 'run-a',
    label: 'Send',
    onSend: send,
    onSteer: steer
  });
  const view = renderComponent(ComposerSendButton, props);
  mounted.push(view);
  const button = view.findAll('button')[0]!;
  const capture = new Set<number>();
  const ownerDocument = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    defaultView: new EventTarget()
  });
  const surface = { top: 100 };
  const target = {
    ownerDocument,
    form: { getBoundingClientRect: () => ({ top: surface.top }) },
    setPointerCapture: (id: number) => capture.add(id),
    hasPointerCapture: (id: number) => capture.has(id),
    releasePointerCapture: (id: number) => capture.delete(id)
  };
  function event(overrides: Record<string, unknown> = {}) {
    return {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 200,
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides
    };
  }
  function fire(name: string, overrides: Record<string, unknown> = {}) {
    const input = event(overrides);
    if (['onPointerdown', 'onPointerup', 'onPointercancel'].includes(name)) {
      ownerDocument.dispatchEvent(
        Object.assign(new Event(name.slice(2).toLowerCase()), {
          pointerId: input.pointerId
        })
      );
    }
    (button.props[name] as (event: unknown) => void)(input);
    return input;
  }
  return { props, view, fire, send, steer, capture, ownerDocument, surface };
}

describe('mobile Composer send gesture', () => {
  it('keeps a short touch as one ordinary send', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(100);
    f.fire('onPointerup');
    f.fire('onClick', { detail: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.capture.size).toBe(0);
  });

  it.each([false, true])(
    'preserves touch focus and sends without a compatibility click (steer: %s)',
    async (canSteer) => {
      const f = fixture();
      f.props.canSteer = canSteer;
      await nextTick();
      f.fire('onPointerdown');
      const start = f.fire('onTouchstart');
      expect(start.preventDefault).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      f.fire('onPointerup');
      expect(f.send).toHaveBeenCalledTimes(1);
      f.fire('onClick', { detail: 1 });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.steer).not.toHaveBeenCalled();
    }
  );

  it.each([8, 12, 40, 80, 100])(
    'steers after sliding up %ipx within the Composer',
    async (distance) => {
      const f = fixture();
      f.fire('onPointerdown');
      vi.advanceTimersByTime(200);
      await nextTick();
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.view.findAll('span').some((node) => node.props['role'] === 'status')).toBe(true);
      f.fire('onPointermove', { clientY: 200 - distance });
      await nextTick();
      expect(textContent(f.view.root)).toMatch(/^(Release to steer|松手插入消息)/u);
      f.fire('onPointerup', { clientY: 200 - distance });
      f.fire('onClick', { detail: 1 });
      expect(f.steer).toHaveBeenCalledTimes(1);
      expect(f.send).not.toHaveBeenCalled();
    }
  );

  it('cancels above the Composer and lets the next tap send normally', async () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.fire('onPointermove', { clientY: 99 });
    await nextTick();
    expect(textContent(f.view.root)).toMatch(/^(Release to cancel|松手取消)$/u);
    f.fire('onPointerup', { clientY: 99 });
    f.fire('onClick', { detail: 1 });
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.fire('onPointerdown');
    f.fire('onPointerup');
    f.fire('onClick', { detail: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('restores steering when the held finger returns inside the Composer', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.fire('onPointermove', { clientY: 90 });
    f.fire('onPointermove', { clientY: 180 });
    f.fire('onPointerup', { clientY: 180 });
    expect(f.steer).toHaveBeenCalledTimes(1);
  });

  it('uses the release position even when no final pointermove arrives', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.fire('onPointerup', { clientY: 90 });
    f.fire('onClick', { detail: 1 });
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('suppresses the released touch click even if sending unmounts the button', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.fire('onPointerup');
    f.view.unmount();
    mounted.splice(mounted.indexOf(f.view), 1);
    const stop = vi.fn();
    f.ownerDocument.addEventListener('click', stop);
    const click = Object.assign(new Event('click', { cancelable: true }), { detail: 1 });
    f.ownerDocument.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.ownerDocument.dispatchEvent(Object.assign(new Event('click'), { detail: 1 }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not suppress a new deliberate pointer interaction after release', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.fire('onPointerup');
    f.ownerDocument.dispatchEvent(new Event('pointerdown'));
    const click = Object.assign(new Event('click', { cancelable: true }), { detail: 1 });
    f.ownerDocument.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses a click retargeted after the held button is removed before release', () => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    f.view.unmount();
    mounted.splice(mounted.indexOf(f.view), 1);
    f.ownerDocument.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
    const click = Object.assign(new Event('click', { cancelable: true }), { detail: 1 });
    f.ownerDocument.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(f.steer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['onPointercancel', 'onLostpointercapture', 'onBlur'])(
    'does not submit after %s',
    (event) => {
      const f = fixture();
      f.fire('onPointerdown');
      vi.advanceTimersByTime(200);
      f.fire(event);
      f.fire('onClick', { detail: 1 });
      expect(f.send).not.toHaveBeenCalled();
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.capture.size).toBe(0);
    }
  );

  it.each(['disabled', 'mobileViewport', 'canSteer', 'contextKey'] as const)(
    'cancels an ongoing hold when %s changes',
    async (key) => {
      const f = fixture();
      f.fire('onPointerdown');
      vi.advanceTimersByTime(200);
      if (key === 'contextKey') f.props.contextKey = 'run-b';
      else f.props[key] = key === 'disabled';
      await nextTick();
      f.fire('onPointerup');
      f.fire('onClick', { detail: 1 });
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.capture.size).toBe(0);
    }
  );

  it.each(['hidden', 'window-blur'])('cancels a held message on %s', (mode) => {
    const f = fixture();
    f.fire('onPointerdown');
    vi.advanceTimersByTime(200);
    if (mode === 'hidden') {
      f.ownerDocument.visibilityState = 'hidden';
      f.ownerDocument.dispatchEvent(new Event('visibilitychange'));
    } else {
      f.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
    }
    f.fire('onPointerup');
    f.fire('onClick', { detail: 1 });
    expect(f.steer).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.capture.size).toBe(0);
  });

  it.each([0, 40, 110])(
    'provides the idle send gesture at %ipx without steering',
    async (distance) => {
      const f = fixture();
      f.props.canSteer = false;
      await nextTick();
      f.fire('onPointerdown');
      vi.advanceTimersByTime(200);
      await nextTick();
      expect(textContent(f.view.root)).toMatch(/^(Release to send|松手发送)/u);
      expect(f.send).not.toHaveBeenCalled();
      f.fire('onPointermove', { clientY: 200 - distance });
      f.fire('onPointerup', { clientY: 200 - distance });
      f.fire('onClick', { detail: 1 });
      expect(f.send).toHaveBeenCalledTimes(distance <= 100 ? 1 : 0);
      expect(f.steer).not.toHaveBeenCalled();
    }
  );

  it.each([0, 7, -20])(
    'keeps a held release ordinary without an upward swipe (%ipx)',
    (distance) => {
      const f = fixture();
      f.fire('onPointerdown');
      vi.advanceTimersByTime(250);
      f.fire('onPointerup', { clientY: 200 - distance });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.steer).not.toHaveBeenCalled();
    }
  );

  it('recognizes an upward swipe without waiting for the hold timer', () => {
    const f = fixture();
    f.fire('onPointerdown');
    f.fire('onPointermove', { clientY: 180 });
    f.fire('onPointerup', { clientY: 180 });
    expect(f.steer).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('returns to ordinary sending when the finger slides back to its starting position', () => {
    const f = fixture();
    f.fire('onPointerdown');
    f.fire('onPointermove', { clientY: 180 });
    f.fire('onPointerup');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.steer).not.toHaveBeenCalled();
  });

  it.each([80, 180])('uses the current Composer top at %ipx instead of a fixed distance', (top) => {
    const f = fixture();
    f.fire('onPointerdown');
    f.surface.top = top;
    f.fire('onPointerup', { clientY: 90 });
    expect(f.steer).toHaveBeenCalledTimes(top === 80 ? 1 : 0);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('does not arm for a mouse or desktop viewport', async () => {
    for (const mode of ['mouse', 'desktop']) {
      const f = fixture();
      if (mode === 'desktop') f.props.mobileViewport = false;
      await nextTick();
      f.fire('onPointerdown', { pointerType: mode === 'mouse' ? 'mouse' : 'touch' });
      vi.advanceTimersByTime(500);
      f.fire('onPointerup');
      f.fire('onClick', { detail: 1 });
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.send).toHaveBeenCalledTimes(1);
    }
  });

  it('clears the hold timer and pointer capture when unmounted', () => {
    const f = fixture();
    f.fire('onPointerdown');
    f.view.unmount();
    mounted.splice(mounted.indexOf(f.view), 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.capture.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(f.steer).not.toHaveBeenCalled();
  });
});
