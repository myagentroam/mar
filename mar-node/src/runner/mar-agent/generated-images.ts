import { posix, resolve } from 'node:path';
import type { NativeTranscriptImageAttachment } from '../../native-transcript-model.js';
import type { MarAgentGeneratedImageArtifact } from './conversation-normalizer.js';

const HOSTED_CONVERSATION_IMAGE_RUN_PREFIX = 'native-history:hosted:';
const HOSTED_CONVERSATION_SANDBOX_HOME = '/home/mar';

export function marAgentGeneratedImagesDirectory(
  homeDirectory: string,
  sessionId: string
): string | undefined {
  if (!safePathSegment(sessionId)) return undefined;
  return resolve(homeDirectory, '.mar', 'agent', 'sessions', sessionId, 'generated_images');
}

export function hostedConversationImageRunId(conversationId: string): string {
  return `${HOSTED_CONVERSATION_IMAGE_RUN_PREFIX}${conversationId}`;
}

export function hostedConversationGeneratedImagesDisplayDirectory(
  sessionId: string
): string | undefined {
  if (!safePathSegment(sessionId)) return undefined;
  return posix.join(
    HOSTED_CONVERSATION_SANDBOX_HOME,
    '.mar',
    'agent',
    'sessions',
    sessionId,
    'generated_images'
  );
}

export function isHostedConversationImageRunId(runId: string): boolean {
  return runId.startsWith(HOSTED_CONVERSATION_IMAGE_RUN_PREFIX);
}

export function marAgentGeneratedImageSources(
  homeDirectory: string,
  sessionId: string,
  artifacts: readonly MarAgentGeneratedImageArtifact[]
): readonly NativeTranscriptImageAttachment[] {
  const directory = marAgentGeneratedImagesDirectory(homeDirectory, sessionId);
  if (directory === undefined) return [];
  return artifacts.flatMap((artifact) =>
    safePathSegment(artifact.fileName)
      ? [
          {
            name: artifact.name,
            mime: artifact.mime,
            sourceId: `${sessionId}:${artifact.fileName}`,
            localPath: resolve(directory, artifact.fileName)
          }
        ]
      : []
  );
}

function safePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}
