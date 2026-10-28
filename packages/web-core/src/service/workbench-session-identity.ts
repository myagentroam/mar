import type { Ref } from 'vue';
import type { Session } from '../model/workbench.js';

export function replaceSessionIdentity(
  options: {
    readonly sessions: Ref<Session[]>;
    readonly selectedSessionId: Ref<string | undefined>;
    readonly currentSelectionRevision: () => number;
    readonly preserveManagedActive: (current: Session | undefined, next: Session) => Session;
    readonly mergeSessions: (sessions: readonly Session[]) => void;
    readonly transferSubmission: (previousId: string, nextId: string) => void;
  },
  previousId: string,
  next: Session
): void {
  const current = options.sessions.value.find((session) => session.id === previousId);
  const value = options.preserveManagedActive(current, next);
  const wasSelected = options.selectedSessionId.value === previousId;
  const selectionRevision = options.currentSelectionRevision();
  options.mergeSessions([value]);
  if (
    previousId !== value.id &&
    current !== undefined &&
    options.sessions.value.includes(current) &&
    !(
      options.selectedSessionId.value === previousId &&
      options.currentSelectionRevision() !== selectionRevision
    )
  )
    options.sessions.value = options.sessions.value.filter((session) => session !== current);
  if (
    wasSelected &&
    (options.selectedSessionId.value === previousId ||
      options.selectedSessionId.value === value.id) &&
    options.currentSelectionRevision() === selectionRevision
  ) {
    options.transferSubmission(previousId, value.id);
    if (
      options.selectedSessionId.value === previousId &&
      options.currentSelectionRevision() === selectionRevision
    )
      options.selectedSessionId.value = value.id;
  }
}
