import type { ClientToolDefinition } from '../contracts.js';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { AgentError } from '../../error.js';

import type { ToolExecutionResult, ViewImageRegion, ViewImageResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
import { processImage, readImageMetadata, type ImageResizeBounds } from './image-processing.js';
export type { ViewImageResult } from '../contracts.js';

export const viewImageToolDefinition: ClientToolDefinition = {
  name: 'view_image',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'View a PNG, JPEG, or WebP image by path or Session resourceId. Relative paths use the workspace; absolute paths are allowed. Use this tool instead of converting images through exec.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative workspace path or absolute image path.' },
      resourceId: { type: 'string', description: 'Session image resource ID, instead of path.' },
      region: {
        type: 'object',
        description:
          'For close inspection of a specific area; coordinates use oriented source pixels.',
        properties: {
          x: { type: 'integer', minimum: 0 },
          y: { type: 'integer', minimum: 0 },
          width: { type: 'integer', minimum: 1 },
          height: { type: 'integer', minimum: 1 }
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false
      },
      resize: {
        type: 'object',
        description:
          'For a smaller overview; fit the image or cropped region within these dimensions without enlargement.',
        properties: {
          maxWidth: { type: 'integer', minimum: 1 },
          maxHeight: { type: 'integer', minimum: 1 }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
};

export class ViewImageTool {
  constructor(private readonly paths: WorkspacePathResolver) {}

  async execute(arguments_: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const input = parseViewImageInput(arguments_);
    if (input.path === undefined) return invalidInput();
    signal?.throwIfAborted();
    const path = await this.paths.resolve(input.path);
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile())
        throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Path is not a regular file.');
      if (stat.size > BigInt(TOOL_EXECUTION_LIMITS.viewImageMaxSourceBytes))
        throw new AgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          `Image exceeds the ${TOOL_EXECUTION_LIMITS.viewImageMaxSourceBytes}-byte source limit. Use an external image tool to reduce it first.`
        );
      const hasTransform = input.region !== undefined || input.resize !== undefined;
      if (!hasTransform && stat.size > BigInt(TOOL_EXECUTION_LIMITS.viewImageMaxBytes))
        throw imageOutputLimit('Image exceeds 3 MiB. Use resize or region.');
      signal?.throwIfAborted();
      const data = Buffer.allocUnsafe(Number(stat.size));
      let offset = 0;
      while (offset < data.byteLength) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
        if (bytesRead === 0) incompleteImage();
        offset += bytesRead;
      }
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (
        stat.size !== after.size ||
        after.size !== BigInt(data.byteLength) ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.ctimeNs !== after.ctimeNs
      )
        return incompleteImage();
      return await renderViewImage(data, input, signal);
    } finally {
      await handle.close();
    }
  }
}

/** Resolve Session-owned bytes without using the resource's public URL or original path. */
export async function viewResourceImage(
  arguments_: unknown,
  readResource: (resourceId: string) => Promise<{ dataBase64: string } | undefined>,
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  const input = parseViewImageInput(arguments_);
  if (input.resourceId === undefined) return invalidInput();
  signal?.throwIfAborted();
  const resource = await readResource(input.resourceId);
  signal?.throwIfAborted();
  if (!resource)
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Image resource was not found in this Session.'
    );
  const data = Buffer.from(resource.dataBase64, 'base64');
  if (data.length > TOOL_EXECUTION_LIMITS.viewImageMaxSourceBytes)
    throw imageOutputLimit('Image exceeds the source limit.');
  if (!input.region && !input.resize && data.length > TOOL_EXECUTION_LIMITS.viewImageMaxBytes)
    throw imageOutputLimit('Image exceeds 3 MiB. Use resize or region.');
  return renderViewImage(data, input, signal);
}

async function renderViewImage(
  data: Buffer,
  input: ViewImageInput,
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  const mimeType = detectImageMime(data);
  validateImageContainer(data, mimeType);
  const sourceMetadata = await readImageMetadata(data, mimeType, signal);
  if (
    input.region &&
    (input.region.x > sourceMetadata.width ||
      input.region.y > sourceMetadata.height ||
      input.region.width > sourceMetadata.width - input.region.x ||
      input.region.height > sourceMetadata.height - input.region.y)
  )
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Image region is outside the oriented source dimensions.'
    );

  const visual =
    input.region !== undefined || input.resize !== undefined
      ? await processImage(data, sourceMetadata, input, signal)
      : {
          bytes: data,
          width: sourceMetadata.width,
          height: sourceMetadata.height,
          mimeType
        };
  signal?.throwIfAborted();
  const resultMetadata: ViewImageResult = {
    ...(input.path ? { path: input.path } : { resourceId: input.resourceId! }),
    mimeType: visual.mimeType,
    bytes: visual.bytes.byteLength,
    width: visual.width,
    height: visual.height,
    ...('sourceWidth' in visual && visual.sourceWidth !== undefined
      ? { sourceWidth: visual.sourceWidth, sourceHeight: visual.sourceHeight }
      : {}),
    ...('region' in visual && visual.region ? { region: visual.region } : {}),
    sha256: createHash('sha256').update(visual.bytes).digest('hex')
  };
  return {
    content: describeImageResult(resultMetadata),
    data: resultMetadata,
    images: [{ mimeType: visual.mimeType, dataBase64: visual.bytes.toString('base64') }]
  };
}

type ViewImageInput = {
  path?: string;
  resourceId?: string;
  region?: ViewImageRegion;
  resize?: ImageResizeBounds;
};

function parseViewImageInput(value: unknown): ViewImageInput {
  if (!value || typeof value !== 'object') return invalidInput();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['path', 'resourceId', 'region', 'resize'].includes(key)) ||
    (input.path == null) === (input.resourceId == null) ||
    (input.path != null && (typeof input.path !== 'string' || input.path.length === 0)) ||
    (input.resourceId != null &&
      (typeof input.resourceId !== 'string' || input.resourceId.length === 0))
  )
    return invalidInput();
  return {
    ...(typeof input.path === 'string'
      ? { path: input.path }
      : { resourceId: input.resourceId as string }),
    ...(input.region == null ? {} : { region: parseRegion(input.region) }),
    ...(input.resize == null ? {} : { resize: parseResize(input.resize) })
  };
}

function parseRegion(value: unknown): ViewImageRegion {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['x', 'y', 'width', 'height'].includes(key)) ||
    !Number.isSafeInteger(value.x) ||
    (value.x as number) < 0 ||
    !Number.isSafeInteger(value.y) ||
    (value.y as number) < 0 ||
    !isPositiveSafeInteger(value.width) ||
    !isPositiveSafeInteger(value.height)
  )
    return invalidInput();
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width,
    height: value.height
  };
}

function parseResize(value: unknown): ImageResizeBounds {
  if (
    !isRecord(value) ||
    (value.maxWidth == null && value.maxHeight == null) ||
    Object.keys(value).some((key) => key !== 'maxWidth' && key !== 'maxHeight') ||
    (value.maxWidth != null && !isPositiveSafeInteger(value.maxWidth)) ||
    (value.maxHeight != null && !isPositiveSafeInteger(value.maxHeight))
  )
    return invalidInput();
  return {
    ...(value.maxWidth == null ? {} : { maxWidth: value.maxWidth as number }),
    ...(value.maxHeight == null ? {} : { maxHeight: value.maxHeight as number })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function describeImageResult(result: ViewImageResult): string {
  const details = [`${result.width}×${result.height} px`, result.mimeType, `${result.bytes} bytes`];
  if (result.sourceWidth !== undefined && result.sourceHeight !== undefined)
    details.push(`source ${result.sourceWidth}×${result.sourceHeight} px`);
  if (result.region)
    details.push(
      `region ${result.region.x},${result.region.y} ${result.region.width}×${result.region.height} px`
    );
  return `Viewed image ${result.path ?? result.resourceId} (${details.join(', ')}).`;
}

function imageOutputLimit(message: string): AgentError {
  return new AgentError('MAR_AGENT_TOOL_OUTPUT_LIMIT', message);
}

export function detectImageMime(data: Buffer): ViewImageResult['mimeType'] {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  throw new AgentError(
    'MAR_AGENT_IMAGE_FORMAT_UNSUPPORTED',
    'Only PNG, JPEG, and WebP images are supported.'
  );
}

function invalidInput(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'View image input is invalid.');
}

// Basic container checks catch partial writes without decoding or changing pixels.
function validateImageContainer(data: Buffer, mimeType: ViewImageResult['mimeType']): void {
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    let inScan = false;
    let hasScan = false;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) {
        if (!inScan) incompleteImage();
        continue;
      }
      while (data[offset] === 0xff) offset++;
      if (offset >= data.length) incompleteImage();
      const marker = data[offset++]!;
      if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
        if (!inScan) incompleteImage();
        continue;
      }
      if (marker === 0xd9) {
        if (!hasScan) incompleteImage();
        return;
      }
      if (marker === 0xd8) incompleteImage();
      if (marker === 1) continue;
      if (data.length - offset < 2) incompleteImage();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) incompleteImage();
      offset += length;
      if (marker === 0xda) hasScan = true;
      inScan = marker === 0xda || (inScan && marker === 0xdc);
    }
    incompleteImage();
  }
  if (mimeType === 'image/webp') {
    const end = data.readUInt32LE(4) + 8;
    if (end > data.length || end < 20) incompleteImage();
    let offset = 12;
    let hasPixels = false;
    while (offset < end) {
      if (end - offset < 8) incompleteImage();
      const length = data.readUInt32LE(offset + 4);
      const next = offset + 8 + length + (length % 2);
      if (next > end) incompleteImage();
      const type = data.toString('ascii', offset, offset + 4);
      if ((type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') && length > 0) hasPixels = true;
      offset = next;
    }
    if (!hasPixels) incompleteImage();
    return;
  }
  let offset = 8;
  let hasPixels = false;
  while (offset < data.length) {
    if (data.length - offset < 12) incompleteImage();
    const length = data.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > data.length) incompleteImage();
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (offset === 8) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        data.readUInt32BE(offset + 8) === 0 ||
        data.readUInt32BE(offset + 12) === 0
      )
        incompleteImage();
    } else if (type === 'IHDR') incompleteImage();
    if (type === 'IDAT' && length > 0) hasPixels = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasPixels) incompleteImage();
      return;
    }
    offset = next;
  }
  incompleteImage();
}

function incompleteImage(): never {
  throw new AgentError(
    'MAR_AGENT_IMAGE_INCOMPLETE',
    'Image file is incomplete, malformed, or changed while reading. Wait for the writer to finish and read it again.'
  );
}
