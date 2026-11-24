import { z } from 'zod';

export const BROWSER_UPLOAD_CHUNK_BYTES = 128 * 1024;
export const BROWSER_UPLOAD_REQUEST_BYTES = 4 * Math.ceil(BROWSER_UPLOAD_CHUNK_BYTES / 3) + 1024;

const id = z.string().uuid();
export const browserFileChooserSchema = z.strictObject({ id, multiple: z.boolean() });

export const browserUploadCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('begin'),
    transferId: id
  }),
  z.strictObject({
    action: z.literal('file'),
    transferId: id,
    index: z.number().int().nonnegative().safe(),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f]+$/u),
    size: z.number().int().nonnegative().safe()
  }),
  z.strictObject({
    action: z.literal('chunk'),
    transferId: id,
    index: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative().safe(),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(BROWSER_UPLOAD_CHUNK_BYTES / 3))
      .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value))
  }),
  z.strictObject({ action: z.literal('finish'), transferId: id }),
  z.strictObject({ action: z.literal('cancel') })
]);

export const browserUploadSchema = z.strictObject({
  attachmentId: id,
  chooserId: id,
  command: browserUploadCommandSchema
});
export type BrowserUpload = z.infer<typeof browserUploadSchema>;
export type BrowserFileChooser = z.infer<typeof browserFileChooserSchema>;

export const BROWSER_DOWNLOAD_CHUNK_BYTES = 512 * 1024;
export const browserDownloadInfoSchema = z.strictObject({
  id,
  name: z.string().max(255),
  state: z.enum(['downloading', 'ready', 'failed', 'canceled']),
  size: z.number().int().nonnegative().safe().optional(),
  receivedBytes: z.number().int().nonnegative().safe().optional(),
  totalBytes: z.number().int().positive().safe().optional()
});
const downloadPageSize = 20;
export const BROWSER_DOWNLOAD_PAGE_SIZE = downloadPageSize;
export const browserDownloadPageSchema = z.strictObject({
  items: z.array(browserDownloadInfoSchema).max(downloadPageSize),
  more: z.boolean()
});
export const browserDownloadChunkSchema = z.strictObject({
  offset: z.number().int().nonnegative().safe(),
  contentBase64: z.string().max(4 * Math.ceil(BROWSER_DOWNLOAD_CHUNK_BYTES / 3))
});
const offset = z.number().int().nonnegative().safe();
const downloadRead = z.strictObject({
  action: z.literal('read'),
  id,
  offset,
  limit: z.number().int().positive().max(BROWSER_DOWNLOAD_CHUNK_BYTES)
});
export const browserDownloadRequestSchema = z.strictObject({
  attachmentId: id,
  command: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('list'), offset, progress: z.literal(true).optional() }),
    z.strictObject({ action: z.literal('cancel'), id }),
    z.strictObject({ action: z.literal('delete'), id }),
    z.strictObject({ action: z.literal('workspace'), id, path: z.string().min(1).max(4096) }),
    z.strictObject({ action: z.literal('info'), id })
  ])
});
/** Only the authenticated Server may issue these reads after admitting a save. */
export const browserDownloadReadSchema = z.strictObject({
  workspaceId: z.string().min(1),
  browserId: id,
  command: downloadRead
});
export type BrowserDownloadRead = z.infer<typeof browserDownloadReadSchema>;
export type BrowserDownloadInfo = z.infer<typeof browserDownloadInfoSchema>;
export type BrowserDownloadRequest = z.infer<typeof browserDownloadRequestSchema>;
