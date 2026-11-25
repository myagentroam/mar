import { z } from 'zod';
import { sessionGroupSchema } from './session-group.js';

const identity = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().safe();
const scheduleIdentity = z.string().min(1).max(128);
const occurrenceReference = z
  .object({ kind: z.literal('occurrence'), id: scheduleIdentity })
  .strict();
const proposalReference = z.object({ kind: z.literal('proposal'), id: scheduleIdentity }).strict();
const scheduleTarget = z.object({
  targetType: z.literal('SCHEDULED_TASK'),
  workspaceId: scheduleIdentity,
  taskId: scheduleIdentity,
  taskName: z.string().min(1).max(160)
});

const scheduledNotificationBase = scheduleTarget.extend({
  userId: z.number().int().positive().safe(),
  notificationId: z.string().min(1).max(512),
  runId: scheduleIdentity,
  occurredAt: timestamp
});

// Node schedule notifications without a canonical Session intentionally have no Session route.
export const scheduledTaskNotificationPayloadSchema = z.union([
  scheduledNotificationBase
    .extend({
      kind: z.enum(['SCHEDULE_SKIPPED', 'SCHEDULE_FAILED']),
      reference: occurrenceReference,
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
    })
    .strict(),
  scheduledNotificationBase
    .extend({ kind: z.literal('SCHEDULE_PROPOSAL'), reference: proposalReference })
    .strict(),
  scheduledNotificationBase
    .extend({
      kind: z.literal('SCHEDULE_TERMINAL'),
      reference: occurrenceReference,
      outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'])
    })
    .strict()
]);

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
    .strict(),
  scheduleTarget
    .extend({
      nodeId: identity,
      reference: z.discriminatedUnion('kind', [occurrenceReference, proposalReference])
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

export const NOTIFICATION_TARGET_READ_ID_LIMIT = 250;

export const notificationTargetReadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('notification.session-read'),
      nodeId: identity,
      workspaceId: identity,
      sessionId: identity,
      notificationIds: z.array(identity).max(NOTIFICATION_TARGET_READ_ID_LIMIT),
      readAt: timestamp
    })
    .strict(),
  z
    .object({
      type: z.literal('notification.conversation-read'),
      nodeId: identity,
      conversationId: identity,
      notificationIds: z.array(identity).max(NOTIFICATION_TARGET_READ_ID_LIMIT),
      readAt: timestamp
    })
    .strict()
]);

export type NotificationTarget = Readonly<z.infer<typeof notificationTargetSchema>>;
export type ServerNotification = Readonly<z.infer<typeof serverNotificationSchema>>;
