import { dirname } from 'node:path';
import {
  MarAgentError,
  type LocalAgentExecutionExtensions,
  type MarAgentHost
} from '@myagentroam/agent';
import {
  codexImageGenToolDefinition,
  bytedArkImageGenToolDefinition,
  executeCodexImageGen,
  type ImageGenerationConfiguration
} from './image-generation.js';
import { marAgentGeneratedImagesDirectory } from './generated-images.js';
import {
  normalizeGeneratedImageDisplayDirectory,
  validateImageGenerationConfiguration
} from './image-generation-validation.js';

export function createImageGenerationExtensions(input: {
  readonly configuration?: ImageGenerationConfiguration | undefined;
  readonly homeDirectory: string;
  readonly displayDirectory?: string;
  readonly host: () => MarAgentHost;
}): LocalAgentExecutionExtensions {
  const imageGeneration = input.configuration;
  if (imageGeneration === undefined) return {};
  validateImageGenerationConfiguration({ imageGeneration });
  const displayDirectory = normalizeGeneratedImageDisplayDirectory(input.displayDirectory);
  const codex = imageGeneration.provider === 'CODEX';
  if (!codex && imageGeneration.provider !== 'BYTED_ARK')
    throw new MarAgentError('MAR_AGENT_MODEL_CONFIG_INVALID', 'Unsupported image provider.');
  const tool = codex ? codexImageGenToolDefinition : bytedArkImageGenToolDefinition;
  return {
    tools: [tool],
    skills: [
      {
        name: codex ? 'codex-imagegen' : 'byted_ark-imagegen',
        description: codex
          ? 'Generate or edit raster images with codex_image_gen only when explicitly requested. Load before calling the image tool.'
          : 'Generate or edit one image with byted_ark_image_gen only when explicitly requested. Load before calling the image tool.',
        requiredTools: [tool.name],
        load: async () =>
          codex
            ? (await import('./codex-imagegen-skill.js')).codexImagegenSkill()
            : (await import('./byted-ark-imagegen-skill.js')).bytedArkImagegenSkill()
      }
    ],
    executeTool: async (call, context) => {
      if (call.name !== tool.name)
        throw new MarAgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Image tool is unavailable.');
      context.signal.throwIfAborted();
      const directory = marAgentGeneratedImagesDirectory(input.homeDirectory, context.sessionId);
      if (directory === undefined || call.callId === undefined)
        throw new MarAgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'Image execution identity is invalid.'
        );
      return executeCodexImageGen(call.arguments, {
        configuration: { imageGeneration },
        sessionDirectory: dirname(directory),
        ...(displayDirectory === undefined ? {} : { displayDirectory }),
        callId: call.callId,
        signal: context.signal,
        recentImages: context.recentImages ?? [],
        readImage: async (path) => {
          const output = await input
            .host()
            .executeTool({ name: 'view_image', arguments: { path } }, context);
          const image = output.images?.length === 1 ? output.images[0] : undefined;
          if (image === undefined || image.dataBase64 === undefined)
            throw new MarAgentError(
              'MAR_AGENT_TOOL_OUTPUT_INVALID',
              'Referenced image result is invalid.'
            );
          const data = Buffer.from(image.dataBase64, 'base64');
          if (data.byteLength === 0)
            throw new MarAgentError(
              'MAR_AGENT_TOOL_OUTPUT_INVALID',
              'Referenced image result is invalid.'
            );
          return { mimeType: image.mimeType, data };
        }
      });
    }
  };
}
