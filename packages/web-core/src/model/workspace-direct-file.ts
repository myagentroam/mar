export interface WorkspaceDirectFileIdentity {
  readonly revision: string;
  readonly size: number;
}

export interface WorkspaceDirectFileRange extends WorkspaceDirectFileIdentity {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nextOffset: number | null;
}
