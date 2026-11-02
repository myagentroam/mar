import { z } from 'zod';

const id = z.string().min(1).max(256);
export const marctlUserTokenSchema = z
  .string()
  .max(16_384)
  .regex(/^marctl_user_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
const token = marctlUserTokenSchema;

/** Private authenticated Node control-channel exchange; never exposed as a public receipt. */
export const marctlExecutionCredentialRequestSchema = z
  .object({
    parentToken: token,
    workspaceId: id,
    sessionId: id,
    executionId: id,
    userId: z.number().int().positive().safe()
  })
  .strict();

export const marctlExecutionCredentialResponseSchema = z.union([
  z.object({ token }).strict(),
  z
    .object({
      error: z
        .object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: z.string().min(1).max(1000)
        })
        .strict()
    })
    .strict()
]);

export type MarctlExecutionCredentialRequest = z.infer<
  typeof marctlExecutionCredentialRequestSchema
>;
