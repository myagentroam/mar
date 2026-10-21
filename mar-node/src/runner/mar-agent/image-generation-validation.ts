import { posix } from 'node:path';
import { MarAgentError } from '@myagentroam/agent';

export function validateImageGenerationConfiguration(configuration: {
  readonly imageGeneration?: {
    readonly provider: string;
    readonly config: Readonly<Record<string, string>>;
    readonly generateEndpoint: string;
    readonly editEndpoint: string;
    readonly imageModelId: string;
    readonly httpVersion: string;
    readonly credentialProvider?: unknown;
  };
}): void {
  const imageGeneration = configuration.imageGeneration;
  if (imageGeneration === undefined) return;
  let generateEndpoint: URL;
  let editEndpoint: URL;
  try {
    generateEndpoint = new URL(imageGeneration.generateEndpoint);
    editEndpoint = new URL(imageGeneration.editEndpoint);
  } catch {
    return invalidImageGenerationConfiguration();
  }
  if (
    (imageGeneration.provider !== undefined &&
      (imageGeneration.provider.trim().length === 0 || imageGeneration.provider.length > 64)) ||
    imageGeneration.credentialProvider === undefined ||
    imageGeneration.imageModelId.trim().length === 0 ||
    imageGeneration.imageModelId.length > 256 ||
    (imageGeneration.httpVersion !== '1.1' && imageGeneration.httpVersion !== '2') ||
    generateEndpoint.origin !== editEndpoint.origin ||
    !isAllowedImageGenerationEndpoint(generateEndpoint) ||
    !isAllowedImageGenerationEndpoint(editEndpoint)
  )
    invalidImageGenerationConfiguration();
}

export function normalizeGeneratedImageDisplayDirectory(
  value: string | undefined
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/\/+$/u, '');
  if (
    !normalized.startsWith('/') ||
    normalized === '/' ||
    normalized.length > 4096 ||
    normalized.includes('\0')
  )
    throw new MarAgentError(
      'MAR_AGENT_HOST_INCOMPATIBLE',
      'Generated image display directory is invalid.'
    );
  return normalized;
}

function isAllowedImageGenerationEndpoint(endpoint: URL): boolean {
  const loopback =
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '::1';
  return (
    endpoint.username.length === 0 &&
    endpoint.password.length === 0 &&
    endpoint.search.length === 0 &&
    endpoint.hash.length === 0 &&
    (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback))
  );
}

function invalidImageGenerationConfiguration(): never {
  throw new MarAgentError(
    'MAR_AGENT_MODEL_CONFIG_INVALID',
    'Model image generation configuration is invalid.'
  );
}
