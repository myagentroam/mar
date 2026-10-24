import { z } from 'zod';

export const toolResultResourceInputSchema = z
  .object({
    resourceRef: z.string().uuid(),
    cursor: z.string().min(1).max(1024).optional(),
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(256 * 1024)
      .optional()
  })
  .strict();
export type ToolResultResourceInput = z.infer<typeof toolResultResourceInputSchema>;
export const toolResultResourcePageSchema = z
  .object({
    resourceRef: z.string().uuid(),
    type: z.literal('file_changes'),
    version: z.literal(1),
    format: z.literal('unified-diff'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteSize: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    content: z
      .string()
      .max(256 * 1024)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 256 * 1024, {
        message: 'Content must not exceed 256 KiB in UTF-8 bytes'
      }),
    nextCursor: z.string().min(1).max(1024).optional()
  })
  .strict();
export type ToolResultResourcePage = z.infer<typeof toolResultResourcePageSchema>;
export const fileChangeDiffSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      source: z.literal('TOOL_CHANGE'),
      resourceRef: z.string().uuid(),
      format: z.literal('unified-diff'),
      byteSize: z
        .number()
        .int()
        .min(0)
        .max(16 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u)
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['binary', 'limit-exceeded', 'capture-failed', 'storage-failed'])
    })
    .strict()
]);
export type FileChangeDiff = z.infer<typeof fileChangeDiffSchema>;
