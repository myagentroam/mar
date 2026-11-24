import { z } from 'zod';
import { browserResourceCommandSchema } from './browser-attachment.js';
import { browserProfileCommandSchema } from './browser-data.js';

const scope = { nodeId: z.string().min(1).max(512), workspaceId: z.string().min(1).max(512) };
const id = z.string().uuid();

export const browserUseCheckSchema = z.strictObject({
  workspaceId: scope.workspaceId,
  userId: z.number().int().positive().safe()
});
export const browserUsePreferenceSchema = z.strictObject({ enabled: z.boolean() });

export const browserControlRequestSchema = z.strictObject({
  type: z.literal('browser.request'),
  requestId: id,
  request: z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('resource'),
      ...scope,
      command: browserResourceCommandSchema
    }),
    z.strictObject({
      action: z.literal('profile'),
      ...scope,
      command: browserProfileCommandSchema
    }),
    z.strictObject({
      action: z.literal('attach'),
      ...scope,
      browserId: id,
      transportId: z.string().min(1).max(512).optional(),
      replaces: id.optional()
    }),
    z.strictObject({ action: z.literal('renew'), attachmentId: id }),
    z.strictObject({ action: z.literal('release'), attachmentId: id })
  ])
});

export type BrowserControlRequest = z.infer<typeof browserControlRequestSchema>;

export const browserControlResponseSchema = z.strictObject({
  type: z.literal('browser.response'),
  requestId: id,
  result: z.unknown().optional(),
  error: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
    .optional()
});
export type BrowserControlResponse = z.infer<typeof browserControlResponseSchema>;
