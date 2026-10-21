import { z } from 'zod';
import { mailNotificationRequestSchema } from './mail-notification.js';

const notificationInput = z
  .object({
    channels: z
      .array(z.enum(['push', 'email']))
      .min(1)
      .max(2)
      .default(['push']),
    title: z
      .string()
      .max(160)
      .regex(/^[^\r\n]*$/u)
      .optional(),
    message: z.string().min(1).max(4000),
    recipientEmail: z.string().email().max(320).optional(),
    templateId: z.enum(['', 'notification-en-US', 'notification-zh-CN']).optional()
  })
  .strict();
function validateChannels(
  input: z.infer<typeof notificationInput>,
  context: z.RefinementCtx
): void {
  if (new Set(input.channels).size !== input.channels.length)
    context.addIssue({ code: 'custom', message: 'Duplicate notification channels.' });
  if (
    !input.channels.includes('email') &&
    (input.recipientEmail !== undefined || input.templateId !== undefined)
  )
    context.addIssue({
      code: 'custom',
      message: 'Email parameters must match the requested channels.'
    });
}
export const notificationInputSchema = notificationInput.superRefine(validateChannels);
export const notificationChannelsRequestSchema = notificationInput
  .extend({
    ...mailNotificationRequestSchema.pick({
      executionId: true,
      sessionId: true,
      workspaceId: true,
      userId: true,
      source: true,
      callId: true
    }).shape,
    apiVersion: z.literal(1),
    eventType: z.literal('notification'),
    kind: z.literal('AGENT_MESSAGE'),
    occurredAt: z.number().int().nonnegative().safe(),
    sessionTitle: z.string().min(1).max(160)
  })
  .superRefine(validateChannels);
export type NotificationChannelsRequest = z.infer<typeof notificationChannelsRequestSchema>;

const count = z.number().int().min(0).max(32);
export const pushDeliveryResultSchema = z
  .object({
    status: z.enum(['suppressed', 'skipped', 'accepted', 'partial', 'failed', 'uncertain']),
    reason: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
      .optional(),
    eligible: count,
    attempted: count,
    accepted: count,
    skipped: count,
    failed: count,
    uncertain: count
  })
  .strict();
export type PushDeliveryResult = z.infer<typeof pushDeliveryResultSchema>;
const channelError = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
    message: z.string().min(1).max(512)
  })
  .strict();
export const notificationChannelsResultSchema = z
  .object({
    callId: z.string().uuid(),
    push: z
      .object({
        notificationId: z.string().uuid().optional(),
        persisted: z.boolean(),
        delivery: pushDeliveryResultSchema
      })
      .strict()
      .optional(),
    email: z
      .object({
        status: z.enum(['accepted', 'failed', 'uncertain']),
        error: channelError.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type NotificationChannelsResult = z.infer<typeof notificationChannelsResultSchema>;
export const notificationChannelsResponseSchema = z.union([
  notificationChannelsResultSchema,
  z.object({ error: channelError }).strict()
]);
export type NotificationChannelsResponse = z.infer<typeof notificationChannelsResponseSchema>;
