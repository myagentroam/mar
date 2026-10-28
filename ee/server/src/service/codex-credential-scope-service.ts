import type { RowDataPacket } from 'mysql2/promise';
import {
  marAgentModelCredentialSchema,
  type CodexCredentialOwnership,
  type ResourceOwnership
} from '@myagentroam/protocol';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { AuthorizationProvider } from '../product/product-policy.js';
import type { GrantTarget } from '../rbac/resource-grant-contracts.js';

type CredentialOwnershipReader = (
  credentialId: string
) => Promise<CodexCredentialOwnership | undefined>;

export interface CodexCredentialScopeChecker {
  assertModelCredentialBinding(
    actorUserId: number,
    credentialId: string,
    modelId?: string,
    modelOwnership?: ResourceOwnership
  ): Promise<void>;
  assertModelGrantWithinScope(modelId: string, target: GrantTarget): Promise<void>;
  canUserUseModelCredential(userId: number, modelId: string): Promise<boolean>;
}

export class CodexCredentialScopeService implements CodexCredentialScopeChecker {
  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly authorization: AuthorizationProvider,
    private readonly readOwnership: CredentialOwnershipReader
  ) {}

  async canActorManageOwnership(
    actorUserId: number,
    ownership: CodexCredentialOwnership
  ): Promise<boolean> {
    const actor = await this.authorization.actorContext(actorUserId);
    if (ownership.ownerType === 'PERSONAL')
      return (
        ownership.ownerUserId === actorUserId &&
        (actor !== undefined || (await this.authorization.isPersonalAdmin(actorUserId)))
      );
    return (
      await this.authorization.authorize(actorUserId, 'ORG_MANAGE', {
        ownerType: 'ORGANIZATION',
        organizationId: ownership.ownerOrganizationId
      })
    ).allowed;
  }

  async assertActorCanManageOwnership(
    actorUserId: number,
    ownership: CodexCredentialOwnership
  ): Promise<void> {
    if (!(await this.canActorManageOwnership(actorUserId, ownership)))
      throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
  }

  async assertActorCanSelectOwnership(
    actorUserId: number,
    ownership: CodexCredentialOwnership
  ): Promise<void> {
    if (
      ownership.ownerType !== 'PERSONAL' &&
      (await this.authorization.isPersonalAdmin(actorUserId))
    )
      throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    await this.assertActorCanManageOwnership(actorUserId, ownership);
  }

  async canActorManageCredential(actorUserId: number, credentialId: string): Promise<boolean> {
    const ownership = await this.readOwnership(credentialId);
    return ownership !== undefined && (await this.canActorManageOwnership(actorUserId, ownership));
  }

  async assertUserInCredentialScope(userId: number, credentialId: string): Promise<void> {
    const ownership = await this.readOwnership(credentialId);
    if (ownership === undefined || !(await this.isUserInOwnership(userId, ownership)))
      throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
  }

  async assertModelCredentialBinding(
    actorUserId: number,
    credentialId: string,
    modelId?: string,
    modelOwnership?: ResourceOwnership
  ): Promise<void> {
    const ownership = await this.readOwnership(credentialId);
    if (ownership === undefined || !(await this.canActorManageOwnership(actorUserId, ownership)))
      throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    if (
      modelOwnership !== undefined &&
      !(await this.isGrantWithinOwnership(
        modelOwnership.ownerType === 'PERSONAL'
          ? { targetType: 'USER', targetUserId: modelOwnership.ownerUserId }
          : {
              targetType: 'ORGANIZATION',
              targetOrganizationId: modelOwnership.ownerOrganizationId
            },
        ownership
      ))
    )
      throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
    if (modelId !== undefined) await this.assertModelGrantsWithinOwnership(modelId, ownership);
  }

  async assertModelGrantWithinScope(modelId: string, target: GrantTarget): Promise<void> {
    const ownership = await this.modelCredentialOwnership(modelId);
    if (ownership === null) return;
    if (ownership === undefined) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    if (!(await this.isGrantWithinOwnership(target, ownership)))
      throw new Error('CODEX_CREDENTIAL_SCOPE_FORBIDDEN');
  }

  async canUserUseModelCredential(userId: number, modelId: string): Promise<boolean> {
    const ownership = await this.modelCredentialOwnership(modelId);
    if (ownership === null) return true;
    return ownership !== undefined && this.isUserInOwnership(userId, ownership);
  }

  async assertCredentialScopeChangeAllowed(
    credentialId: string,
    ownership: CodexCredentialOwnership
  ): Promise<void> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT grant_record.model_id,grant_record.target_type,grant_record.target_user_id,
              grant_record.target_organization_id
       FROM resource_grants grant_record
       JOIN mar_agent_models model ON model.id=grant_record.model_id
       WHERE grant_record.resource_type='MODEL'
         AND JSON_UNQUOTE(JSON_EXTRACT(model.credential,'$.type'))='CREDENTIAL_REF'
         AND JSON_UNQUOTE(JSON_EXTRACT(model.credential,'$.credentialId'))=?`,
      [credentialId]
    );
    for (const row of rows)
      if (!(await this.isGrantWithinOwnership(grantTarget(row), ownership)))
        throw new Error('CODEX_CREDENTIAL_SCOPE_CONFLICT');
    const [imageRows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT image.owner_type,image.owner_user_id,image.owner_organization_id,
              grant_record.target_type,grant_record.target_user_id,
              grant_record.target_organization_id
       FROM mar_agent_image_models image
       LEFT JOIN resource_grants grant_record
         ON grant_record.resource_type='IMAGE_MODEL' AND grant_record.image_model_id=image.id
       WHERE image.provider='CODEX'
         AND JSON_UNQUOTE(JSON_EXTRACT(image.config,'$.credentialId'))=?`,
      [credentialId]
    );
    for (const row of imageRows) {
      const target =
        row['target_type'] === null || row['target_type'] === undefined
          ? row['owner_type'] === 'PERSONAL'
            ? { targetType: 'USER' as const, targetUserId: Number(row['owner_user_id']) }
            : {
                targetType: 'ORGANIZATION' as const,
                targetOrganizationId: Number(row['owner_organization_id'])
              }
          : grantTarget(row);
      if (!(await this.isGrantWithinOwnership(target, ownership)))
        throw new Error('CODEX_CREDENTIAL_SCOPE_CONFLICT');
    }
  }

  private async assertModelGrantsWithinOwnership(
    modelId: string,
    ownership: CodexCredentialOwnership
  ): Promise<void> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT model_id,target_type,target_user_id,target_organization_id
       FROM resource_grants
       WHERE resource_type='MODEL' AND model_id=?`,
      [modelId]
    );
    for (const row of rows)
      if (!(await this.isGrantWithinOwnership(grantTarget(row), ownership)))
        throw new Error('CODEX_CREDENTIAL_SCOPE_CONFLICT');
  }

  private async modelCredentialOwnership(
    modelId: string
  ): Promise<CodexCredentialOwnership | null | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT credential FROM mar_agent_models WHERE id=?',
      [modelId]
    );
    const raw = rows[0]?.['credential'];
    if (raw === undefined || raw === null) return undefined;
    try {
      const parsed = marAgentModelCredentialSchema.parse(
        typeof raw === 'string'
          ? JSON.parse(raw)
          : Buffer.isBuffer(raw)
            ? JSON.parse(raw.toString('utf8'))
            : raw
      );
      return parsed.type === 'CREDENTIAL_REF'
        ? await this.readOwnership(parsed.credentialId)
        : null;
    } catch {
      return undefined;
    }
  }

  private async isUserInOwnership(
    userId: number,
    ownership: CodexCredentialOwnership
  ): Promise<boolean> {
    if (ownership.ownerType === 'PERSONAL') return ownership.ownerUserId === userId;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT organization_id FROM users WHERE id=? AND enabled=TRUE',
      [userId]
    );
    const organizationId = Number(rows[0]?.['organization_id']);
    return (
      Number.isSafeInteger(organizationId) &&
      (await this.isOrganizationInScope(organizationId, ownership.ownerOrganizationId))
    );
  }

  private async isGrantWithinOwnership(
    target: GrantTarget,
    ownership: CodexCredentialOwnership
  ): Promise<boolean> {
    if (ownership.ownerType === 'PERSONAL')
      return target.targetType === 'USER' && target.targetUserId === ownership.ownerUserId;
    const organizationId =
      target.targetType === 'ORGANIZATION'
        ? target.targetOrganizationId
        : await this.userOrganizationId(target.targetUserId);
    return (
      organizationId !== undefined &&
      this.isOrganizationInScope(organizationId, ownership.ownerOrganizationId)
    );
  }

  private async userOrganizationId(userId: number): Promise<number | undefined> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT organization_id FROM users WHERE id=? AND enabled=TRUE',
      [userId]
    );
    const organizationId = Number(rows[0]?.['organization_id']);
    return Number.isSafeInteger(organizationId) ? organizationId : undefined;
  }

  private async isOrganizationInScope(
    organizationId: number,
    ownerOrganizationId: number
  ): Promise<boolean> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `WITH RECURSIVE ancestors AS (
         SELECT id,parent_organization_id FROM organizations WHERE id=?
         UNION ALL
         SELECT parent.id,parent.parent_organization_id FROM organizations parent
         JOIN ancestors child ON child.parent_organization_id=parent.id
       ) SELECT 1 AS present FROM ancestors WHERE id=? LIMIT 1`,
      [organizationId, ownerOrganizationId]
    );
    return rows.length === 1;
  }
}

function grantTarget(row: RowDataPacket): GrantTarget {
  if (row['target_type'] === 'USER')
    return { targetType: 'USER', targetUserId: Number(row['target_user_id']) };
  if (row['target_type'] === 'ORGANIZATION')
    return {
      targetType: 'ORGANIZATION',
      targetOrganizationId: Number(row['target_organization_id'])
    };
  throw new Error('CODEX_CREDENTIAL_SCOPE_CONFLICT');
}
