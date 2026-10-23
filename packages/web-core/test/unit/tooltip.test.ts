import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentPublicInstance } from 'vue';
import { tableTooltipOptions, tooltipOptions } from '../../src/util/tooltip.js';

afterEach(() => vi.unstubAllGlobals());

describe('Shared Tooltip behavior', () => {
  it('uses passive hover/focus hints without consuming action keys', () => {
    expect(tooltipOptions.trigger).toEqual(['hover', 'focus']);
    expect(tooltipOptions.triggerKeys).toEqual([]);
    expect(tooltipOptions.popperClass).toBe('mar-tooltip');
    expect(tooltipOptions.showAfter).toBeGreaterThan(0);
    expect(tableTooltipOptions).not.toHaveProperty('ref');
    expect(tooltipOptions).toMatchObject(tableTooltipOptions);
  });

  it('closes through the public API on Escape without moving focus or intercepting other keys', () => {
    class Trigger extends EventTarget {
      hasAttribute = vi.fn(() => true);
    }
    vi.stubGlobal('HTMLElement', Trigger);
    const trigger = new Trigger();
    const onClose = vi.fn();
    const instance = {
      popperRef: { triggerRef: trigger },
      onClose
    } as unknown as ComponentPublicInstance;
    tooltipOptions.ref(instance);
    tooltipOptions.ref(instance);
    tooltipOptions.ref(null);
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
      trigger.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onClose).not.toHaveBeenCalled();
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    const stopPropagation = vi.spyOn(escape, 'stopPropagation');
    trigger.dispatchEvent(escape);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(escape);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(false);
    trigger.hasAttribute.mockReturnValue(false);
    stopPropagation.mockClear();
    trigger.dispatchEvent(escape);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
