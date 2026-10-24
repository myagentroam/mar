import { z } from 'zod';
import { sessionGroupSchema } from './session-group.js';

const identity = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().safe();

export const notificationTargetSchema = z.discriminatedUnion('targetType', [
  z
    .object({
      targetType: z.literal('WORKSPACE_SESSION'),
      nodeId: identity,
      workspaceId: identity,
      sessionId: identity,
      sessionGroup: sessionGroupSchema.optional(),
      sessionName: z.string().optional()
    })
    .strict(),
  z
    .object({
      targetType: z.literal('HOSTED_CONVERSATION'),
      nodeId: identity,
      conversationId: identity,
      conversationName: z.string()
    })
    .strict()
]);

export const serverNotificationSchema = z
  .object({
    id: identity,
    kind: z.enum(['run', 'approval', 'plan', 'user-input', 'schedule', 'agent']),
    title: z.string(),
    message: z.string().max(4000),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    read: z.boolean(),
    target: notificationTargetSchema
  })
  .strict();

export const notificationCreatedSchema = z
  .object({
    type: z.literal('notification.created'),
    notification: serverNotificationSchema
  })
  .strict();

export type NotificationTarget = Readonly<z.infer<typeof notificationTargetSchema>>;
export type ServerNotification = Readonly<z.infer<typeof serverNotificationSchema>>;
