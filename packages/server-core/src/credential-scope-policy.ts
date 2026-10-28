import type { CodexCredentialOwnership } from '@myagentroam/protocol';

export interface CredentialScopePolicy {
  canActorManageOwnership(
    actorUserId: number,
    ownership: CodexCredentialOwnership
  ): Promise<boolean>;
  assertActorCanSelectOwnership(
    actorUserId: number,
    ownership: CodexCredentialOwnership
  ): Promise<void>;
  assertCredentialScopeChangeAllowed(
    credentialId: string,
    ownership: CodexCredentialOwnership
  ): Promise<void>;
  assertUserInCredentialScope(userId: number, credentialId: string): Promise<void>;
  assertModelCredentialBinding(
    actorUserId: number,
    credentialId: string,
    modelId?: string
  ): Promise<void>;
}
