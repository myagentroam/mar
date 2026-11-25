import type {
  ScheduleSessionScope,
  ScheduleTaskKey,
  ScheduleTaskLink
} from '../../service/scheduled-task-client.js';

export const scheduleSections = ['mine', 'all', 'history'] as const;
export type ScheduleSection = (typeof scheduleSections)[number];
export type ScheduleHistoryTask = ScheduleTaskKey & { name: string };

/** Workbench navigation state; the panel owns reads, details and editor drafts. */
export interface ScheduledTasksLocation {
  readonly section: ScheduleSection;
  readonly session?: ScheduleSessionScope;
  readonly link?: ScheduleTaskLink;
  readonly historyTask?: ScheduleHistoryTask;
}
