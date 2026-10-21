import { z } from 'zod';
import { channelDisplayNameSchema } from './composer-tags.js';

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sessionShareTargetSchema = z
  .object({ nodeId: id, workspaceId: id, sessionId: id })
  .strict();
export type SessionShareTarget = z.infer<typeof sessionShareTargetSchema>;
export const sessionShareSchema = sessionShareTargetSchema
  .extend({
    id,
    createdAt: timestamp,
    expiresAt: timestamp.nullable()
  })
  .strip();
export type SessionShare = z.infer<typeof sessionShareSchema>;
export const sessionShareCreateInputSchema = z
  .object({
    nodeId: id,
    workspaceId: id,
    expiresAt: z.string().datetime().nullable().default(null)
  })
  .strict();
export const sessionSharePasswordSchema = z.string().regex(/^[0-9]{6}$/u);
export const sessionShareCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const sessionShareAuthInputSchema = z.union([
  z.object({ password: sessionSharePasswordSchema }).strict(),
  z.object({ credential: sessionShareCredentialSchema }).strict()
]);
export const sessionShareAuthResultSchema = z.object({
  share: sessionShareSchema,
  credential: sessionShareCredentialSchema,
  sharerName: z.string().min(1).max(512),
  workspaceName: z.string().min(1).max(255).optional()
});
export type SessionShareAuthResult = z.infer<typeof sessionShareAuthResultSchema>;
export const sessionShareVisitorSchema = z
  .object({ visitorId: id, name: channelDisplayNameSchema.optional() })
  .strict();
export type SessionShareVisitor = z.infer<typeof sessionShareVisitorSchema>;
