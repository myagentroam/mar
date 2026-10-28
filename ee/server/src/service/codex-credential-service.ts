import {
  CodexCredentialService as CoreCodexCredentialService,
  type CodexCredentialServiceOptions as CoreOptions
} from '@myagentroam/server-core/codex-credential-service';
import { CredentialDocumentStore } from '@myagentroam/server-core/credential-document-store';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import type { GrantTarget } from '../rbac/resource-grant-contracts.js';
import type { ResourceOwnership } from '@myagentroam/protocol';
import {
  CodexCredentialScopeService,
  type CodexCredentialScopeChecker
} from './codex-credential-scope-service.js';
export type { CodexCredentialMaintenanceResult } from '@myagentroam/server-core/codex-credential-service';
export interface CodexCredentialServiceOptions extends Omit<
  CoreOptions,
  'scopePolicy' | 'documentStore'
> {
  readonly authorization: AuthorizationProvider;
}
export class CodexCredentialService
  extends CoreCodexCredentialService
  implements CodexCredentialScopeChecker
{
  private readonly enterpriseScopes: CodexCredentialScopeService;
  constructor(database: MysqlServerDatabase, options: CodexCredentialServiceOptions) {
    const documentStore = new CredentialDocumentStore(database.raw, options.now ?? Date.now);
    const scopes = new CodexCredentialScopeService(
      database,
      options.authorization,
      async (credentialId) =>
        (await documentStore.read()).credentials.find(
          (credential) => credential.id === credentialId
        )?.ownership
    );
    super(database, {
      ...options,
      scopePolicy: scopes,
      documentStore
    });
    this.enterpriseScopes = scopes;
  }
  async assertModelGrantWithinScope(modelId: string, target: GrantTarget): Promise<void> {
    await this.enterpriseScopes.assertModelGrantWithinScope(modelId, target);
  }
  async canUserUseModelCredential(userId: number, modelId: string): Promise<boolean> {
    return this.enterpriseScopes.canUserUseModelCredential(userId, modelId);
  }
  async assertModelCredentialBinding(
    actorUserId: number,
    credentialId: string,
    modelId?: string,
    ownership?: ResourceOwnership
  ): Promise<void> {
    await this.enterpriseScopes.assertModelCredentialBinding(
      actorUserId,
      credentialId,
      modelId,
      ownership
    );
  }
}
