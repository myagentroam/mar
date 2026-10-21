import { emitAudit, resourceAuditEvent, type AuditObserver } from './audit.js';
import { lockMysqlUsers } from './mysql-reference-store.js';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  imageGenerationCatalogSchema,
  imageGenerationUrlSchema,
  resourceOwnershipSchema,
  type CodexCredentialSummary,
  type ImageGenerationModel,
  type ResourceOwnership
} from '@myagentroam/protocol';

type ImageAccess = {
  lockOwnership?(connection: PoolConnection, ownership: ResourceOwnership): Promise<void>;
  cleanupImageModelResources?(connection: PoolConnection, modelId: string): Promise<void>;
  canUseImageModel(userId: number, modelId: string): Promise<boolean>;
  canManageImageModel?(userId: number, modelId: string): Promise<boolean>;
  assertOwnershipSelection?(userId: number, ownership: ResourceOwnership): Promise<void>;
};

export class ImageGenerationConfigurationService {
  constructor(
    private readonly database: { readonly raw: Pool } & Partial<AuditObserver>,
    private readonly credentials: {
      type?(credentialId: string): Promise<CodexCredentialSummary['type']>;
      assertUserInScope(userId: number, credentialId: string): Promise<void>;
      details(actorUserId: number, credentialId: string): Promise<unknown>;
      status(credentialId: string): Promise<'ACTIVE' | 'DEGRADED' | 'REAUTH_REQUIRED'>;
      assertModelCredentialBinding?(
        actorUserId: number,
        credentialId: string,
        modelId?: string,
        ownership?: ResourceOwnership
      ): Promise<void>;
    },
    private readonly now: () => number = Date.now,
    private readonly access?: ImageAccess
  ) {}

  private async stored(): Promise<ImageGenerationModel[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,name,owner_type,owner_user_id,owner_organization_id,provider,config,
              enabled,sort_order
       FROM mar_agent_image_models ORDER BY sort_order,normalized_name,id`
    );
    try {
      return imageGenerationCatalogSchema.parse(rows.map(storedModel));
    } catch {
      throw new Error('MAR_AGENT_IMAGE_GENERATION_CONFIG_INVALID');
    }
  }

  async get(actorUserId?: number): Promise<ImageGenerationModel[]> {
    const models = await this.stored();
    const managed =
      actorUserId === undefined
        ? models
        : (
            await Promise.all(
              models.map(async (model) =>
                (await this.canManage(actorUserId, model)) ? model : null
              )
            )
          ).filter((model): model is ImageGenerationModel => model !== null);
    return managed.map(publicModel);
  }

  async update(actorUserId: number, raw: unknown): Promise<ImageGenerationModel[]> {
    const requested = imageGenerationCatalogSchema.parse(raw);
    const previous = await this.stored();
    const managed = new Map<string, ImageGenerationModel>();
    for (const model of previous)
      if (await this.canManage(actorUserId, model)) managed.set(model.id, model);
    for (const model of requested) {
      const existing = previous.find((item) => item.id === model.id);
      if (existing !== undefined && !managed.has(model.id))
        throw new Error('IMAGE_MODEL_RESOURCE_ADMIN_REQUIRED');
      const ownership = await this.ownership(actorUserId, model, existing);
      if (model.provider === 'CODEX') {
        await this.credentials.assertModelCredentialBinding?.(
          actorUserId,
          model.config.credentialId,
          undefined,
          ownership
        );
        if (!(await this.supportsCodexImages(model.config.credentialId)))
          throw new Error('IMAGE_MODEL_CONFIG_INVALID');
        if (
          existing?.provider !== 'CODEX' ||
          existing.config.credentialId !== model.config.credentialId
        )
          await this.credentials.details(actorUserId, model.config.credentialId);
      } else {
        const unchangedMissingUrl =
          existing?.provider === 'BYTED_ARK' &&
          existing.config.url === undefined &&
          model.config.url === undefined &&
          model.config.modelId === existing.config.modelId &&
          model.config.apiKey === undefined;
        if (!unchangedMissingUrl) imageGenerationUrlSchema.parse(model.config.url);
        model.config.apiKey ??=
          existing?.provider === 'BYTED_ARK' ? existing.config.apiKey : undefined;
        delete model.config.hasApiKey;
        if (!model.config.apiKey) throw new Error('MAR_AGENT_IMAGE_GENERATION_API_KEY_REQUIRED');
      }
      Object.assign(model, { ownership });
    }
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      for (const model of requested) {
        const ownership = model.ownership!;
        await this.access?.lockOwnership?.(connection, ownership);
        if (ownership.ownerType === 'ORGANIZATION' && this.access?.lockOwnership === undefined)
          throw new Error('ORGANIZATION_NOT_FOUND');
      }
      await lockMysqlUsers(connection, [
        actorUserId,
        ...requested.map((model) =>
          model.ownership?.ownerType === 'PERSONAL' ? model.ownership.ownerUserId : null
        )
      ]);
      await connection.execute('SELECT id FROM mar_agent_image_models ORDER BY id FOR UPDATE');
      const requestedIds = new Set(requested.map((model) => model.id));
      for (const id of managed.keys())
        if (!requestedIds.has(id)) {
          await this.access?.cleanupImageModelResources?.(connection, id);
          await connection.execute(
            'DELETE FROM user_mar_agent_image_model_orders WHERE image_model_id=?',
            [id]
          );
          await connection.execute('DELETE FROM mar_agent_image_models WHERE id=?', [id]);
        }
      const now = this.now();
      for (const [sortOrder, model] of requested.entries()) {
        const ownership = model.ownership!;
        await connection.execute(
          `INSERT INTO mar_agent_image_models
             (id,name,normalized_name,owner_type,owner_user_id,owner_organization_id,provider,
              config,enabled,sort_order,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE name=VALUES(name),normalized_name=VALUES(normalized_name),
             provider=VALUES(provider),config=VALUES(config),enabled=VALUES(enabled),
             sort_order=VALUES(sort_order),updated_at=VALUES(updated_at)`,
          [
            model.id,
            model.name,
            normalizeName(model.name),
            ownership.ownerType,
            ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
            ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
            model.provider,
            JSON.stringify(model.config),
            model.enabled,
            sortOrder,
            actorUserId,
            now,
            now
          ]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    const requestedIds = new Set(requested.map((model) => model.id));
    for (const model of requested) {
      const before = managed.get(model.id);
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: before ? 'image_model.updated' : 'image_model.created',
            actorUserId,
            targetType: 'IMAGE_MODEL',
            targetId: model.id
          },
          { ...model, ...model.ownership },
          {
            ...(before
              ? {
                  before: { name: before.name, enabled: before.enabled, provider: before.provider }
                }
              : {}),
            after: { name: model.name, enabled: model.enabled, provider: model.provider }
          }
        )
      );
    }
    for (const model of managed.values())
      if (!requestedIds.has(model.id))
        emitAudit(
          this.database,
          resourceAuditEvent(
            {
              eventType: 'image_model.deleted',
              actorUserId,
              targetType: 'IMAGE_MODEL',
              targetId: model.id
            },
            { ...model, ...model.ownership }
          )
        );
    return this.get(actorUserId);
  }

  async forUser(userId: number): Promise<ImageGenerationModel | null> {
    for (const model of await this.stored()) {
      if (!model.enabled || !(await this.canUse(userId, model))) continue;
      if (model.provider === 'BYTED_ARK') {
        if (model.config.apiKey && model.config.url) return model;
        continue;
      }
      try {
        if (!(await this.supportsCodexImages(model.config.credentialId))) continue;
        await this.credentials.assertUserInScope(userId, model.config.credentialId);
        if ((await this.credentials.status(model.config.credentialId)) === 'REAUTH_REQUIRED')
          continue;
        return model;
      } catch (error) {
        if (
          error instanceof Error &&
          [
            'CODEX_CREDENTIAL_SCOPE_FORBIDDEN',
            'CODEX_CREDENTIAL_NOT_FOUND',
            'CODEX_CREDENTIAL_REAUTH_REQUIRED'
          ].includes(error.message)
        )
          continue;
        throw error;
      }
    }
    return null;
  }

  private async supportsCodexImages(credentialId: string): Promise<boolean> {
    const type = await this.credentials.type?.(credentialId);
    return type === undefined || type === 'CODEX_OAUTH';
  }

  private async ownership(
    actorUserId: number,
    model: ImageGenerationModel,
    existing?: ImageGenerationModel
  ): Promise<ResourceOwnership> {
    const parsed = resourceOwnershipSchema.safeParse(
      model.ownership ?? existing?.ownership ?? { ownerType: 'PERSONAL', ownerUserId: actorUserId }
    );
    if (!parsed.success) throw new Error('MAR_AGENT_IMAGE_GENERATION_CONFIG_INVALID');
    if (
      existing !== undefined &&
      JSON.stringify(existing.ownership) !== JSON.stringify(parsed.data)
    )
      throw new Error('IMAGE_MODEL_OWNERSHIP_IMMUTABLE');
    if (this.access?.assertOwnershipSelection !== undefined)
      await this.access.assertOwnershipSelection(actorUserId, parsed.data);
    else if (parsed.data.ownerType !== 'PERSONAL' || parsed.data.ownerUserId !== actorUserId)
      throw new Error('PERSONAL_RESOURCE_FORBIDDEN');
    return parsed.data;
  }

  private async canManage(userId: number, model: ImageGenerationModel): Promise<boolean> {
    if (this.access?.canManageImageModel !== undefined)
      return this.access.canManageImageModel(userId, model.id);
    return model.ownership?.ownerType === 'PERSONAL' && model.ownership.ownerUserId === userId;
  }

  private async canUse(userId: number, model: ImageGenerationModel): Promise<boolean> {
    if (this.access !== undefined) return this.access.canUseImageModel(userId, model.id);
    return model.ownership?.ownerType === 'PERSONAL' && model.ownership.ownerUserId === userId;
  }
}

function storedModel(row: RowDataPacket): ImageGenerationModel {
  const ownership: ResourceOwnership =
    row['owner_type'] === 'ORGANIZATION'
      ? { ownerType: 'ORGANIZATION', ownerOrganizationId: Number(row['owner_organization_id']) }
      : { ownerType: 'PERSONAL', ownerUserId: Number(row['owner_user_id']) };
  return {
    id: String(row['id']),
    name: String(row['name']),
    enabled: Boolean(row['enabled']),
    ownership,
    sortOrder: Number(row['sort_order']),
    provider: row['provider'],
    config: jsonValue(row['config'])
  } as ImageGenerationModel;
}
function publicModel(model: ImageGenerationModel): ImageGenerationModel {
  return model.provider === 'CODEX'
    ? model
    : {
        ...model,
        config: {
          url: model.config.url,
          modelId: model.config.modelId,
          hasApiKey: Boolean(model.config.apiKey)
        }
      };
}
function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  return value;
}
function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
