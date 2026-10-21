import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, posix } from 'node:path';
import {
  MarAgentError,
  type ClientToolDefinition,
  type ModelCredentialProvider,
  type ModelCredentialAcquireReason,
  type ToolExecutionResult
} from '@myagentroam/agent';
import {
  requestHttp,
  acquireCredential,
  appendCredentialHeaders
} from '@myagentroam/agent/host/network';

export interface ImageGenerationConfiguration {
  readonly provider: string;
  readonly config: Readonly<Record<string, string>>;
  readonly generateEndpoint: string;
  readonly editEndpoint: string;
  readonly imageModelId: string;
  readonly httpVersion: '1.1' | '2';
  readonly credentialProvider: ModelCredentialProvider;
}

interface ToolRuntimeImage {
  readonly mimeType: string;
  readonly data: Buffer;
}
const IMAGE_MAX_BYTES = 20_971_520;

const RESPONSE_MAX_BYTES = Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4096;
const RESERVED_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'x-codex-image-turn-id'
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_EDIT_IMAGES = 5;
const SUPPORTED_EDIT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_GENERATION_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const IMAGE_GENERATION_READ_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export const codexImageGenToolDefinition: ClientToolDefinition = {
  name: 'codex_image_gen',
  agentScope: 'ROOT_ONLY',
  allowedCallers: ['direct', 'programmatic'],
  parallelSafety: 'safe',
  description:
    'Only when the user requests or explicitly authorizes image generation or editing, use the configured Codex Images API. First load and follow skill({name:"codex-imagegen"}); reload if its guidance is no longer in context. Do not generate unsolicited visuals. Omit both selectors for a new image without references. For image inputs, inspect unseen local images with view_image when available; TEXT-only models must not claim visual inspection. Use referenced_image_paths when every image has an absolute path; otherwise use num_last_images_to_include for the smallest sufficient number of currently available conversation images. Never provide both selectors. Include at most five images; if required inputs are missing, ask for them rather than silently omitting them. Recent images are in-memory in the current Execution, not a permanent history library. One PNG is saved in the current Session and its path is returned, not inspected pixels. Use view_image when available to check the result; otherwise report that visual acceptance was not performed. Full workflow guidance is in the codex-imagegen skill.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 32_768 },
      referenced_image_paths: {
        type: 'array',
        maxItems: MAX_EDIT_IMAGES,
        items: {
          type: 'string',
          description: 'Absolute local path of an image to edit.'
        }
      },
      num_last_images_to_include: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_EDIT_IMAGES,
        description: 'Number of most recent in-memory conversation images to edit.'
      }
    },
    required: ['prompt'],
    additionalProperties: false
  }
};

export const bytedArkImageGenToolDefinition: ClientToolDefinition = {
  ...codexImageGenToolDefinition,
  name: 'byted_ark_image_gen',
  description:
    'Generate or edit one PNG using the configured Ark Images API, only when explicitly requested. First load skill({name:"byted_ark-imagegen"}). Omit both selectors for text-to-image; use absolute referenced_image_paths or num_last_images_to_include for image-to-image, never both. Up to five references, exactly one output; no group generation. Returns a managed image path, not inspected pixels.'
};

export async function executeCodexImageGen(
  arguments_: unknown,
  input: {
    readonly configuration: {
      readonly imageGeneration: ImageGenerationConfiguration;
      readonly credentialProvider?: ModelCredentialProvider;
    };
    readonly sessionDirectory: string;
    readonly displayDirectory?: string;
    readonly callId: string;
    readonly signal: AbortSignal;
    readonly readImage: (path: string) => Promise<ToolRuntimeImage>;
    readonly recentImages: readonly ToolRuntimeImage[];
  }
): Promise<ToolExecutionResult> {
  input.signal.throwIfAborted();
  const capability = input.configuration.imageGeneration;
  if (capability === undefined || capability.credentialProvider === undefined)
    throw new MarAgentError(
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'Image generation requires an independent credential provider.'
    );
  const request = parseInput(arguments_);
  const images = await selectedEditImages(request, input);
  const ark = capability.provider === 'BYTED_ARK';
  if (!ark && capability.provider !== 'CODEX')
    throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Unsupported image provider.');
  const endpoint = images.length === 0 ? capability.generateEndpoint : capability.editEndpoint;
  const body = JSON.stringify(
    ark
      ? {
          model: capability.imageModelId,
          prompt: request.prompt,
          ...(images.length === 0
            ? {}
            : {
                image:
                  images.length === 1
                    ? `data:${images[0]!.mimeType};base64,${images[0]!.data.toString('base64')}`
                    : images.map(
                        (image) => `data:${image.mimeType};base64,${image.data.toString('base64')}`
                      )
              }),
          size: '2K',
          output_format: 'png',
          response_format: 'b64_json',
          watermark: false,
          stream: false,
          sequential_image_generation: 'disabled'
        }
      : {
          ...(images.length === 0
            ? {}
            : {
                images: images.map((image) => ({
                  image_url: `data:${image.mimeType};base64,${image.data.toString('base64')}`
                }))
              }),
          prompt: request.prompt,
          background: 'auto',
          model: capability.imageModelId,
          n: 1,
          quality: 'auto',
          size: 'auto'
        }
  );
  const turnId = randomUUID();
  let reason: ModelCredentialAcquireReason = 'REQUEST';
  for (let authenticationAttempt = 0; authenticationAttempt < 2; authenticationAttempt++) {
    let credentialRevision: number | undefined;
    const response = await requestHttp(
      endpoint,
      async () => {
        const credential = await waitForImageStep(
          acquireCredential(
            { credentialProvider: capability.credentialProvider },
            reason,
            'Image generation requires a credential.'
          ),
          input.signal
        );
        credentialRevision = credential.revision;
        const headers = appendCredentialHeaders(
          new Headers({
            authorization: `Bearer ${credential.bearer.reveal()}`,
            accept: 'application/json',
            'content-type': 'application/json',
            ...(ark ? {} : { 'x-codex-image-turn-id': turnId })
          }),
          credential,
          RESERVED_HEADERS
        );
        return {
          request: {
            method: 'POST',
            headers,
            body,
            redirect: 'manual'
          },
          httpVersion: capability.httpVersion,
          ...(credential.socks5Url === undefined
            ? {}
            : { socks5Url: credential.socks5Url.reveal() })
        };
      },
      input.signal,
      IMAGE_GENERATION_RESPONSE_TIMEOUT_MS
    );
    if (!ark && response.status === 401 && authenticationAttempt === 0) {
      await response.body?.cancel().catch(() => undefined);
      if (credentialRevision !== undefined)
        await capability.credentialProvider.invalidate(credentialRevision);
      reason = 'UNAUTHORIZED';
      continue;
    }
    const payload = await readJsonResponse(response, input.signal);
    if (!response.ok) throw imageGenerationResponseError(response.status, payload);
    const encoded = imageBase64(payload);
    const data = decodePng(encoded);
    const fileName = generatedFileName(input.callId);
    const directory = join(input.sessionDirectory, 'generated_images');
    const path = join(directory, fileName);
    const displayPath =
      input.displayDirectory === undefined ? path : posix.join(input.displayDirectory, fileName);
    input.signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    try {
      input.signal.throwIfAborted();
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      input.signal.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    return {
      content: `Generated image saved to ${displayPath}.\n`,
      artifacts: [
        {
          kind: 'image',
          name: fileName,
          mimeType: 'image/png',
          byteSize: data.byteLength,
          sha256,
          fileName
        }
      ]
    };
  }
  throw new MarAgentError('MAR_AGENT_IMAGE_GENERATION_FAILED', 'Image generation failed.');
}

interface CodexImageGenInput {
  readonly prompt: string;
  readonly referencedImagePaths?: readonly string[];
  readonly numLastImagesToInclude?: number;
}

function parseInput(value: unknown): CodexImageGenInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidInput();
  const input = value as Record<string, unknown>;
  const referencedImagePaths =
    input.referenced_image_paths === null ? undefined : input.referenced_image_paths;
  const numLastImagesToInclude =
    input.num_last_images_to_include === null ? undefined : input.num_last_images_to_include;
  if (
    Object.keys(input).some(
      (key) =>
        key !== 'prompt' && key !== 'referenced_image_paths' && key !== 'num_last_images_to_include'
    ) ||
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length === 0 ||
    input.prompt.length > 32_768 ||
    (referencedImagePaths !== undefined &&
      (!Array.isArray(referencedImagePaths) ||
        referencedImagePaths.length > MAX_EDIT_IMAGES ||
        referencedImagePaths.some(
          (path) =>
            typeof path !== 'string' || path.length === 0 || path.length > 4096 || !isAbsolute(path)
        ))) ||
    (numLastImagesToInclude !== undefined &&
      (!Number.isInteger(numLastImagesToInclude) ||
        (numLastImagesToInclude as number) < 1 ||
        (numLastImagesToInclude as number) > MAX_EDIT_IMAGES))
  )
    return invalidInput();
  const paths = referencedImagePaths as string[] | undefined;
  if (paths?.length && numLastImagesToInclude !== undefined) return invalidInput();
  return {
    prompt: input.prompt,
    ...(paths?.length ? { referencedImagePaths: [...paths] } : {}),
    ...(numLastImagesToInclude === undefined
      ? {}
      : { numLastImagesToInclude: numLastImagesToInclude as number })
  };
}

async function selectedEditImages(
  request: CodexImageGenInput,
  input: {
    readonly readImage: (path: string) => Promise<ToolRuntimeImage>;
    readonly recentImages: readonly ToolRuntimeImage[];
  }
): Promise<ToolRuntimeImage[]> {
  if (request.referencedImagePaths !== undefined) {
    const images: ToolRuntimeImage[] = [];
    for (const path of request.referencedImagePaths)
      images.push(validateEditImage(await input.readImage(path)));
    return images;
  }
  if (request.numLastImagesToInclude === undefined) return [];
  const images = input.recentImages.slice(-request.numLastImagesToInclude);
  if (images.length !== request.numLastImagesToInclude)
    throw new MarAgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      `Requested the last ${request.numLastImagesToInclude} conversation images, but only ${images.length} were available.`
    );
  return images.map(validateEditImage);
}

function validateEditImage(image: ToolRuntimeImage): ToolRuntimeImage {
  if (
    !SUPPORTED_EDIT_MIME_TYPES.has(image.mimeType) ||
    !Buffer.isBuffer(image.data) ||
    image.data.byteLength === 0 ||
    image.data.byteLength > IMAGE_MAX_BYTES
  )
    throw new MarAgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Referenced image is invalid or unsupported.'
    );
  return { mimeType: image.mimeType, data: Buffer.from(image.data) };
}

async function readJsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new MarAgentError(
      'MAR_AGENT_TOOL_OUTPUT_LIMIT',
      'Image response exceeded the size limit.'
    );
  }
  if (response.body === null) return {};
  const reader = response.body.getReader();
  const readController = new AbortController();
  const readSignal = AbortSignal.any([signal, readController.signal]);
  const abort = () => {
    void reader.cancel(readSignal.reason).catch(() => undefined);
  };
  readSignal.addEventListener('abort', abort, { once: true });
  const onIdle = () => {
    readController.abort(
      new MarAgentError(
        'MAR_AGENT_IMAGE_GENERATION_READ_TIMEOUT',
        'Image response body read timed out waiting for data.',
        {
          details: {
            reason: 'IMAGE_RESPONSE_READ_TIMEOUT',
            idleTimeoutMs: IMAGE_GENERATION_READ_IDLE_TIMEOUT_MS
          }
        }
      )
    );
  };
  let readTimeout = setTimeout(onIdle, IMAGE_GENERATION_READ_IDLE_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    readSignal.throwIfAborted();
    for (;;) {
      const chunk = await waitForImageStep(reader.read(), readSignal);
      readSignal.throwIfAborted();
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;
      clearTimeout(readTimeout);
      readTimeout = setTimeout(onIdle, IMAGE_GENERATION_READ_IDLE_TIMEOUT_MS);
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES)
        throw new MarAgentError(
          'MAR_AGENT_TOOL_OUTPUT_LIMIT',
          'Image response exceeded the size limit.'
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(readTimeout);
    readSignal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (cause) {
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID',
      'Image response is invalid.',
      { cause }
    );
  }
}

async function waitForImageStep<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function imageBase64(value: unknown): string {
  const data =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : undefined;
  const first =
    data?.length === 1 && data[0] !== null && typeof data[0] === 'object' && !Array.isArray(data[0])
      ? (data[0] as { b64_json?: unknown }).b64_json
      : undefined;
  if (typeof first !== 'string' || first.length === 0 || first.length > RESPONSE_MAX_BYTES)
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID',
      'Image response is invalid.'
    );
  return first;
}

function decodePng(encoded: string): Buffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID',
      'Image response is invalid.'
    );
  const data = Buffer.from(encoded, 'base64');
  if (
    data.byteLength === 0 ||
    data.byteLength > IMAGE_MAX_BYTES ||
    data.toString('base64') !== encoded ||
    !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    throw new MarAgentError(
      'MAR_AGENT_IMAGE_GENERATION_RESPONSE_INVALID',
      'Image response is not a supported PNG.'
    );
  return data;
}

function generatedFileName(callId: string): string {
  const normalized = callId
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/gu, '_')
    .replace(/^[_\-.]+|[_\-.]+$/gu, '')
    .slice(0, 96);
  const stem =
    normalized.length > 0 ? normalized : createHash('sha256').update(callId).digest('hex');
  const fileName = `${stem.startsWith('image_') ? stem : `image_${stem}`}.png`;
  return basename(fileName);
}

function imageGenerationResponseError(status: number, value: unknown): MarAgentError {
  const error =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { error?: unknown }).error
      : undefined;
  const record =
    error !== null && typeof error === 'object' && !Array.isArray(error)
      ? (error as { code?: unknown; message?: unknown })
      : undefined;
  const fallbackMessage = `Image generation failed with HTTP ${status}.`;
  const rawCode = typeof record?.code === 'string' ? record.code.trim() : '';
  const code = /^[a-zA-Z0-9._-]{1,80}$/u.test(rawCode)
    ? rawCode
    : 'MAR_AGENT_IMAGE_GENERATION_FAILED';
  const rawMessage = typeof record?.message === 'string' ? record.message.trim() : '';
  const message =
    rawMessage.length > 0 &&
    rawMessage.length <= 1_000 &&
    !/\b(?:authorization|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|proxy-authorization|chatgpt-account-id)\b|socks5:\/\//iu.test(
      rawMessage
    )
      ? rawMessage
      : fallbackMessage;
  return new MarAgentError(code, message, { details: { status } });
}

function invalidInput(): never {
  throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Image generation input is invalid.');
}
