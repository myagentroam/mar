import type {
  ScheduleSessionScope,
  ScheduleTaskLink
} from '../../service/scheduled-task-client.js';

export const scheduleSections = ['mine', 'all', 'history'] as const;
export type ScheduleSection = (typeof scheduleSections)[number];

/** Workbench navigation state; the panel owns reads, details and editor drafts. */
export interface ScheduledTasksLocation {
  readonly section: ScheduleSection;
  readonly session?: ScheduleSessionScope;
  readonly link?: ScheduleTaskLink;
}
