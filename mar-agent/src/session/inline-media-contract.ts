export interface InlineMediaCursor {
  sourceId: string;
  imageIndex: number;
}

/** Processing progress, not evidence that the provider inspected an image. */
export interface InlineMediaState {
  version: 1;
  consideredThrough?: InlineMediaCursor;
  evictedThrough?: InlineMediaCursor;
}

export interface InlineMediaGcCheckpoint {
  readonly reason: 'SOFT_LIMIT' | 'HARD_LIMIT' | 'TEXT_GC';
  readonly state: InlineMediaState;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}
