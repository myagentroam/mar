import {
  CodexCredentialService as CoreCodexCredentialService,
  type CodexCredentialServiceOptions as CoreOptions
} from '@myagentroam/server-core/codex-credential-service';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import { AuthorizationService } from '../rbac/authorization-service.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import type { GrantTarget } from '../rbac/resource-access-service.js';
import type { ResourceOwnership } from '@myagentroam/protocol';
import {
  CodexCredentialScopeService,
  type CodexCredentialScopeChecker
} from './codex-credential-scope-service.js';
export type { CodexCredentialMaintenanceResult } from '@myagentroam/server-core/codex-credential-service';
export interface CodexCredentialServiceOptions extends Omit<CoreOptions, 'createScopePolicy'> {
  readonly authorization?: AuthorizationProvider;
}
export class CodexCredentialService
  extends CoreCodexCredentialService
  implements CodexCredentialScopeChecker
{
  private readonly enterpriseScopes: CodexCredentialScopeService;
  constructor(database: MysqlServerDatabase, options: CodexCredentialServiceOptions = {}) {
    let scopes!: CodexCredentialScopeService;
    super(database, {
      ...options,
      createScopePolicy: (readOwnership) => {
        scopes = new CodexCredentialScopeService(
          database,
          options.authorization ?? new AuthorizationService(database),
          readOwnership
        );
        return scopes;
      }
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
