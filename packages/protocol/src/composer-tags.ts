import { z } from 'zod';
import {
  composerMarkupEnd,
  escapeMarkup,
  markupAttributes,
  parseComposerMarkup
} from './composer-markup.js';

const path = z.string().min(1).max(4096);
const name = z.string().min(1).max(512);
const MAX_COMPOSER_TAG_BYTES = 128 * 1024;
export const channelDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
export const channelOriginSchema = z
  .object({
    source: z.literal('WEB_SHARE'),
    channelId: z.string().min(1).max(128),
    senderId: z.string().min(1).max(128),
    name: channelDisplayNameSchema
  })
  .strict();
export type ChannelOrigin = z.infer<typeof channelOriginSchema>;
export const sessionMessageOriginSchema = z
  .object({ sessionId: z.string().min(1).max(512).optional(), name: name.optional() })
  .strict()
  .refine((value) => (value.sessionId === undefined) === (value.name === undefined));
export type SessionMessageOrigin = z.infer<typeof sessionMessageOriginSchema>;
const relativePath = path.refine((value) => !/^(?:[\\/]|[A-Za-z]:)/u.test(value));
const workspacePath = relativePath.refine((value) => !value.split(/[\\/]/u).includes('..'));
export function isComposerAttachmentResourcePath(value: string): boolean {
  return (
    /^mar-attachment:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[^/\\\0]+$/u.test(
      value
    ) && !value.split('/').includes('..')
  );
}
const attachment = z
  .object({
    name,
    mime: z.string().min(1).max(128),
    path,
    workspacePath: workspacePath.optional()
  })
  .strict()
  .refine((value) => {
    const target = value.workspacePath ?? value.path;
    return (
      isComposerAttachmentResourcePath(target) ||
      (relativePath.safeParse(value.path).success &&
        workspacePath.safeParse(target).success &&
        target.startsWith('.mar/temp-files/'))
    );
  });

export const composerTagSchemas = {
  mar_steer: z.object({ message: z.string().max(100_000) }).strict(),
  mar_channel: channelOriginSchema,
  mar_session_origin: sessionMessageOriginSchema,
  mar_goal_start: z
    .object({ objective: z.string().max(100_000), instruction: z.string().max(100_000).optional() })
    .strict(),
  mar_goal_continue: z
    .object({
      objective: z.string().max(100_000).optional(),
      instruction: z.string().max(100_000).optional()
    })
    .strict(),
  mar_restart: z.object({}).strict(),
  mar_attachments: z.object({ files: z.array(attachment).min(1).max(5) }).strict(),
  mar_schedule: z.object({ objective: z.string().min(1).max(100_000) }).strict(),
  mar_skills: z
    .object({
      action: z.literal('use'),
      instruction: z.string().min(1).max(512),
      skills: z
        .array(z.object({ name, source: z.enum(['NODE_HOME', 'WORKSPACE']), path }).strict())
        .min(1)
        .max(128)
    })
    .strict(),
  mar_references: z
    .object({
      references: z
        .array(
          z
            .object({
              type: z.enum(['file', 'directory']),
              path: workspacePath,
              label: name,
              runnerPath: relativePath.optional()
            })
            .strict()
        )
        .min(1)
        .max(128)
    })
    .strict()
} as const;

export type ComposerTagName = keyof typeof composerTagSchemas;
export type ComposerTagPayloads = {
  [K in ComposerTagName]: z.infer<(typeof composerTagSchemas)[K]>;
};
export type ComposerAttachmentFile = ComposerTagPayloads['mar_attachments']['files'][number];
export type ComposerFileReference = ComposerTagPayloads['mar_references']['references'][number];
export type ComposerTagPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      [K in ComposerTagName]: {
        readonly kind: K;
        readonly payload: ComposerTagPayloads[K];
        readonly raw: string;
      };
    }[ComposerTagName];

export const COMPOSER_SKILL_INSTRUCTION =
  'Use the selected skills for this task; load them through the available skill mechanism.';
const STEER_INSTRUCTION =
  'Additional information received while you were working. Continue the current task and consider it where relevant.';

export function steerComposerMessage(text: string): string {
  const parts = parseComposerTags(text);
  const message = parts
    .map((part) => (part.kind === 'text' ? part.text : part.kind === 'mar_steer' ? part.raw : ''))
    .join('')
    .trim();
  const tags = parts
    .filter((part) => part.kind !== 'text' && part.kind !== 'mar_steer')
    .map((part) => part.raw);
  return [serializeComposerTag('mar_steer', { message }), ...tags].join('\n');
}

export function serializeComposerTag<K extends ComposerTagName>(
  kind: K,
  payload: ComposerTagPayloads[K]
): string {
  const parsed = composerTagSchemas[kind].safeParse(payload);
  if (!parsed.success) throw new Error('COMPOSER_TAG_INVALID');
  const value = parsed.data as Record<string, unknown>;
  const children: string[] = [];
  const attributes: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (kind === 'mar_channel' || kind === 'mar_session_origin' || key === 'action')
      attributes[key] = item;
    else if (Array.isArray(item)) {
      const leaf = key === 'files' ? 'file' : key === 'skills' ? 'skill' : 'reference';
      for (const entry of item) children.push(`  <${leaf}${markupAttributes(entry)} />`);
    } else
      children.push(
        item === '' ? `  <${key} />` : `  <${key}>${escapeMarkup(String(item))}</${key}>`
      );
  }
  if (kind === 'mar_steer') children.unshift(`  <instruction>${STEER_INSTRUCTION}</instruction>`);
  if (kind === 'mar_session_origin')
    children.push(
      `  <instruction>${value.sessionId === undefined ? 'Message sent via marctl.' : 'Message from another session, not directly from the user.'}</instruction>`
    );
  const opening = `<${kind}${markupAttributes(attributes)}`;
  const encoded = children.length
    ? `${opening}>
${children.join('\n')}
</${kind}>`
    : `${opening} />`;
  if (new TextEncoder().encode(encoded).byteLength > MAX_COMPOSER_TAG_BYTES)
    throw new Error('COMPOSER_TAG_INVALID');
  return encoded;
}

function parseComposerPayload(raw: string): ComposerTagPart | undefined {
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_COMPOSER_TAG_BYTES) return undefined;
    const root = parseComposerMarkup(raw);
    if (!Object.hasOwn(composerTagSchemas, root.name)) return undefined;
    const kind = root.name as ComposerTagName;
    const payload: Record<string, unknown> = { ...root.attributes };
    const list =
      kind === 'mar_attachments'
        ? ['file', 'files']
        : kind === 'mar_skills'
          ? ['skill', 'skills']
          : kind === 'mar_references'
            ? ['reference', 'references']
            : undefined;
    const scalar =
      kind === 'mar_steer'
        ? ['instruction', 'message']
        : kind === 'mar_goal_start' || kind === 'mar_goal_continue'
          ? ['objective', 'instruction']
          : kind === 'mar_schedule'
            ? ['objective']
            : kind === 'mar_skills' || kind === 'mar_session_origin'
              ? ['instruction']
              : [];
    for (const field of root.fields) {
      if (list && field.name === list[0]) {
        if (field.text !== '') return undefined;
        const values = (payload[list[1]!] ??= []);
        if (!Array.isArray(values)) return undefined;
        values.push({ ...field.attributes });
      } else {
        if (
          !scalar.includes(field.name) ||
          Object.keys(field.attributes).length ||
          Object.hasOwn(payload, field.name)
        )
          return undefined;
        payload[field.name] = field.text;
      }
    }
    if (
      kind !== 'mar_channel' &&
      kind !== 'mar_session_origin' &&
      Object.keys(root.attributes).some((key) => kind !== 'mar_skills' || key !== 'action')
    )
      return undefined;
    if (kind === 'mar_steer' || kind === 'mar_session_origin') {
      if (
        Object.hasOwn(root.attributes, 'instruction') ||
        typeof payload.instruction !== 'string' ||
        payload.instruction.length === 0 ||
        payload.instruction.length > 512
      )
        return undefined;
      delete payload.instruction;
    }
    const result = composerTagSchemas[kind].safeParse(payload);
    return result.success ? ({ kind, payload: result.data, raw } as ComposerTagPart) : undefined;
  } catch {
    return undefined;
  }
}

export function parseComposerTags(text: string): readonly ComposerTagPart[] {
  const parts: ComposerTagPart[] = [];
  const pattern = /(^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$))|<mar_/gmu;
  let fence: string | undefined;
  let offset = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1] !== undefined) {
      const marker = match[2]!;
      if (fence === undefined) {
        if (marker[0] !== '`' || !match[3]!.includes('`')) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t\r]*$/u.test(match[3]!)
      )
        fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const end = composerMarkupEnd(text, match.index);
    pattern.lastIndex = end;
    const parsed = parseComposerPayload(text.slice(match.index, end));
    if (!parsed) continue;
    if (match.index > offset) parts.push({ kind: 'text', text: text.slice(offset, match.index) });
    parts.push(parsed);
    offset = end;
  }
  if (offset < text.length) parts.push({ kind: 'text', text: text.slice(offset) });
  return parts;
}

export function composerVisibleText(text: string): string {
  return parseComposerTags(text)
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (part.kind === 'mar_steer') return part.payload.message;
      if (part.kind === 'mar_goal_start') return part.payload.objective;
      if (part.kind === 'mar_schedule') return part.payload.objective;
      return '';
    })
    .join('')
    .trim();
}
