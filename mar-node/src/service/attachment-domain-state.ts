export interface SessionAttachmentRetention {
  sessionId: string;
  readonly runs: Set<string>;
  protections: number;
  deadline: number | undefined;
  timer: NodeJS.Timeout | undefined;
}

export class AttachmentDomainState<TCachedRunImages, TNativeImageSource> {
  readonly runDirectories = new Map<string, string>();
  readonly runFileDirectories = new Map<string, readonly string[]>();
  readonly runFileSessions = new Map<string, string>();
  readonly sessionRetentions = new Map<string, SessionAttachmentRetention>();
  readonly runImages = new Map<string, TCachedRunImages>();
  readonly nativeHistoryImages = new Map<string, Map<string, TNativeImageSource>>();
  readonly nativeHistoryImageTimers = new Map<string, NodeJS.Timeout>();
}
