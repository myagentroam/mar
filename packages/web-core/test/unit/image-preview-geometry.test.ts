import { describe, expect, it } from 'vitest';
import {
  boundPreviewTransform,
  FITTED_IMAGE_TRANSFORM,
  fitPreviewImage,
  MAX_IMAGE_ZOOM,
  zoomPreviewTransform
} from '../../src/util/image-preview-geometry.js';

describe('image preview geometry', () => {
  it('fits both axes proportionally without enlarging small images', () => {
    const viewport = { width: 300, height: 400 };
    expect(fitPreviewImage({ width: 900, height: 450 }, viewport)).toEqual({
      width: 300,
      height: 150
    });
    expect(fitPreviewImage({ width: 300, height: 800 }, viewport)).toEqual({
      width: 150,
      height: 400
    });
    expect(fitPreviewImage({ width: 30, height: 60 }, viewport)).toEqual({ width: 30, height: 60 });
  });

  it('keeps the image point under a moving pinch center when already panned', () => {
    const next = zoomPreviewTransform(
      { scale: 2, x: 15, y: -20 },
      4,
      { x: 20, y: 40 },
      { x: 30, y: 55 }
    );
    expect(next).toEqual({ scale: 4, x: 20, y: -65 });
  });

  it('clamps both the zoom and the position, trapping movement on fitted axes', () => {
    const center = { x: 0, y: 0 };
    expect(zoomPreviewTransform(FITTED_IMAGE_TRANSFORM, Infinity, center, center).scale).toBe(
      MAX_IMAGE_ZOOM
    );
    expect(zoomPreviewTransform({ scale: 2, x: 0, y: 0 }, 0.5, center, center).scale).toBe(1);
    expect(
      boundPreviewTransform(
        { scale: 2, x: -90, y: 200 },
        { width: 80, height: 200 },
        { width: 200, height: 200 }
      )
    ).toEqual({ scale: 2, x: 0, y: 100 });
  });
});
