import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { MarAgentError } from '../../error.js';
import type { ClientToolDefinition } from '../../model/contracts.js';
import type { ToolExecutionResult, ViewImageResult } from '../contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';
import { WorkspacePathResolver } from '../shared/path-resolver.js';
export type { ViewImageResult } from '../contracts.js';

export const viewImageToolDefinition: ClientToolDefinition = {
  name: 'view_image',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description: `Read one known local PNG, JPEG, or WebP image and provide its actual pixels to the vision-capable model. Relative paths use the workspace; absolute paths are allowed. The file must be a regular file no larger than ${TOOL_EXECUTION_LIMITS.viewImageMaxBytes} bytes. MIME is detected from file content, not its extension. Use this instead of installing OCR or converting the image through exec.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative workspace path or absolute image path.' }
    },
    required: ['path'],
    additionalProperties: false
  }
};

export class ViewImageTool {
  constructor(private readonly paths: WorkspacePathResolver) {}

  async execute(arguments_: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const input = parseViewImageInput(arguments_);
    signal?.throwIfAborted();
    const path = await this.paths.resolve(input.path);
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile())
        throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Path is not a regular file.');
      if (stat.size > BigInt(TOOL_EXECUTION_LIMITS.viewImageMaxBytes))
        throw new MarAgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          `Image exceeds the ${TOOL_EXECUTION_LIMITS.viewImageMaxBytes}-byte limit.`
        );
      signal?.throwIfAborted();
      const data = await handle.readFile();
      signal?.throwIfAborted();
      if (data.byteLength > TOOL_EXECUTION_LIMITS.viewImageMaxBytes)
        throw new MarAgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          `Image exceeds the ${TOOL_EXECUTION_LIMITS.viewImageMaxBytes}-byte limit.`
        );
      const after = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (
        stat.size !== after.size ||
        after.size !== BigInt(data.byteLength) ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.ctimeNs !== after.ctimeNs
      )
        return incompleteImage();
      const mimeType = detectImageMime(data);
      validateImageContainer(data, mimeType);
      const metadata: ViewImageResult = {
        path: input.path,
        mimeType,
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex')
      };
      return {
        content: `Viewed image ${input.path} (${mimeType}, ${data.byteLength} bytes).`,
        data: metadata,
        images: [{ mimeType, dataBase64: data.toString('base64') }]
      };
    } finally {
      await handle.close();
    }
  }
}

function parseViewImageInput(value: unknown): { path: string } {
  if (!value || typeof value !== 'object') return invalidInput();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== 'path') ||
    typeof input.path !== 'string' ||
    input.path.length === 0
  )
    return invalidInput();
  return { path: input.path };
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
  throw new MarAgentError(
    'MAR_AGENT_IMAGE_FORMAT_UNSUPPORTED',
    'Only PNG, JPEG, and WebP images are supported.'
  );
}

function invalidInput(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'View image input is invalid.');
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
  throw new MarAgentError(
    'MAR_AGENT_IMAGE_INCOMPLETE',
    'Image file is incomplete, malformed, or changed while reading. Wait for the writer to finish and read it again.'
  );
}
