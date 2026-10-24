import type { Session } from '../model/workbench.js';
import { translate } from '../service/locale-preference-service.js';

export function sessionTitle(session: Session): string {
  const customTitle = session.customTitle?.trim();
  if (customTitle) return customTitle;
  const title = session.runnerTitle?.trim();
  return title === undefined ||
    title === '' ||
    title === 'Untitled session' ||
    title.toLocaleLowerCase() === 'new session'
    ? translate('generated.sessionPresentation.newSession')
    : title;
}

/** A session becomes safely restorable only after Node exposes its Runner-native identity. */
export function sessionHasNativeIdentity(session: Session | undefined): session is Session {
  return typeof session?.externalSessionId === 'string' && session.externalSessionId.length > 0;
}

export function sessionIsDraft(session: Session | undefined): boolean {
  return !sessionHasNativeIdentity(session);
}

export function temporarySessionTitle(content: string): string {
  return content.trim().replace(/\s+/g, ' ').slice(0, 160);
}

export function sessionActivity(session: Session): NonNullable<Session['activity']> {
  if (session.activity !== undefined) return session.activity;
  return 'IDLE';
}

export function sessionActivityLabel(session: Session): string {
  return {
    MANAGED_ACTIVE: translate('generated.sessionPresentation.managed'),
    IDLE: translate('generated.sessionPresentation.ready')
  }[sessionActivity(session)];
}

export function runStatusLabel(value: string): string {
  return (
    {
      STARTING: translate('generated.sessionPresentation.starting'),
      RUNNING: translate('generated.sessionPresentation.running2'),
      SUCCEEDED: translate('generated.sessionPresentation.completed'),
      FAILED: translate('generated.sessionPresentation.failed'),
      CANCELLED: translate('generated.sessionPresentation.cancelled'),
      INTERRUPTED: translate('generated.sessionPresentation.interrupted'),
      LOST: translate('generated.sessionPresentation.connectionLost')
    }[value] ?? value
  );
}
