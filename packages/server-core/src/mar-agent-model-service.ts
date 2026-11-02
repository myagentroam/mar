import { emitAudit, resourceAuditEvent, deferMysqlAudit, type AuditObserver } from './audit.js';
import { withMysqlTransaction, lockMysqlUsers, lockMysqlModels } from './mysql-reference-store.js';
import { randomBytes } from 'node:crypto';
import { MarAgentResourceInputService } from './mar-agent-resource-input-service.js';
import {
  ModelSettingsStore,
  modelSettingsFromInput,
  parseStoredModelSettings,
  type ModelSettings
} from './model-settings.js';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  XAI_SUBSCRIPTION_BASE_URL,
  codexModelImportRequestSchema,
  codexModelImportResultSchema,
  marAgentModelTransportTestResultSchema,
  marAgentModelCredentialSchema,
  resourceOwnershipSchema,
  marAgentReasoningEffortSchema,
  marAgentRuntimeModelConfigurationSchema,
  marAgentStoredModelConfigurationSchema,
  resolveMarAgentDefaultReasoningEffort,
  type CodexModelCatalog,
  type CodexModelImportResult,
  type ConversationTemplateModelReference,
  type MarAgentModelCredential,
  type MarAgentReasoningEffort,
  type MarAgentModelSummary,
  type ResourceOwnership,
  type MarAgentRuntimeModelConfiguration,
  type MarAgentStoredModelConfiguration
} from '@myagentroam/protocol';

const CHATGPT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 256_000;
const DEFAULT_CODEX_MAX_OUTPUT_TOKENS = 32_000;
const MODEL_CONFIGURATION_ID_BYTES = 12;

function parseOrderInput(raw: unknown, allowEmpty: boolean): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const modelIds = (raw as Record<string, unknown>).modelIds;
  if (
    !Array.isArray(modelIds) ||
    (!allowEmpty && modelIds.length === 0) ||
    modelIds.length > 1_000 ||
    modelIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128) ||
    new Set(modelIds).size !== modelIds.length
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return modelIds;
}

export class MarAgentModelService {
  readonly resourceInput: MarAgentResourceInputService;
  private readonly modelSettings: ModelSettingsStore;
  constructor(
    protected readonly database: { readonly raw: Pool } & Partial<AuditObserver>,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = createModelConfigurationId,
    protected readonly access?: {
      lockOwnership?(connection: PoolConnection, ownership: ResourceOwnership): Promise<void>;
      cleanupModelResources?(connection: PoolConnection, modelId: string): Promise<void>;
      canUseModel(userId: number, modelId: string): Promise<boolean>;
      canManageModel?(userId: number, modelId: string): Promise<boolean>;
      assertOwnershipSelection?(userId: number, ownership: ResourceOwnership): Promise<void>;
      listTemplateOptionsForNode?(
        nodeId: string
      ): Promise<readonly ConversationTemplateModelReference[]>;
    },
    private readonly credentialScopes?: {
      assertStoredCredentialTarget?(credentialId: string, baseUrl: string): Promise<void>;
      credentialTarget?(userId: number, credentialId: string): Promise<string>;
      assertCredentialTarget?(userId: number, credentialId: string, baseUrl: string): Promise<void>;
      assertModelCredentialBinding(
        actorUserId: number,
        credentialId: string,
        modelId?: string,
        ownership?: ResourceOwnership
      ): Promise<void>;
    }
  ) {
    this.resourceInput = new MarAgentResourceInputService(database);
    this.modelSettings = new ModelSettingsStore(now);
  }

  async resourceInputEnabled(): Promise<boolean> {
    return (await this.resourceInput.read()).useResourceUrl;
  }

  async #resourceMetadata<T extends MarAgentModelSummary | MarAgentStoredModelConfiguration>(
    models: readonly T[]
  ) {
    const settings = await this.resourceInput.models(models.map((model) => model.id));
    return models.map((model) => ({ ...model, metadata: settings.get(model.id)! }));
  }

  async #assertCredentialBinding(
    actorUserId: number,
    credential: MarAgentModelCredential,
    modelId?: string,
    ownership?: ResourceOwnership
  ): Promise<void> {
    if (credential.type !== 'CREDENTIAL_REF') return;
    if (this.credentialScopes === undefined) throw new Error('CODEX_CREDENTIAL_NOT_FOUND');
    await this.credentialScopes.assertModelCredentialBinding(
      actorUserId,
      credential.credentialId,
      modelId,
      ownership
    );
  }
  async #assertTarget(userId: number, model: ParsedModel) {
    if (model.credential.type !== 'CREDENTIAL_REF') return;
    if (this.credentialScopes?.assertCredentialTarget)
      await this.credentialScopes.assertCredentialTarget(
        userId,
        model.credential.credentialId,
        model.baseUrl
      );
    else if (model.baseUrl === CHATGPT_BASE_URL) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  }
  async list(): Promise<readonly MarAgentModelSummary[]> {
    return this.#summaries(await this.summaryRows());
  }

  async #summaries(rows: readonly RowDataPacket[]): Promise<readonly MarAgentModelSummary[]> {
    const settings = await this.#settingsForRows(rows);
    const models = await Promise.all(
      rows.map(async (row) => {
        const model = summary(row, settings.get(String(row.id))!);
        if (row.credential !== undefined && row.credential !== null)
          await this.#assertStoredTarget({
            ...model,
            credential: marAgentModelCredentialSchema.parse(jsonValue(row.credential))
          });
        return model;
      })
    );
    return this.#resourceMetadata(models);
  }

  async #settingsForRows(rows: readonly RowDataPacket[]): Promise<Map<string, ModelSettings>> {
    return new Map(
      rows.map((row) => [
        String(row.id),
        parseStoredModelSettings(
          row.protocol as MarAgentModelSummary['protocol'],
          row['model_settings']
        )
      ])
    );
  }

  async listManagedForUser(userId: number): Promise<readonly MarAgentModelSummary[]> {
    const rows = await this.#candidateRows(false, false);
    const visible =
      this.access?.canManageModel !== undefined
        ? (
            await Promise.all(
              rows.map(async (row) =>
                (await this.access!.canManageModel!(userId, String(row.id))) ? row : null
              )
            )
          ).filter((row): row is RowDataPacket => row !== null)
        : rows.filter(
            (row) =>
              row.owner_type === 'ORGANIZATION' ||
              Number(row.owner_user_id ?? row.created_by) === userId
          );
    return this.#summaries(await this.summaryRows(visible.map((row) => String(row.id))));
  }

  async #candidateRows(enabled: boolean, conversation: boolean): Promise<RowDataPacket[]> {
    const conditions = [
      enabled ? 'enabled=1' : '',
      conversation ? 'conversation_model=1' : ''
    ].filter(Boolean);
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,owner_type,owner_user_id,created_by FROM mar_agent_models ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}`
    );
    return rows;
  }

  protected async summaryRows(
    modelIds?: readonly string[],
    conversationOnly = false
  ): Promise<RowDataPacket[]> {
    if (modelIds?.length === 0) return [];
    const conditions = [
      modelIds === undefined ? '' : `model.id IN (${modelIds.map(() => '?').join(',')})`,
      conversationOnly ? 'model.enabled=1 AND model.conversation_model=1' : ''
    ].filter(Boolean);
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT model.id,model.name,model.protocol,model.base_url,model.model_id,
              model.context_window_tokens,model.max_output_tokens,model.input_capabilities,
              model.output_capabilities,model.reasoning_efforts,
              model.default_reasoning_effort,model.conversation_model,model.subagent_model,model.title_generation,model.code_mode,
              model.credential,
              model.enabled,model.sort_order,
              model.last_tested_at,model.last_test_status,model.last_test_code,
              model.owner_type,model.owner_user_id,model.owner_organization_id,
              FALSE AS public_access,model_settings.setting_value AS model_settings
       FROM mar_agent_models model
       LEFT JOIN system_settings model_settings ON model_settings.setting_key=CONCAT('mar_agent_model_config:',model.id)
       ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
       ORDER BY model.sort_order,model.normalized_name,model.id`,
      modelIds === undefined ? [] : [...modelIds]
    );
    return rows;
  }

  async listForUser(userId: number): Promise<readonly MarAgentModelSummary[]> {
    const rows = await this.#candidateRows(true, true);
    const visibleRows =
      this.access === undefined
        ? rows
        : (
            await Promise.all(
              rows.map(async (row) =>
                (await this.access!.canUseModel(userId, String(row.id))) ? row : null
              )
            )
          ).filter((row): row is RowDataPacket => row !== null);
    const visible = await this.#summaries(
      await this.summaryRows(
        visibleRows.map((row) => String(row.id)),
        true
      )
    );
    const ordered = await this.#applyUserOrder(userId, visible);
    return deduplicateModelsByName(ordered.map(({ ownership: _ownership, ...model }) => model));
  }

  async listTemplateOptionsForNode(
    nodeId: string
  ): Promise<readonly ConversationTemplateModelReference[]> {
    if (this.access?.listTemplateOptionsForNode === undefined) throw new Error('NODE_NOT_FOUND');
    return this.access.listTemplateOptionsForNode(nodeId);
  }

  async create(userId: number, raw: unknown): Promise<MarAgentModelSummary> {
    const parsed = parseInput(raw, true);
    const ownership = await this.#ownership(userId, raw);
    await this.#assertCredentialBinding(userId, parsed.credential, undefined, ownership);
    await this.#assertTarget(userId, parsed);
    const id = this.id();
    const now = this.now();
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await this.#lockOwnership(connection, ownership, userId);
      await connection.execute(
        "INSERT INTO mar_agent_models (id,name,normalized_name,protocol,base_url,credential,model_id,context_window_tokens,max_output_tokens,input_capabilities,output_capabilities,reasoning_efforts,default_reasoning_effort,conversation_model,subagent_model,title_generation,code_mode,enabled,sort_order,last_test_status,owner_type,owner_user_id,owner_organization_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNVERIFIED',?,?,?,?,?,?)",
        [
          id,
          parsed.name,
          normalizeMarAgentModelName(parsed.name),
          parsed.protocol,
          parsed.baseUrl,
          JSON.stringify(parsed.credential),
          parsed.modelId,
          parsed.contextWindowTokens,
          parsed.maxOutputTokens,
          JSON.stringify(parsed.inputCapabilities),
          JSON.stringify(parsed.outputCapabilities),
          JSON.stringify(parsed.reasoningEfforts),
          parsed.defaultReasoningEffort,
          parsed.conversationModel,
          parsed.subagentModel,
          parsed.titleGeneration,
          parsed.codeMode,
          parsed.enabled,
          parsed.sortOrder,
          ownership.ownerType,
          ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
          ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
          userId,
          now,
          now
        ]
      );
      await this.modelSettings.write(
        id,
        parsed.protocol,
        modelSettingsFromInput(parsed),
        connection
      );
      await this.resourceInput.write(parsed.metadata ?? { useResourceUrl: false }, connection, id);
    });
    const created = (await this.#summaries(await this.summaryRows([id])))[0];
    if (!created) throw new Error('MAR_AGENT_MODEL_PERSIST_FAILED');
    emitAudit(
      this.database,
      resourceAuditEvent(
        { eventType: 'model.created', actorUserId: userId, targetType: 'MODEL', targetId: id },
        { ...created, ...ownership },
        {}
      )
    );
    return created;
  }

  async duplicate(userId: number, sourceId: string, raw: unknown): Promise<MarAgentModelSummary> {
    await this.#assertManage(userId, sourceId);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    const source = await this.stored(sourceId);
    const record = raw as Record<string, unknown>;
    return this.create(userId, {
      ...record,
      metadata: record.metadata ?? source.metadata,
      credential:
        record.credential ??
        (typeof record.apiKey === 'string' && record.apiKey.length > 0
          ? { type: 'INLINE_API_KEY', value: record.apiKey }
          : source.credential)
    });
  }

  async update(actorUserId: number, modelId: string, raw: unknown): Promise<MarAgentModelSummary> {
    await this.#assertManage(actorUserId, modelId);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    const existingSummary = await this.requireSummary(modelId);
    const existing = await this.stored(modelId);
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT sort_order FROM mar_agent_models WHERE id=?',
      [modelId]
    );
    if (!rows[0]) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
    const record = raw as Record<string, unknown>;
    const credential =
      record.credential ??
      (typeof record.apiKey === 'string' && record.apiKey.length > 0
        ? { type: 'INLINE_API_KEY', value: record.apiKey }
        : existing.credential);
    const parsed = parseInput(
      {
        ...existing,
        ...record,
        credential,
        serviceTier: Object.hasOwn(record, 'serviceTier')
          ? record.serviceTier
          : record.protocol !== undefined && record.protocol !== 'OPENAI_RESPONSES'
            ? undefined
            : existing.serviceTier,
        responsesTransport: Object.hasOwn(record, 'responsesTransport')
          ? record.responsesTransport
          : record.protocol !== undefined && record.protocol !== 'OPENAI_RESPONSES'
            ? undefined
            : existing.responsesTransport,
        sortOrder:
          typeof record.sortOrder === 'number' ? record.sortOrder : Number(rows[0].sort_order)
      },
      true
    );
    await this.#assertCredentialBinding(
      actorUserId,
      parsed.credential,
      modelId,
      existingSummary.ownership
    );
    await this.#assertTarget(actorUserId, parsed);
    await withMysqlTransaction(this.database.raw, async (connection) => {
      await connection.execute(
        "UPDATE mar_agent_models SET name=?,normalized_name=?,protocol=?,base_url=?,credential=?,model_id=?,context_window_tokens=?,max_output_tokens=?,input_capabilities=?,output_capabilities=?,reasoning_efforts=?,default_reasoning_effort=?,conversation_model=?,subagent_model=?,title_generation=?,code_mode=?,enabled=?,sort_order=?,last_test_status='UNVERIFIED',last_test_code=NULL,updated_at=? WHERE id=?",
        [
          parsed.name,
          normalizeMarAgentModelName(parsed.name),
          parsed.protocol,
          parsed.baseUrl,
          JSON.stringify(parsed.credential),
          parsed.modelId,
          parsed.contextWindowTokens,
          parsed.maxOutputTokens,
          JSON.stringify(parsed.inputCapabilities),
          JSON.stringify(parsed.outputCapabilities),
          JSON.stringify(parsed.reasoningEfforts),
          parsed.defaultReasoningEffort,
          parsed.conversationModel,
          parsed.subagentModel,
          parsed.titleGeneration,
          parsed.codeMode,
          parsed.enabled,
          parsed.sortOrder,
          this.now(),
          modelId
        ]
      );
      await this.modelSettings.write(
        modelId,
        parsed.protocol,
        modelSettingsFromInput(parsed),
        connection
      );
      await this.resourceInput.write(
        parsed.metadata ?? { useResourceUrl: false },
        connection,
        modelId
      );
    });
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'model.updated',
          actorUserId: actorUserId,
          targetType: 'MODEL',
          targetId: modelId
        },
        { ...existingSummary, ...existingSummary.ownership },
        {
          before: { name: existing.name, enabled: existing.enabled },
          after: { name: parsed.name, enabled: parsed.enabled }
        }
      )
    );
    return this.requireSummary(modelId);
  }

  async remove(modelId: string, actorUserId?: number): Promise<void> {
    if (actorUserId !== undefined) await this.#assertManage(actorUserId, modelId);
    await withMysqlTransaction(this.database.raw, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id,name,owner_type,owner_organization_id FROM mar_agent_models WHERE id=? FOR UPDATE',
        [modelId]
      );
      if (rows.length !== 1) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
      await this.access?.cleanupModelResources?.(connection, modelId);
      await connection.execute('DELETE FROM user_mar_agent_model_orders WHERE model_id=?', [
        modelId
      ]);
      await connection.execute('DELETE FROM mar_agent_models WHERE id=?', [modelId]);
      await this.modelSettings.remove(modelId, connection);
      await this.resourceInput.remove(modelId, connection);
      deferMysqlAudit(connection, () => {
        emitAudit(
          this.database,
          resourceAuditEvent(
            {
              eventType: 'model.deleted',
              ...(actorUserId === undefined ? {} : { actorUserId }),
              targetType: 'MODEL',
              targetId: modelId
            },
            rows[0]!,
            {}
          )
        );
      });
    });
  }

  async reorder(raw: unknown, actorUserId?: number): Promise<void> {
    const modelIds = parseOrderInput(raw, false);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM mar_agent_models FOR UPDATE'
      );
      const currentIds = new Set(rows.map((row) => String(row.id)));
      if (actorUserId !== undefined) {
        const managed = await this.listManagedForUser(actorUserId);
        const managedIds = new Set(managed.map((model) => model.id));
        for (const id of currentIds) if (!managedIds.has(id)) currentIds.delete(id);
        if (managedIds.size !== currentIds.size) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
      }
      if (currentIds.size !== modelIds.length || modelIds.some((id) => !currentIds.has(id)))
        throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
      for (const [sortOrder, modelId] of modelIds.entries())
        await connection.execute('UPDATE mar_agent_models SET sort_order=? WHERE id=?', [
          sortOrder,
          modelId
        ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async #lockOwnership(
    connection: PoolConnection,
    ownership: ResourceOwnership,
    userId: number
  ): Promise<void> {
    await this.access?.lockOwnership?.(connection, ownership);
    if (ownership.ownerType === 'ORGANIZATION' && this.access?.lockOwnership === undefined)
      throw new Error('ORGANIZATION_NOT_FOUND');
    await lockMysqlUsers(connection, [
      userId,
      ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null
    ]);
  }

  async #ownership(userId: number, raw: unknown): Promise<ResourceOwnership> {
    const record =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const parsed = resourceOwnershipSchema.safeParse(
      record.ownership ?? { ownerType: 'PERSONAL', ownerUserId: userId }
    );
    if (!parsed.success) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    if (this.access?.assertOwnershipSelection !== undefined)
      await this.access.assertOwnershipSelection(userId, parsed.data);
    else if (parsed.data.ownerType !== 'PERSONAL' || parsed.data.ownerUserId !== userId)
      throw new Error('PERSONAL_RESOURCE_FORBIDDEN');
    return parsed.data;
  }

  async #assertManage(userId: number, modelId: string): Promise<void> {
    if (this.access?.canManageModel !== undefined) {
      if (!(await this.access.canManageModel(userId, modelId)))
        throw new Error('MODEL_RESOURCE_ADMIN_REQUIRED');
      return;
    }
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT owner_type,owner_user_id FROM mar_agent_models WHERE id=?',
      [modelId]
    );
    if (
      rows.length !== 1 ||
      rows[0]?.['owner_type'] !== 'PERSONAL' ||
      Number(rows[0]?.['owner_user_id']) !== userId
    )
      throw new Error('MODEL_RESOURCE_ADMIN_REQUIRED');
  }

  async assertCanManage(userId: number, modelId: string): Promise<void> {
    await this.#assertManage(userId, modelId);
  }

  async reorderForUser(userId: number, raw: unknown): Promise<void> {
    const modelIds = parseOrderInput(raw, true);
    const visible = await this.listForUser(userId);
    const visibleIds = new Set(visible.map((model) => model.id));
    if (visibleIds.size !== modelIds.length || modelIds.some((id) => !visibleIds.has(id)))
      throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await lockMysqlUsers(connection, [userId]);
      await lockMysqlModels(connection, modelIds);
      await connection.execute('DELETE FROM user_mar_agent_model_orders WHERE user_id=?', [userId]);
      const updatedAt = this.now();
      for (const [sortOrder, modelId] of modelIds.entries())
        await connection.execute(
          `INSERT INTO user_mar_agent_model_orders (user_id,model_id,sort_order,updated_at)
           VALUES (?,?,?,?)`,
          [userId, modelId, sortOrder, updatedAt]
        );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async #applyUserOrder(
    userId: number,
    values: readonly MarAgentModelSummary[]
  ): Promise<readonly MarAgentModelSummary[]> {
    if (values.length === 0) return values;
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT model_id,sort_order FROM user_mar_agent_model_orders WHERE user_id=? ORDER BY sort_order,model_id',
      [userId]
    );
    const ranks = new Map<string, number>();
    for (const row of rows) {
      const modelId = row['model_id'];
      const sortOrder = row['sort_order'];
      if (typeof modelId === 'string' && Number.isSafeInteger(Number(sortOrder)))
        ranks.set(modelId, Number(sortOrder));
    }
    return values
      .map((model, globalIndex) => ({ model, globalIndex, rank: ranks.get(model.id) }))
      .sort(
        (left, right) =>
          (left.rank === undefined ? 1 : 0) - (right.rank === undefined ? 1 : 0) ||
          (left.rank ?? left.globalIndex) - (right.rank ?? right.globalIndex) ||
          left.globalIndex - right.globalIndex
      )
      .map(({ model }) => model);
  }

  async importCodexModels(
    userId: number,
    credentialId: string,
    catalog: CodexModelCatalog,
    raw: unknown
  ): Promise<CodexModelImportResult> {
    const baseUrl =
      (await this.credentialScopes?.credentialTarget?.(userId, credentialId)) ??
      DEFAULT_CODEX_BASE_URL;
    const request = codexModelImportRequestSchema.safeParse(raw);
    if (!request.success) throw new Error('CODEX_MODEL_IMPORT_INVALID');
    if (request.data.catalogHash !== catalog.catalogHash) throw new Error('CODEX_CATALOG_CHANGED');
    const ownership = await this.#ownership(userId, request.data);
    const credential = { type: 'CREDENTIAL_REF', credentialId } as const;
    await this.#assertCredentialBinding(userId, credential, undefined, ownership);
    const candidates = new Map(
      catalog.models.map((candidate) => [candidate.upstreamModelId, candidate])
    );
    const prepared = request.data.models.map((item) => {
      const candidate = candidates.get(item.upstreamModelId);
      if (candidate === undefined)
        return {
          upstreamModelId: item.upstreamModelId,
          status: 'BLOCKED' as const,
          code: 'CODEX_MODEL_IMPORT_BLOCKED' as const
        };
      const contextWindowTokens =
        candidate.contextWindowTokens ??
        item.contextWindowTokens ??
        DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS;
      const maxOutputTokens =
        candidate.maxOutputTokens ??
        Math.min(DEFAULT_CODEX_MAX_OUTPUT_TOKENS, contextWindowTokens - 1);
      const name = (item.name ?? candidate.displayName).trim();
      if (
        !name ||
        name.length > 128 ||
        maxOutputTokens <= 0 ||
        maxOutputTokens >= contextWindowTokens
      )
        return {
          upstreamModelId: item.upstreamModelId,
          status: 'BLOCKED' as const,
          code: 'CODEX_MODEL_IMPORT_BLOCKED' as const
        };
      return {
        upstreamModelId: item.upstreamModelId,
        modelId: this.id(),
        name,
        contextWindowTokens,
        maxOutputTokens,
        inputCapabilities: candidate.inputCapabilities,
        reasoningEfforts: candidate.reasoningEfforts,
        defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
          candidate.defaultReasoningEffort,
          candidate.reasoningEfforts
        ),
        codeMode: false,
        serviceTier: 'default' as const,
        hostedWebSearch: baseUrl === XAI_SUBSCRIPTION_BASE_URL ? true : candidate.hostedWebSearch,
        responsesTransport:
          baseUrl === XAI_SUBSCRIPTION_BASE_URL
            ? { transport: 'HTTP' as const, httpVersion: '1.1' as const }
            : { transport: 'WEBSOCKET' as const },
        responsesPreviousResponseId: baseUrl !== XAI_SUBSCRIPTION_BASE_URL,
        enabled: item.enabled
      };
    });
    for (const model of prepared)
      if (model.status !== 'BLOCKED')
        await this.#assertCredentialBinding(userId, credential, model.modelId, ownership);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      await this.#lockOwnership(connection, ownership, userId);
      const [existingRows] = await connection.execute<RowDataPacket[]>(
        'SELECT sort_order FROM mar_agent_models FOR UPDATE'
      );
      let nextSortOrder =
        existingRows.reduce((maximum, row) => Math.max(maximum, Number(row.sort_order)), -1) + 1;
      const items: CodexModelImportResult['items'][number][] = [];
      for (const model of prepared) {
        if (model.status === 'BLOCKED') {
          items.push({
            upstreamModelId: model.upstreamModelId,
            status: model.status,
            code: model.code
          });
          continue;
        }
        const normalizedName = normalizeMarAgentModelName(model.name);
        const now = this.now();
        const sortOrder = nextSortOrder;
        await connection.execute<ResultSetHeader>(
          `INSERT INTO mar_agent_models
               (id,name,normalized_name,protocol,base_url,credential,model_id,
                context_window_tokens,max_output_tokens,input_capabilities,output_capabilities,
                reasoning_efforts,default_reasoning_effort,code_mode,enabled,sort_order,last_test_status,
                owner_type,owner_user_id,owner_organization_id,
                created_by,created_at,updated_at)
               VALUES (?,?,?,'OPENAI_RESPONSES',?,?,?,?,?,?,?,?,?,?,?,?,'UNVERIFIED',?,?,?,?,?,?)`,
          [
            model.modelId,
            model.name,
            normalizedName,
            baseUrl,
            JSON.stringify({ type: 'CREDENTIAL_REF', credentialId }),
            model.upstreamModelId,
            model.contextWindowTokens,
            model.maxOutputTokens,
            JSON.stringify(model.inputCapabilities),
            JSON.stringify(['TEXT']),
            JSON.stringify(model.reasoningEfforts),
            model.defaultReasoningEffort,
            model.codeMode,
            model.enabled,
            sortOrder,
            ownership.ownerType,
            ownership.ownerType === 'PERSONAL' ? ownership.ownerUserId : null,
            ownership.ownerType === 'ORGANIZATION' ? ownership.ownerOrganizationId : null,
            userId,
            now,
            now
          ]
        );
        await this.modelSettings.write(
          model.modelId,
          'OPENAI_RESPONSES',
          modelSettingsFromInput({
            protocol: 'OPENAI_RESPONSES',
            serviceTier: model.serviceTier ?? 'default',
            hostedWebSearch: model.hostedWebSearch,
            responsesTransport: model.responsesTransport,
            responsesPreviousResponseId: model.responsesPreviousResponseId
          }),
          connection
        );
        nextSortOrder += 1;
        items.push({
          upstreamModelId: model.upstreamModelId,
          status: 'CREATED',
          modelId: model.modelId
        });
      }
      await connection.commit();
      return codexModelImportResultSchema.parse({ items });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async runtime(modelId: string) {
    return runtimeConfiguration(await this.stored(modelId), await this.resourceInputEnabled());
  }

  async stored(modelId: string): Promise<MarAgentStoredModelConfiguration> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      "SELECT model.*,model_settings.setting_value AS model_settings FROM mar_agent_models model LEFT JOIN system_settings model_settings ON model_settings.setting_key=CONCAT('mar_agent_model_config:',model.id) WHERE model.id=?",
      [modelId]
    );
    const row = rows[0];
    if (!row) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
    const settings = await this.#settingsForRows([row]);
    const model = storedConfiguration(row, settings.get(String(row.id))!);
    await this.#assertStoredTarget(model);
    return (await this.#resourceMetadata([model]))[0]!;
  }

  async storedConfigurations(): Promise<readonly MarAgentStoredModelConfiguration[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      "SELECT model.*,model_settings.setting_value AS model_settings FROM mar_agent_models model LEFT JOIN system_settings model_settings ON model_settings.setting_key=CONCAT('mar_agent_model_config:',model.id) WHERE model.enabled=1 ORDER BY model.sort_order,model.normalized_name,model.id"
    );
    return this.#storedConfigurations(rows);
  }

  async #storedConfigurations(
    rows: readonly RowDataPacket[]
  ): Promise<readonly MarAgentStoredModelConfiguration[]> {
    const settings = await this.#settingsForRows(rows);
    const models = rows.map((row) => storedConfiguration(row, settings.get(String(row.id))!));
    await Promise.all(models.map((model) => this.#assertStoredTarget(model)));
    return this.#resourceMetadata(models);
  }

  async #assertStoredTarget(model: MarAgentStoredModelConfiguration): Promise<void> {
    if (model.credential.type === 'CREDENTIAL_REF') {
      if (
        !this.credentialScopes?.assertStoredCredentialTarget &&
        model.baseUrl === CHATGPT_BASE_URL
      )
        throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
      await this.credentialScopes?.assertStoredCredentialTarget?.(
        model.credential.credentialId,
        model.baseUrl
      );
    }
  }

  async storedConfigurationsForUser(
    userId: number
  ): Promise<readonly MarAgentStoredModelConfiguration[]> {
    const candidates = await this.#candidateRows(true, false);
    const visible =
      this.access === undefined
        ? candidates
        : (
            await Promise.all(
              candidates.map(async (row) =>
                (await this.access!.canUseModel(userId, String(row.id))) ? row : null
              )
            )
          ).filter((row): row is RowDataPacket => row !== null);
    if (visible.length === 0) return [];
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT model.*,model_settings.setting_value AS model_settings FROM mar_agent_models model LEFT JOIN system_settings model_settings ON model_settings.setting_key=CONCAT('mar_agent_model_config:',model.id) WHERE model.enabled=1 AND model.id IN (${visible.map(() => '?').join(',')}) ORDER BY model.sort_order,model.normalized_name,model.id`,
      visible.map((row) => String(row.id))
    );
    return this.#storedConfigurations(rows);
  }

  async runtimeForUser(userId: number, modelId: string) {
    if (this.access !== undefined && !(await this.access.canUseModel(userId, modelId)))
      throw new Error('MAR_AGENT_MODEL_FORBIDDEN');
    const configuration = await this.runtime(modelId);
    if (!configuration.enabled || configuration.conversationModel === false)
      throw new Error('MAR_AGENT_MODEL_DISABLED');
    return configuration;
  }

  async runtimeConfigurations() {
    const enabled = await this.resourceInputEnabled();
    return (await this.storedConfigurations()).map((model) => runtimeConfiguration(model, enabled));
  }

  async runtimeConfigurationsForUser(userId: number) {
    const enabled = await this.resourceInputEnabled();
    return (await this.storedConfigurationsForUser(userId)).map((model) =>
      runtimeConfiguration(model, enabled)
    );
  }

  async lease(modelId: string) {
    const configuration = await this.runtime(modelId);
    if (!configuration.enabled) throw new Error('MAR_AGENT_MODEL_DISABLED');
    return {
      configuration,
      release: () => undefined
    };
  }

  async recordTestResult(modelId: string, raw: unknown, actorUserId?: number): Promise<void> {
    if (actorUserId !== undefined) await this.#assertManage(actorUserId, modelId);
    const result = marAgentModelTransportTestResultSchema.parse(raw);
    const [updated] = await this.database.raw.execute<ResultSetHeader>(
      'UPDATE mar_agent_models SET last_tested_at=?,last_test_status=?,last_test_code=?,updated_at=? WHERE id=?',
      [this.now(), result.success ? 'SUCCEEDED' : 'FAILED', result.code, this.now(), modelId]
    );
    if (updated.affectedRows !== 1) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
  }

  private async requireSummary(modelId: string) {
    const value = (await this.#summaries(await this.summaryRows([modelId])))[0];
    if (!value) throw new Error('MAR_AGENT_MODEL_NOT_FOUND');
    return value;
  }
}

interface ParsedModel {
  metadata?: { useResourceUrl: boolean };
  name: string;
  protocol: MarAgentModelSummary['protocol'];
  baseUrl: string;
  credential: MarAgentModelCredential;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  inputCapabilities: MarAgentModelSummary['inputCapabilities'];
  outputCapabilities: MarAgentModelSummary['outputCapabilities'];
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
  conversationModel: boolean;
  subagentModel: boolean;
  titleGeneration: boolean;
  codeMode: boolean;
  gcEnabled: boolean;
  serviceTier?: MarAgentModelSummary['serviceTier'];
  hostedWebSearch: boolean;
  responsesTransport?: MarAgentModelSummary['responsesTransport'];
  responsesPreviousResponseId: boolean;
  enabled: boolean;
  sortOrder: number;
}

function parseInput(raw: unknown, requireKey: boolean): ParsedModel {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const record = raw as Record<string, unknown>;
  if (Object.hasOwn(record, 'fastMode')) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const credential =
    record.credential ??
    (typeof record.apiKey === 'string' && record.apiKey.length > 0
      ? { type: 'INLINE_API_KEY', value: record.apiKey }
      : undefined);
  const responsesTransport = record.responsesTransport;
  const candidate = {
    id: 'validation',
    name: record.name,
    protocol: record.protocol,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : record.baseUrl,
    credential,
    modelId: record.modelId,
    contextWindowTokens: record.contextWindowTokens,
    maxOutputTokens: record.maxOutputTokens,
    inputCapabilities: record.inputCapabilities,
    outputCapabilities: record.outputCapabilities,
    reasoningEfforts: record.reasoningEfforts,
    defaultReasoningEffort: record.defaultReasoningEffort,
    conversationModel: record.conversationModel ?? true,
    subagentModel: record.subagentModel ?? false,
    titleGeneration: record.titleGeneration ?? false,
    codeMode: record.codeMode ?? false,
    gcEnabled: record.gcEnabled ?? true,
    metadata: record.metadata,
    serviceTier: record.serviceTier,
    hostedWebSearch: record.hostedWebSearch,
    responsesTransport,
    responsesPreviousResponseId: record.responsesPreviousResponseId ?? false,
    enabled: record.enabled
  };
  const parsed = marAgentStoredModelConfigurationSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.defaultReasoningEffort === undefined ||
    (requireKey && credential === undefined)
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const data = parsed.data as Omit<ParsedModel, 'sortOrder'> & { id: string };
  validateModelSettings(data);
  validateCredentialTarget(data.credential, data.protocol, data.baseUrl, data.responsesTransport);
  const url = new URL(data.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  const sortOrder =
    typeof record.sortOrder === 'number' && Number.isSafeInteger(record.sortOrder)
      ? record.sortOrder
      : 0;
  return {
    ...data,
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : (() => {
            throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
          })(),
    sortOrder
  };
}
function normalizeMarAgentModelName(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}
function createModelConfigurationId(): string {
  return `model-${randomBytes(MODEL_CONFIGURATION_ID_BYTES).toString('base64url')}`;
}
function deduplicateModelsByName(
  models: readonly MarAgentModelSummary[]
): readonly MarAgentModelSummary[] {
  const names = new Set<string>();
  return models.filter((model) => {
    const name = normalizeMarAgentModelName(model.name);
    if (names.has(name)) return false;
    names.add(name);
    return true;
  });
}
function runtimeConfiguration(
  value: MarAgentStoredModelConfiguration,
  resourceUrlsEnabled: boolean
): MarAgentRuntimeModelConfiguration {
  if (value.credential.type !== 'INLINE_API_KEY')
    throw new Error('MAR_AGENT_RUNTIME_CREDENTIAL_CONTEXT_REQUIRED');
  return marAgentRuntimeModelConfigurationSchema.parse({
    id: value.id,
    name: value.name,
    protocol: value.protocol,
    baseUrl: value.baseUrl,
    credential: value.credential,
    modelId: value.modelId,
    contextWindowTokens: value.contextWindowTokens,
    maxOutputTokens: value.maxOutputTokens,
    inputCapabilities: value.inputCapabilities,
    outputCapabilities: value.outputCapabilities,
    reasoningEfforts: value.reasoningEfforts,
    defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
      value.defaultReasoningEffort,
      value.reasoningEfforts
    ),
    conversationModel: value.conversationModel,
    subagentModel: value.subagentModel,
    titleGeneration: value.titleGeneration,
    codeMode: value.codeMode,
    gcEnabled: value.gcEnabled ?? true,
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
    hostedWebSearch: value.hostedWebSearch,
    useResourceUrl: resourceUrlsEnabled && value.metadata?.useResourceUrl === true,
    ...(value.responsesTransport === undefined
      ? {}
      : { responsesTransport: value.responsesTransport }),
    responsesPreviousResponseId: value.responsesPreviousResponseId,
    enabled: value.enabled
  }) as MarAgentRuntimeModelConfiguration;
}
function storedConfiguration(
  row: RowDataPacket,
  settings: ModelSettings
): MarAgentStoredModelConfiguration {
  const value = summary(row, settings);
  const baseUrl = String(row.base_url).trim();
  const credential = storedCredential(row);
  validateCredentialTarget(credential, value.protocol, baseUrl, value.responsesTransport);
  return marAgentStoredModelConfigurationSchema.parse({
    id: value.id,
    name: value.name,
    protocol: value.protocol,
    baseUrl,
    credential,
    modelId: value.modelId,
    contextWindowTokens: value.contextWindowTokens,
    maxOutputTokens: value.maxOutputTokens,
    inputCapabilities: value.inputCapabilities,
    outputCapabilities: value.outputCapabilities,
    reasoningEfforts: value.reasoningEfforts,
    defaultReasoningEffort: resolveMarAgentDefaultReasoningEffort(
      value.defaultReasoningEffort,
      value.reasoningEfforts
    ),
    conversationModel: value.conversationModel,
    subagentModel: value.subagentModel,
    titleGeneration: value.titleGeneration,
    codeMode: value.codeMode,
    gcEnabled: value.gcEnabled ?? true,
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
    hostedWebSearch: value.hostedWebSearch,
    ...(value.responsesTransport === undefined
      ? {}
      : { responsesTransport: value.responsesTransport }),
    responsesPreviousResponseId: value.responsesPreviousResponseId,
    enabled: value.enabled
  });
}
function validateCredentialTarget(
  credential: MarAgentModelCredential,
  protocol: MarAgentModelSummary['protocol'],
  baseUrl: string,
  responsesTransport: MarAgentModelSummary['responsesTransport']
): void {
  validateCredentialTargetType(credential.type, protocol, baseUrl, responsesTransport);
}
function validateCredentialTargetType(
  credentialType: MarAgentModelCredential['type'],
  protocol: MarAgentModelSummary['protocol'],
  baseUrl: string,
  responsesTransport: MarAgentModelSummary['responsesTransport']
): void {
  if (
    (credentialType === 'CREDENTIAL_REF' &&
      (protocol !== 'OPENAI_RESPONSES' ||
        ![DEFAULT_CODEX_BASE_URL, CHATGPT_BASE_URL, XAI_SUBSCRIPTION_BASE_URL].includes(
          baseUrl
        ))) ||
    (baseUrl === XAI_SUBSCRIPTION_BASE_URL &&
      credentialType === 'CREDENTIAL_REF' &&
      responsesTransport?.transport !== 'WEBSOCKET' &&
      (responsesTransport?.transport !== 'HTTP' || responsesTransport.httpVersion !== '1.1'))
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
}
function validateModelSettings(model: {
  baseUrl: string;
  credential: Pick<MarAgentModelCredential, 'type'>;
  serviceTier?: string | undefined;
  responsesTransport?: MarAgentModelSummary['responsesTransport'];
  responsesPreviousResponseId: boolean;
}): void {
  if (
    model.baseUrl === XAI_SUBSCRIPTION_BASE_URL &&
    model.credential.type === 'CREDENTIAL_REF' &&
    model.serviceTier !== undefined &&
    model.serviceTier !== 'default'
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
}
function storedCredential(row: RowDataPacket): MarAgentModelCredential {
  if (row.credential === undefined || row.credential === null) {
    if (typeof row.api_key === 'string' && row.api_key.length > 0)
      return { type: 'INLINE_API_KEY', value: row.api_key };
    throw new Error('MAR_AGENT_MODEL_CREDENTIAL_INVALID');
  }
  return marAgentModelCredentialSchema.parse(jsonValue(row.credential));
}
function jsonArray(value: unknown): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}
function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  return value;
}
function summary(row: RowDataPacket, settings: ModelSettings): MarAgentModelSummary {
  const credential =
    row.credential === undefined || row.credential === null
      ? { type: 'INLINE_API_KEY' as const, configured: true }
      : {
          type: marAgentModelCredentialSchema.parse(jsonValue(row.credential)).type,
          configured: true
        };
  const protocol = row.protocol as MarAgentModelSummary['protocol'];
  const baseUrl = String(row.base_url).trim();
  const responses = 'hostedWebSearch' in settings ? settings : undefined;
  const responsesTransport = responses?.responsesTransport;
  const reasoningEfforts = storedReasoningEfforts(row.reasoning_efforts);
  validateCredentialTargetType(credential.type, protocol, baseUrl, responsesTransport);
  const serviceTier = responses?.serviceTier;
  validateModelSettings({
    baseUrl,
    credential,
    serviceTier,
    responsesTransport,
    responsesPreviousResponseId: responses?.responsesPreviousResponseId ?? false
  });
  return {
    id: String(row.id),
    name: String(row.name),
    protocol,
    baseUrl,
    modelId: String(row.model_id),
    contextWindowTokens: Number(row.context_window_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
    inputCapabilities: jsonArray(
      row.input_capabilities
    ) as MarAgentModelSummary['inputCapabilities'],
    outputCapabilities: jsonArray(
      row.output_capabilities
    ) as MarAgentModelSummary['outputCapabilities'],
    reasoningEfforts,
    defaultReasoningEffort: storedDefaultReasoningEffort(
      row.default_reasoning_effort,
      reasoningEfforts
    ),
    conversationModel:
      row.conversation_model === undefined ? true : Boolean(row.conversation_model),
    subagentModel: row.subagent_model === undefined ? false : Boolean(row.subagent_model),
    titleGeneration: Boolean(row.title_generation),
    codeMode: Boolean(row.code_mode),
    gcEnabled: settings.gcEnabled ?? true,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    hostedWebSearch: responses?.hostedWebSearch ?? false,
    ...(responsesTransport === undefined ? {} : { responsesTransport }),
    responsesPreviousResponseId: responses?.responsesPreviousResponseId ?? false,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order),
    access: row.public_access ? 'PUBLIC' : 'RESTRICTED',
    credentialType: credential.type,
    credentialConfigured: credential.configured,
    lastTestedAt: row.last_tested_at === null ? null : Number(row.last_tested_at),
    lastTestStatus:
      row.last_test_status === null
        ? null
        : (String(row.last_test_status) as 'UNVERIFIED' | 'SUCCEEDED' | 'FAILED'),
    lastTestCode: row.last_test_code === null ? null : String(row.last_test_code),
    ownership:
      row.owner_type === 'ORGANIZATION'
        ? {
            ownerType: 'ORGANIZATION',
            ownerOrganizationId: Number(row.owner_organization_id)
          }
        : { ownerType: 'PERSONAL', ownerUserId: Number(row.owner_user_id ?? row.created_by) }
  };
}

function storedReasoningEfforts(value: unknown): MarAgentReasoningEffort[] {
  const efforts = jsonArray(value).map((effort) => marAgentReasoningEffortSchema.safeParse(effort));
  if (
    efforts.length > 6 ||
    efforts.some((effort) => !effort.success) ||
    new Set(efforts.map((effort) => (effort.success ? effort.data : undefined))).size !==
      efforts.length
  )
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return efforts.map((effort) => {
    if (!effort.success) throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
    return effort.data;
  });
}

function storedDefaultReasoningEffort(
  value: unknown,
  reasoningEfforts: readonly string[]
): MarAgentReasoningEffort {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim().length === 0)
  )
    return resolveMarAgentDefaultReasoningEffort(value, reasoningEfforts);
  const parsed = marAgentReasoningEffortSchema.safeParse(value);
  if (!parsed.success || (reasoningEfforts.length > 0 && !reasoningEfforts.includes(parsed.data)))
    throw new Error('MAR_AGENT_MODEL_CONFIG_INVALID');
  return parsed.data;
}
