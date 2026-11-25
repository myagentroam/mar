import { z } from 'zod';

const integers = (min: number, max: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1)
    .max(max - min + 1);
const months = integers(1, 12).optional();

export const scheduledTimeGroupSchema = z.strictObject({
  days: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dates'), dates: z.array(z.string().date()).min(1).max(64) }),
    z.strictObject({ kind: z.literal('anyDay'), months }),
    z.strictObject({ kind: z.literal('weekdays'), weekdays: integers(0, 6), months }),
    z.strictObject({ kind: z.literal('monthDays'), monthDays: integers(1, 31), months })
  ]),
  times: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('times'),
      times: z
        .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
        .min(1)
        .max(64)
    }),
    z.strictObject({ kind: z.literal('grid'), hours: integers(0, 23), minutes: integers(0, 59) })
  ])
});

export const scheduledTimeGroupsSchema = z.array(scheduledTimeGroupSchema).min(1).max(16);
export type ScheduledTimeGroup = z.infer<typeof scheduledTimeGroupSchema>;

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

export const scheduledTasksCapabilitySchema = z.strictObject({ apiVersion: z.literal(1) });
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
  groups: scheduledTimeGroupsSchema.describe(
    'Union of date and time combinations in the Node time zone. Weekdays are 0 (Sunday) to 6 (Saturday).'
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
