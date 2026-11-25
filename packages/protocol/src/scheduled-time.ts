import { z } from 'zod';

const integers = (min: number, max: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1)
    .max(max - min + 1);
export const scheduledClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const time = scheduledClockTimeSchema;
export const scheduledTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), time, date: z.string().date() }),
  z.strictObject({ kind: z.literal('daily'), time }),
  z.strictObject({ kind: z.literal('weekly'), time, weekdays: integers(0, 6) }),
  z.strictObject({ kind: z.literal('monthly'), time, monthDays: integers(1, 31) })
]);
export const scheduledTriggerLimit = 1024;
export const scheduledTriggersSchema = z
  .array(scheduledTriggerSchema)
  .min(1)
  .max(scheduledTriggerLimit);
export type ScheduledTrigger = z.infer<typeof scheduledTriggerSchema>;

export const scheduledPreviewFields = {
  taskId: z.string().min(1).max(512).optional(),
  triggers: scheduledTriggersSchema.optional(),
  suggestTime: scheduledClockTimeSchema.optional()
};

export const scheduledTaskIdSchema = z.string().min(1).max(512);
export const scheduledTaskRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const scheduledTaskTargetKindSchema = z.enum(['existing', 'newSession', 'unbound']);
export type ScheduledTaskTargetKind = z.infer<typeof scheduledTaskTargetKindSchema>;
export const scheduledTaskStateSchema = z.enum(['scheduled', 'paused', 'finished', 'unbound']);
export type ScheduledTaskState = z.infer<typeof scheduledTaskStateSchema>;

/** Transport invalidation only; never carries a task or execution snapshot. */
export const scheduledTaskChangedSchema = z.strictObject({
  workspaceId: scheduledTaskIdSchema,
  topic: z.literal('schedule.changed')
});
export const scheduledOccurrenceChangedSchema = scheduledTaskChangedSchema.extend({
  topic: z.literal('schedule.occurrence.changed')
});
export const scheduleInvalidationSchema = z.discriminatedUnion('topic', [
  scheduledTaskChangedSchema,
  scheduledOccurrenceChangedSchema
]);

export const scheduledTasksApiVersion = 2;
export const scheduledTasksCapabilitySchema = z.strictObject({
  apiVersion: z.number().int().positive()
});
export const scheduledTaskFields = {
  name: z.string().trim().min(1).max(160).describe('Short name for this task.'),
  objective: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      'Instructions to execute at each trigger, not instructions to configure the schedule.'
    ),
  triggers: scheduledTriggersSchema.describe(
    'One HH:mm per entry in the task time zone (Node time zone on creation). Once requires a concrete date. Weekdays are 0 (Sunday) to 6 (Saturday).'
  )
};
export const scheduledTaskFieldsSchema = z.strictObject(scheduledTaskFields);
export const scheduledTaskPatchSchema = scheduledTaskFieldsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0);

export const scheduledNewSessionSchema = z.strictObject({
  runner: z.enum(['mar-agent', 'codex', 'claude-code', 'opencode']),
  model: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('fixed'), modelId: z.string().trim().min(1).max(256) })
  ]),
  effort: z.string().trim().min(1).max(32).optional()
});
export const scheduledTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), sessionId: scheduledTaskIdSchema }),
  scheduledNewSessionSchema.extend({ kind: z.literal('newSession') })
]);
export type ScheduledNewSession = z.infer<typeof scheduledNewSessionSchema>;
export type ScheduledTarget = z.infer<typeof scheduledTargetSchema>;

export const scheduledTaskWriteSchema = z.object({
  ...scheduledTaskFields,
  enabled: z.boolean().optional(),
  notifyOnTerminal: z.boolean().optional(),
  graceMinutes: z.number().int().min(0).max(60).optional()
});
export const scheduledTaskOwnerPatchSchema = scheduledTaskWriteSchema
  .extend({ target: scheduledTargetSchema })
  .partial()
  .strict();

const limit = z.number().int().min(1).max(30).optional();
const taskId = scheduledTaskIdSchema.describe('Task ID returned by create or list.');
export const scheduleToolInputs = {
  list: z.strictObject({ cursor: z.string().min(1).max(4096).optional(), limit }),
  get: z.strictObject({ taskId }),
  create: scheduledTaskFieldsSchema,
  update: z.strictObject({
    taskId,
    expectedRevision: scheduledTaskRevisionSchema,
    patch: scheduledTaskPatchSchema
  }),
  runs: z.strictObject({ taskId, before: scheduledTaskRevisionSchema.optional(), limit })
};
