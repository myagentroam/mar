export interface SessionResource {
  readonly resourceInputVersion?: 1;
  readonly resourceId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly url?: string;
  readonly urlExpiresAt?: number;
}
