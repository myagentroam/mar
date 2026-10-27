export interface ModelImage {
  readonly resourceInputVersion?: 1;
  readonly mimeType: string;
  readonly dataBase64?: string;
  readonly resourceId?: string;
  readonly byteSize?: number;
  /** Fixed published resource; image bytes are persisted separately. */
  readonly url?: string;
  readonly urlExpiresAt?: number;
}
