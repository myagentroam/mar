import { z } from 'zod';

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
  z.strictObject({ action: z.literal('finish'), transferId: id }),
  z.strictObject({ action: z.literal('cancel') })
]);

export const browserUploadSchema = z.strictObject({
  attachmentId: id,
  chooserId: id,
  command: browserUploadCommandSchema
});
export type BrowserUpload = z.infer<typeof browserUploadSchema>;
export const browserUploadStreamSchema = browserUploadSchema.extend({
  command: z.strictObject({
    action: z.literal('stream'),
    transferId: id,
    index: z.number().int().nonnegative().safe()
  })
});
export type BrowserUploadStream = z.infer<typeof browserUploadStreamSchema>;
export type BrowserFileChooser = z.infer<typeof browserFileChooserSchema>;

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
const offset = z.number().int().nonnegative().safe();
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
/** Trusted Server request after admission of a device save, independent of the picture stream. */
export const browserDownloadStreamSchema = z.strictObject({
  workspaceId: z.string().min(1),
  browserId: id,
  command: z.strictObject({
    action: z.literal('stream'),
    id,
    size: z.number().int().nonnegative().safe()
  })
});
export type BrowserDownloadStream = z.infer<typeof browserDownloadStreamSchema>;
export type BrowserDownloadInfo = z.infer<typeof browserDownloadInfoSchema>;
export type BrowserDownloadRequest = z.infer<typeof browserDownloadRequestSchema>;
