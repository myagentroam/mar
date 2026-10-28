import {
  serializeComposerTag,
  parseComposerTags,
  type ComposerAttachmentFile
} from '@myagentroam/protocol';
import type { NodeMessageAttachmentInput } from '../runtime-model.js';
import { isPlainRecord } from '../util/records.js';

const MAX_COMPOSER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_ATTACHMENTS_BYTES = 10 * 1024 * 1024;

export type RunnerImageAttachment = NodeMessageAttachmentInput & {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

const COMPOSER_IMAGE_MIME_TYPES = new Set<RunnerImageAttachment['mime']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

export function parseComposerAttachmentUpload(
  input: Record<string, unknown>
): { readonly id: string; readonly name: string; readonly mime: string } | undefined {
  if (input.composerAttachmentId === undefined && input.mime === undefined) return undefined;
  if (
    typeof input.composerAttachmentId !== 'string' ||
    !isUuid(input.composerAttachmentId) ||
    typeof input.name !== 'string' ||
    !validComposerAttachmentName(input.name) ||
    typeof input.mime !== 'string' ||
    input.mime.length === 0 ||
    input.mime.length > 120
  )
    throw new Error('COMPOSER_ATTACHMENT_INVALID');
  return { id: input.composerAttachmentId, name: input.name, mime: input.mime };
}

export function parseComposerAttachmentIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some((id) => typeof id !== 'string'))
    throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  const ids = value as string[];
  if (ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length)
    throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  return ids;
}

export function validComposerAttachmentName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || '<>:"|?*'.includes(character);
    })
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseMessageAttachments(value: unknown): readonly NodeMessageAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
  let totalBytes = 0;
  return value.map((attachment): NodeMessageAttachmentInput => {
    if (!isPlainRecord(attachment)) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    if (
      typeof attachment.name !== 'string' ||
      typeof attachment.mime !== 'string' ||
      typeof attachment.dataBase64 !== 'string'
    )
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    if (
      !validComposerAttachmentName(attachment.name) ||
      attachment.mime.length === 0 ||
      attachment.mime.length > 120 ||
      !isCanonicalBase64(attachment.dataBase64)
    )
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    const byteSize = Buffer.byteLength(attachment.dataBase64, 'base64');
    if (byteSize === 0 || byteSize > MAX_COMPOSER_ATTACHMENT_BYTES)
      throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    totalBytes += byteSize;
    if (totalBytes > MAX_COMPOSER_ATTACHMENTS_BYTES) throw new Error('MESSAGE_ATTACHMENTS_INVALID');
    return { name: attachment.name, mime: attachment.mime, dataBase64: attachment.dataBase64 };
  });
}

export function parseRunnerImageAttachments(value: unknown): readonly RunnerImageAttachment[] {
  return parseMessageAttachments(value).map((attachment) => {
    if (!isRunnerImageAttachment(attachment)) throw new Error('MESSAGE_ATTACHMENT_UNSUPPORTED');
    return attachment as RunnerImageAttachment;
  });
}

export function isRunnerImageAttachment(
  attachment: NodeMessageAttachmentInput
): attachment is RunnerImageAttachment {
  return COMPOSER_IMAGE_MIME_TYPES.has(attachment.mime as RunnerImageAttachment['mime']);
}

export function isImageAttachment(attachment: NodeMessageAttachmentInput): boolean {
  return attachment.mime.startsWith('image/');
}

export function withNonImageAttachmentPrompt(
  input: string,
  paths: readonly string[],
  files?: readonly ComposerAttachmentFile[]
): string {
  if (paths.length === 0) return input;
  const tag = serializeComposerTag('mar_attachments', {
    files: files
      ? [...files]
      : paths.map((path) => ({
          name: path.split(/[\\/]/u).at(-1)!,
          mime: 'application/octet-stream',
          path
        }))
  });
  const body = parseComposerTags(input)
    .filter((part) => part.kind !== 'mar_attachments')
    .map((part) => (part.kind === 'text' ? part.text : part.raw))
    .join('')
    .trimEnd();
  return `${body}\n${tag}`;
}

export function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
