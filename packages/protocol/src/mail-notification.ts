import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const mailNotificationRequestSchema = z
  .object({
    executionId: id,
    sessionId: id,
    workspaceId: id,
    userId: z.number().int().positive().safe(),
    source: z.enum(['MANUAL', 'SCHEDULED']),
    callId: z.string().uuid(),
    templateId: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9-]*$/u),
    title: z
      .string()
      .max(160)
      .regex(/^[^\r\n]*$/u)
      .optional(),
    recipientEmail: z.string().min(3).max(320).optional(),
    message: z.string().min(1).max(4000)
  })
  .strict();
export type MailNotificationRequest = z.infer<typeof mailNotificationRequestSchema>;

export const mailNotificationResponseSchema = z.union([
  z.object({ accepted: z.literal(true) }).strict(),
  z
    .object({
      error: z
        .object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
          message: z.string().min(1).max(512)
        })
        .strict()
    })
    .strict()
]);
export type MailNotificationResponse = z.infer<typeof mailNotificationResponseSchema>;
