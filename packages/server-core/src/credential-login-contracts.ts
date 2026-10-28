import type { CodexCredentialOwnership } from '@myagentroam/protocol';

export interface CredentialLoginActor {
  readonly userId: number;
  readonly sessionFingerprint: string;
}

export interface CredentialLoginDraft {
  readonly name: string;
  readonly ownership: CodexCredentialOwnership;
  readonly socks5Url?: string | undefined;
  readonly targetCredentialId?: string | undefined;
}
