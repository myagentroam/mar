import { MarAgentModelService as CoreMarAgentModelService } from '@myagentroam/server-core/mar-agent-model-service';
import type { RowDataPacket } from 'mysql2/promise';
import type { ConversationTemplateModelReference } from '@myagentroam/protocol';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { ResourceAccessService } from '../rbac/resource-access-service.js';
import type { CodexCredentialScopeChecker } from './codex-credential-scope-service.js';

export class MarAgentModelService extends CoreMarAgentModelService {
  constructor(
    database: MysqlServerDatabase,
    now: () => number = Date.now,
    id?: () => string,
    private readonly enterpriseAccess?: Pick<
      ResourceAccessService,
      'canUseModel' | 'canManageModel' | 'assertOwnershipSelection'
    > &
      Partial<
        Pick<ResourceAccessService, 'nodeOwnership' | 'lockOwnership' | 'cleanupModelResources'>
      >,
    credentialScopes?: Pick<CodexCredentialScopeChecker, 'assertModelCredentialBinding'>,
    private readonly personalHostingAdmission?: (userId: number) => Promise<boolean>
  ) {
    super(database, now, id, enterpriseAccess, credentialScopes);
  }

  protected override async summaryRows(): Promise<RowDataPacket[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT model.id,model.name,model.protocol,model.base_url,model.model_id,
              model.context_window_tokens,model.max_output_tokens,model.input_capabilities,
              model.output_capabilities,model.reasoning_efforts,
              model.default_reasoning_effort,model.conversation_model,model.title_generation,model.code_mode,
              model.fast_mode,model.service_tier,
              model.hosted_web_search,
              model.responses_transport,
              model.responses_previous_response_id,model.credential,
              model.enabled,model.sort_order,
              model.last_tested_at,model.last_test_status,model.last_test_code,
              model.owner_type,model.owner_user_id,model.owner_organization_id,
              EXISTS (
                SELECT 1 FROM resource_grants grant_record
                WHERE grant_record.resource_type='MODEL' AND grant_record.model_id=model.id
                  AND grant_record.target_type='ORGANIZATION' AND grant_record.target_organization_id=1
              ) AS public_access
       FROM mar_agent_models model ORDER BY model.sort_order,model.normalized_name,model.id`
    );
    return rows;
  }

  override async listTemplateOptionsForNode(
    nodeId: string
  ): Promise<readonly ConversationTemplateModelReference[]> {
    const ownership = await this.enterpriseAccess?.nodeOwnership?.(nodeId);
    if (ownership === undefined) throw new Error('NODE_NOT_FOUND');
    if (
      ownership.ownerType === 'PERSONAL' &&
      (await this.personalHostingAdmission?.(ownership.ownerUserId)) === true
    ) {
      return (await this.listForUser(ownership.ownerUserId)).map((model) => ({
        modelId: model.modelId,
        name: model.name
      }));
    }
    const ownerOrganizationId =
      ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null;
    const ownerUserId = ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE node_model_organizations AS (
         SELECT organization.id,organization.parent_organization_id
         FROM organizations organization
         WHERE organization.id=COALESCE(
           ?,
           (SELECT user.organization_id FROM users user WHERE user.id=? AND user.enabled=TRUE)
         )
         UNION ALL
         SELECT parent.id,parent.parent_organization_id
         FROM organizations parent
         JOIN node_model_organizations child ON child.parent_organization_id=parent.id
       )
       SELECT model.model_id,model.name,model.normalized_name
       FROM mar_agent_models model
       WHERE model.enabled=1 AND model.conversation_model=1
         AND EXISTS (
           SELECT 1 FROM resource_grants grant_record
           WHERE grant_record.resource_type='MODEL' AND grant_record.model_id=model.id
             AND (
               grant_record.target_type='ORGANIZATION' AND grant_record.target_organization_id=1
               OR (
                 grant_record.target_type='USER'
                 AND grant_record.target_user_id=?
               )
               OR (
                 grant_record.target_type='ORGANIZATION'
                 AND grant_record.target_organization_id IN (
                   SELECT id FROM node_model_organizations
                 )
               )
             )
         )
       ORDER BY model.sort_order,model.normalized_name,model.id`,
      [ownerOrganizationId, ownerUserId, ownerUserId]
    );
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const modelId = String(row['model_id']);
      const name = String(row['name']);
      const normalizedName = String(row['normalized_name']);
      if (seen.has(normalizedName)) return [];
      seen.add(normalizedName);
      return [{ modelId, name }];
    });
  }
}
