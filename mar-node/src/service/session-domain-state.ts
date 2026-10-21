export type ExternalSessionActivationState = 'IDLE' | 'BUSY';

export class SessionDomainState<TSession, TActivity> {
  readonly directNative = new Map<string, TSession>();
  readonly externalActivity = new Map<string, TActivity>();
  readonly resumedByDirectId = new Map<string, string>();
  readonly resumeFailures = new Map<string, string>();
  readonly messageResumeFailures = new Map<string, string>();
  readonly resumeFailureDetails = new Map<string, string>();
  readonly failureTimers = new Map<string, NodeJS.Timeout>();
}
