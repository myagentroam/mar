import { z } from 'zod';

export const sessionGroupSchema = z.enum(['MAIN', 'CHILD']);
export type SessionGroup = z.infer<typeof sessionGroupSchema>;

export const sessionRunningCountsSchema = z.object({
  MAIN: z.number().int().nonnegative().safe(),
  CHILD: z.number().int().nonnegative().safe()
});
export type SessionRunningCounts = z.infer<typeof sessionRunningCountsSchema>;

export const sessionGroupChangedSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    sessionGroup: z.literal('MAIN')
  })
  .strict();
export type SessionGroupChanged = z.infer<typeof sessionGroupChangedSchema>;
