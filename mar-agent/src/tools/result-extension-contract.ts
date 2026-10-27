import { z } from 'zod';

const diffSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    resourceRef: z.string().uuid(),
    format: z.literal('unified-diff'),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['unsupported-content', 'limit-exceeded', 'capture-failed', 'storage-failed'])
  })
]);
export const fileChangesExtensionSchema = z.object({
  type: z.literal('file_changes'),
  version: z.literal(1),
  entries: z
    .array(
      z.object({
        changeId: z.string().uuid(),
        path: z.string().min(1).max(8192),
        change: z.enum(['added', 'modified', 'deleted']),
        additions: z.number().int().nonnegative().nullable(),
        deletions: z.number().int().nonnegative().nullable(),
        diff: diffSchema
      })
    )
    .max(200)
});
export type ToolResultExtension = z.infer<typeof fileChangesExtensionSchema>;
export type FileChangeEvidence = ToolResultExtension['entries'][number];
export type AvailableToolResultResource = Extract<
  FileChangeEvidence['diff'],
  { status: 'available' }
>;
export type ToolResultResourceWriter = (text: string) => Promise<AvailableToolResultResource>;
