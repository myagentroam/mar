export interface ImagePreviewSize {
  readonly width: number;
  readonly height: number;
}

export interface ImagePreviewPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImagePreviewTransform extends ImagePreviewPoint {
  readonly scale: number;
}

export const FITTED_IMAGE_TRANSFORM = { scale: 1, x: 0, y: 0 };
export const MAX_IMAGE_ZOOM = 8;

export function fitPreviewImage(
  natural: ImagePreviewSize,
  viewport: ImagePreviewSize
): ImagePreviewSize {
  if (!natural.width || !natural.height) return natural;
  const scale = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

export function previewPanBounds(
  scale: number,
  fitted: ImagePreviewSize,
  viewport: ImagePreviewSize
): ImagePreviewPoint {
  return {
    x: Math.max(0, (fitted.width * scale - viewport.width) / 2),
    y: Math.max(0, (fitted.height * scale - viewport.height) / 2)
  };
}

export function boundPreviewTransform(
  transform: ImagePreviewTransform,
  fitted: ImagePreviewSize,
  viewport: ImagePreviewSize
): ImagePreviewTransform {
  const bounds = previewPanBounds(transform.scale, fitted, viewport);
  return {
    scale: transform.scale,
    x: bounds.x === 0 ? 0 : Math.max(-bounds.x, Math.min(bounds.x, transform.x)),
    y: bounds.y === 0 ? 0 : Math.max(-bounds.y, Math.min(bounds.y, transform.y))
  };
}

// Coordinates are relative to the viewport center. Move the same image point
// from the old anchor to the new one, subject to the visible image edges.
export function zoomPreviewTransform(
  transform: ImagePreviewTransform,
  targetScale: number,
  from: ImagePreviewPoint,
  to: ImagePreviewPoint
): ImagePreviewTransform {
  const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, targetScale));
  const ratio = scale / transform.scale;
  return {
    scale,
    x: to.x - (from.x - transform.x) * ratio,
    y: to.y - (from.y - transform.y) * ratio
  };
}
