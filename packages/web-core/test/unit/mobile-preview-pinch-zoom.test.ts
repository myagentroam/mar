import { describe, expect, it } from 'vitest';
import { createMobilePreviewPinchZoom } from '../../src/util/mobile-preview-pinch-zoom';

function touch(pointerId: number, clientX: number, clientY: number): PointerEvent {
  return {
    pointerId,
    pointerType: 'touch',
    clientX,
    clientY,
    cancelable: true,
    preventDefault: () => undefined
  } as PointerEvent;
}

describe('Mobile preview two-finger zoom', () => {
  it('Zooms only with two fingers and clamps the range to 25% through 200%', () => {
    const zoom = createMobilePreviewPinchZoom();
    zoom.pointerDown(touch(1, 0, 0));
    zoom.pointerMove(touch(1, 25, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('1');

    zoom.pointerDown(touch(2, 100, 0));
    zoom.pointerMove(touch(2, 137.5, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('1.5');

    zoom.pointerMove(touch(2, 500, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('2');
    zoom.pointerMove(touch(2, 25, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('0.25');
  });

  it('does not treat single-finger movement as zooming after a two-finger gesture ends', () => {
    const zoom = createMobilePreviewPinchZoom();
    zoom.pointerDown(touch(1, 0, 0));
    zoom.pointerDown(touch(2, 100, 0));
    zoom.pointerMove(touch(2, 150, 0));
    zoom.pointerEnd(touch(2, 150, 0));
    zoom.pointerMove(touch(1, 300, 0));

    expect(zoom.style.value['--mar-preview-zoom']).toBe('1.5');
  });

  it('Starts zooming after a valid distance is obtained when the two fingers begin at the same point', () => {
    const zoom = createMobilePreviewPinchZoom();
    zoom.pointerDown(touch(1, 0, 0));
    zoom.pointerDown(touch(2, 0, 0));
    zoom.pointerMove(touch(2, 100, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('1');

    zoom.pointerMove(touch(2, 150, 0));
    expect(zoom.style.value['--mar-preview-zoom']).toBe('1.5');
  });
});
