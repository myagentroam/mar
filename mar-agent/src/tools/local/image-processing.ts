import { AgentError } from '../../error.js';
import type { ViewImageRegion, ViewImageResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';

export interface ImageResizeBounds {
  maxWidth?: number;
  maxHeight?: number;
}

export interface ImageMetadata {
  width: number;
  height: number;
  pages: number;
  mimeType: ViewImageResult['mimeType'];
}

export interface ProcessedImage {
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: ViewImageResult['mimeType'];
  sourceWidth?: number;
  sourceHeight?: number;
  region?: ViewImageRegion;
}

export async function readImageMetadata(
  data: Buffer,
  mimeType: ViewImageResult['mimeType'],
  signal?: AbortSignal
): Promise<ImageMetadata> {
  throwIfAborted(signal);
  try {
    const sharp = await loadSharp();
    const metadata = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: TOOL_EXECUTION_LIMITS.viewImageMaxPixels,
      pages: 1
    }).metadata();
    throwIfAborted(signal);
    if (
      metadata.format !== expectedSharpFormat(mimeType) ||
      !isPositiveSafeInteger(metadata.width) ||
      !isPositiveSafeInteger(metadata.height)
    )
      return incompleteImage();
    const width = metadata.autoOrient?.width ?? metadata.width;
    const height = metadata.autoOrient?.height ?? metadata.height;
    assertPixelLimit(width, height);
    return { width, height, pages: metadata.pages ?? 1, mimeType };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AgentError) throw error;
    if (isPixelLimitError(error)) return imagePixelLimit();
    return incompleteImage();
  }
}

export async function processImage(
  data: Buffer,
  metadata: ImageMetadata,
  options: { region?: ViewImageRegion; resize?: ImageResizeBounds },
  signal?: AbortSignal
): Promise<ProcessedImage> {
  throwIfAborted(signal);
  if (metadata.pages > 1)
    throw new AgentError(
      'MAR_AGENT_IMAGE_FORMAT_UNSUPPORTED',
      'Animated images cannot be cropped or resized.'
    );

  const region = options.region;
  const regionWidth = region?.width ?? metadata.width;
  const regionHeight = region?.height ?? metadata.height;
  const resize = options.resize;

  try {
    const sharp = await loadSharp();
    const image = sharp(data, {
      failOn: 'warning',
      limitInputPixels: TOOL_EXECUTION_LIMITS.viewImageMaxPixels,
      pages: 1,
      autoOrient: true
    });
    if (region)
      image.extract({
        left: region.x,
        top: region.y,
        width: region.width,
        height: region.height
      });
    if (resize) {
      image.resize({
        ...(resize.maxWidth === undefined ? {} : { width: Math.min(resize.maxWidth, regionWidth) }),
        ...(resize.maxHeight === undefined
          ? {}
          : { height: Math.min(resize.maxHeight, regionHeight) }),
        fit: 'inside',
        withoutEnlargement: true
      });
    }
    switch (metadata.mimeType) {
      case 'image/png':
        image.png();
        break;
      case 'image/jpeg':
        image.jpeg({ quality: 90 });
        break;
      case 'image/webp':
        image.webp({ quality: 90 });
        break;
    }
    const output = await image.toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    if (output.data.byteLength > TOOL_EXECUTION_LIMITS.viewImageMaxBytes) throw imageOutputLimit();

    const changedRegion =
      region !== undefined &&
      (region.x !== 0 ||
        region.y !== 0 ||
        region.width !== metadata.width ||
        region.height !== metadata.height);
    const changedSize = output.info.width !== regionWidth || output.info.height !== regionHeight;
    return {
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
      mimeType: metadata.mimeType,
      ...(changedRegion || changedSize
        ? { sourceWidth: metadata.width, sourceHeight: metadata.height }
        : {}),
      ...(changedRegion ? { region } : {})
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AgentError) throw error;
    if (isPixelLimitError(error)) return imagePixelLimit();
    return incompleteImage();
  }
}

function expectedSharpFormat(mimeType: ViewImageResult['mimeType']): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
  }
}

function assertPixelLimit(width: number, height: number): void {
  if (
    !isPositiveSafeInteger(width) ||
    !isPositiveSafeInteger(height) ||
    width > Math.floor(TOOL_EXECUTION_LIMITS.viewImageMaxPixels / height)
  )
    imagePixelLimit();
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit/iu.test(error.message);
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function imageOutputLimit(): AgentError {
  return new AgentError(
    'MAR_AGENT_TOOL_OUTPUT_LIMIT',
    `Image output exceeds ${TOOL_EXECUTION_LIMITS.viewImageMaxBytes} bytes. Use a smaller resize or region.`
  );
}

function imagePixelLimit(): never {
  throw new AgentError(
    'MAR_AGENT_TOOL_OUTPUT_LIMIT',
    `Image exceeds the source pixel-area limit (equivalent to ${Math.sqrt(TOOL_EXECUTION_LIMITS.viewImageMaxPixels)}×${Math.sqrt(TOOL_EXECUTION_LIMITS.viewImageMaxPixels)} pixels).`
  );
}

function incompleteImage(): never {
  throw new AgentError(
    'MAR_AGENT_IMAGE_INCOMPLETE',
    'Image file is incomplete, malformed, or changed while reading. Wait for the writer to finish and read it again.'
  );
}

async function loadSharp(): Promise<typeof import('sharp').default> {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new AgentError(
      'MAR_AGENT_IMAGE_PROCESSING_UNAVAILABLE',
      'Native image processing is unavailable because the sharp dependency could not be loaded.'
    );
  }
}
