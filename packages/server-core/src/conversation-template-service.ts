import {
  managementPageQuery,
  managementText,
  managementSearchPattern,
  managementOrder,
  readManagementPage
} from './management-pagination.js';
import {
  emitAuditAfterCommit,
  resourceAuditEvent,
  emitAudit,
  commitMysqlAudits,
  discardMysqlAudits
} from './audit.js';

import {
  withMysqlTransaction,
  lockMysqlUsers,
  lockMysqlWorkspace,
  lockMysqlTemplate,
  lockMysqlTemplateVersion
} from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  conversationTemplateDraftSchema,
  conversationTemplatePublishInputSchema,
  conversationTemplatePublishJobSchema,
  conversationTemplatePublishResultSchema,
  conversationTemplateSourceInspectionSchema,
  conversationTemplateSummarySchema,
  conversationTemplateVersionSchema,
  type ConversationTemplateDraft,
  type ConversationTemplateModelReference,
  type ConversationTemplatePublishJob,
  type ConversationTemplateSourceInspection,
  type ConversationTemplateSummary,
  type ConversationTemplateVersion
} from '@myagentroam/protocol';
import type { TemplateStore, TemplateResourcePolicy } from './hosted-contracts.js';
import type { MarAgentModelService } from './mar-agent-model-service.js';

export type ConversationTemplateInspectionMode = 'VALIDATE' | 'DRAFT_TEST';
export type InspectConversationTemplateDraft = (
  draft: ConversationTemplateDraft,
  mode: ConversationTemplateInspectionMode
) => Promise<unknown>;
export type PublishConversationTemplateDraft = (
  draft: ConversationTemplateDraft,
  jobId: string,
  requestedByUserId: number
) => Promise<unknown>;
export type RefreshConversationTemplatePublish = (
  nodeId: string,
  workspaceId: string,
  templateId: string,
  jobId: string
) => Promise<unknown>;
export interface ConversationTemplateRuntimeContext {
  readonly template: ConversationTemplateSummary;
  readonly nodeId: string;
  readonly workspaceId: string;
}
interface ConversationTemplatePublishContext {
  readonly templateId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly revision: number;
}
interface AdminConversationTemplateSummary extends ConversationTemplateSummary {
  readonly draftRevision: number;
  readonly publishedVersion: number | null;
}

const CREATE_DRAFT_KEYS = new Set([
  'nodeId',
  'workspaceId',
  'name',
  'description',
  'icon',
  'allowedModels',
  'defaultModelId',
  'mcpIds',
  'networkMode',
  'quotas'
]);
const UPDATE_DRAFT_KEYS = new Set([...CREATE_DRAFT_KEYS, 'draftRevision']);

export class ConversationTemplateService {
  constructor(
    private readonly database: TemplateStore,
    private readonly resources: TemplateResourcePolicy,
    private readonly models: Pick<MarAgentModelService, 'listTemplateOptionsForNode'>,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID
  ) {}

  async listForUser(userId: number): Promise<readonly ConversationTemplateSummary[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(templateDirectorySql(true));
    const visible = await Promise.all(
      rows.map(async (row) => {
        const summary = templateSummary(row);
        return summary.available && (await this.resources.canUseTemplate(userId, summary.id))
          ? summary
          : null;
      })
    );
    return visible.filter((value): value is ConversationTemplateSummary => value !== null);
  }

  async requireForCreate(userId: number, templateId: string): Promise<ConversationTemplateSummary> {
    const template = await this.assertCanUse(userId, templateId);
    if (template.status !== 'ACTIVE' || template.currentVersionId === null || !template.available)
      throw new Error('CONVERSATION_TEMPLATE_NOT_PUBLISHED');
    return template;
  }

  async assertCanUse(userId: number, templateId: string): Promise<ConversationTemplateSummary> {
    return (await this.runtimeContext(userId, templateId)).template;
  }

  async runtimeContext(
    userId: number,
    templateId: string
  ): Promise<ConversationTemplateRuntimeContext> {
    const row = await this.requireTemplateRow(templateId, true);
    if (!(await this.resources.canUseTemplate(userId, templateId)))
      throw new Error('CONVERSATION_TEMPLATE_NOT_AUTHORIZED');
    return {
      template: templateSummary(row),
      nodeId: String(row['source_node_id']),
      workspaceId: String(row['source_workspace_id'])
    };
  }

  async listAdmin(): Promise<readonly AdminConversationTemplateSummary[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(templateDirectorySql(false));
    return rows.map(adminTemplateSummary);
  }

  async listAdminQuery(query: Record<string, unknown>) {
    const paging = managementPageQuery(query);
    const keyword = managementText(query, 'keyword');
    const status = managementText(query, 'status');
    const predicates: string[] = [];
    const params: unknown[] = [];
    if (keyword) {
      predicates.push(
        "(template.name LIKE ? ESCAPE '!' OR template.description LIKE ? ESCAPE '!')"
      );
      params.push(managementSearchPattern(keyword), managementSearchPattern(keyword));
    }
    if (status) {
      if (!['ACTIVE', 'ARCHIVED', 'DELETED'].includes(status))
        throw new Error('MANAGEMENT_QUERY_INVALID');
      predicates.push('template.status=?');
      params.push(status);
    }
    const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
    const order = managementOrder(
      query,
      {
        name: 'template.name',
        status: 'template.status',
        updatedAt: 'template.updated_at',
        publishedVersion: 'version.version_number'
      },
      'template.created_at DESC'
    );
    const sql = templateDirectorySql(false) + where + ` ORDER BY ${order},template.id`;
    if (paging === undefined) {
      const [rows] = await this.database.raw.query<RowDataPacket[]>(sql, params);
      return { templates: rows.map(adminTemplateSummary) };
    }
    const from = templateDirectorySql(false).slice(
      templateDirectorySql(false).indexOf('FROM conversation_templates')
    );
    const { rows, ...metadata } = await readManagementPage(this.database.raw, paging, {
      countSql: `SELECT COUNT(*) AS total ${from}${where}`,
      rowsSql: sql,
      params
    });
    return { templates: rows.map(adminTemplateSummary), ...metadata };
  }

  async listModelOptions(nodeId: string): Promise<readonly ConversationTemplateModelReference[]> {
    await this.resources.assertCanHostConversationTemplate(nodeId);
    return this.models.listTemplateOptionsForNode(nodeId);
  }

  async detail(templateId: string): Promise<{
    readonly template: AdminConversationTemplateSummary;
    readonly draft: ConversationTemplateDraft;
    readonly versions: readonly ConversationTemplateVersion[];
  }> {
    const row = await this.requireTemplateRow(templateId, true);
    const [versionRows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id,template_id,version_number,status,content_hash,manifest_hash,mcp_config_hash,
              file_count,total_bytes,host_policy_version,published_by_user_id,published_at
       FROM conversation_template_versions WHERE template_id=? ORDER BY version_number DESC`,
      [templateId]
    );
    return {
      template: adminTemplateSummary(row),
      draft: draftFromRow(row),
      versions: versionRows.map(templateVersion)
    };
  }

  async create(
    actorUserId: number,
    raw: unknown,
    inspect: InspectConversationTemplateDraft
  ): Promise<{
    readonly template: ConversationTemplateSummary;
    readonly draft: ConversationTemplateDraft;
  }> {
    const templateId = this.id();
    const createdAt = this.now();
    const candidate = parseDraft(raw, templateId, 1, createdAt, false);
    await this.resources.assertCanUseWorkspace(
      actorUserId,
      candidate.nodeId,
      candidate.workspaceId
    );
    await this.resources.assertCanHostConversationTemplate(candidate.nodeId);
    const draft = await this.normalizeModels(candidate);
    await requireValidInspection(await inspect(draft, 'VALIDATE'), draft);
    try {
      await withMysqlTransaction(this.database.raw, async (connection) => {
        await lockMysqlUsers(connection, [actorUserId]);
        const source = await this.lockSourceNode(connection, draft.nodeId);
        await lockMysqlWorkspace(connection, draft.workspaceId, draft.nodeId);
        await connection.execute(
          `INSERT INTO conversation_templates
         (id,source_node_id,source_workspace_id,name,normalized_name,description,icon,status,
          current_version_id,draft_revision,draft_config,created_by_user_id,updated_by_user_id,
          created_at,updated_at,deleted_at)
         VALUES (?,?,?,?,?,?,?,'ACTIVE',NULL,?,?,?, ?,?,?,NULL)`,
          [
            draft.templateId,
            draft.nodeId,
            draft.workspaceId,
            draft.name,
            normalizeName(draft.name),
            draft.description,
            draft.icon ?? null,
            draft.revision,
            JSON.stringify(draft),
            actorUserId,
            actorUserId,
            createdAt,
            createdAt
          ]
        );
        await this.auditWithConnection(
          connection,
          'conversation_template.created',
          actorUserId,
          { ...draft, ...source },
          { revision: draft.revision }
        );
      });
    } catch (error) {
      if (mysqlErrorCode(error) === 'ER_DUP_ENTRY')
        throw new Error('CONVERSATION_TEMPLATE_NAME_CONFLICT');
      throw error;
    }
    return {
      template: conversationTemplateSummarySchema.parse({
        id: draft.templateId,
        nodeId: draft.nodeId,
        name: draft.name,
        description: draft.description,
        ...(draft.icon === undefined ? {} : { icon: draft.icon }),
        status: 'ACTIVE',
        currentVersionId: null,
        available: false,
        createdAt,
        updatedAt: createdAt
      }),
      draft
    };
  }

  async update(
    actorUserId: number,
    templateId: string,
    raw: unknown,
    inspect: InspectConversationTemplateDraft
  ): Promise<{
    readonly template: ConversationTemplateSummary;
    readonly draft: ConversationTemplateDraft;
  }> {
    const row = await this.requireTemplateRow(templateId);
    const expectedRevision = draftRevision(raw);
    if (Number(row['draft_revision']) !== expectedRevision)
      throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    const updatedAt = this.now();
    const candidate = parseDraft(raw, templateId, expectedRevision + 1, updatedAt, true);
    assertImmutableSource(row, candidate);
    await this.resources.assertCanUseWorkspace(
      actorUserId,
      candidate.nodeId,
      candidate.workspaceId
    );
    await this.resources.assertCanHostConversationTemplate(candidate.nodeId);
    const draft = await this.normalizeModels(candidate);
    await requireValidInspection(await inspect(draft, 'VALIDATE'), draft);
    let result: ResultSetHeader;
    try {
      [result] = await withMysqlTransaction(this.database.raw, async (connection) => {
        await lockMysqlUsers(connection, [actorUserId]);
        const source = await this.lockSourceNode(connection, draft.nodeId);
        await lockMysqlWorkspace(connection, draft.workspaceId, draft.nodeId);
        const result = await connection.execute<ResultSetHeader>(
          `UPDATE conversation_templates
         SET source_node_id=?,source_workspace_id=?,name=?,normalized_name=?,description=?,icon=?,
             draft_revision=?,draft_config=?,updated_by_user_id=?,updated_at=?
         WHERE id=? AND draft_revision=? AND status<>'DELETED'`,
          [
            draft.nodeId,
            draft.workspaceId,
            draft.name,
            normalizeName(draft.name),
            draft.description,
            draft.icon ?? null,
            draft.revision,
            JSON.stringify(draft),
            actorUserId,
            updatedAt,
            templateId,
            expectedRevision
          ]
        );
        if (result[0].affectedRows === 1)
          await this.auditWithConnection(
            connection,
            'conversation_template.updated',
            actorUserId,
            { ...draft, ...source, name: String(row['name']) },
            { revision: draft.revision, before: { name: row['name'] }, after: { name: draft.name } }
          );
        return result;
      });
    } catch (error) {
      if (mysqlErrorCode(error) === 'ER_DUP_ENTRY')
        throw new Error('CONVERSATION_TEMPLATE_NAME_CONFLICT');
      throw error;
    }
    if (result.affectedRows !== 1) throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    return {
      template: conversationTemplateSummarySchema.parse({
        id: templateId,
        nodeId: draft.nodeId,
        name: draft.name,
        description: draft.description,
        ...(draft.icon === undefined ? {} : { icon: draft.icon }),
        status: row['status'],
        currentVersionId:
          row['current_version_id'] === null ? null : String(row['current_version_id']),
        available: row['status'] === 'ACTIVE' && row['current_version_status'] === 'AVAILABLE',
        createdAt: Number(row['created_at']),
        updatedAt
      }),
      draft
    };
  }

  async testDraft(
    actorUserId: number,
    templateId: string,
    raw: unknown,
    inspect: InspectConversationTemplateDraft
  ): Promise<ConversationTemplateSourceInspection> {
    const row = await this.requireTemplateRow(templateId);
    const expectedRevision = draftRevision(raw);
    if (Number(row['draft_revision']) !== expectedRevision)
      throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    const candidate = parseDraft(raw, templateId, expectedRevision + 1, this.now(), true);
    assertImmutableSource(row, candidate);
    await this.resources.assertCanUseWorkspace(
      actorUserId,
      candidate.nodeId,
      candidate.workspaceId
    );
    await this.resources.assertCanHostConversationTemplate(candidate.nodeId);
    const draft = await this.normalizeModels(candidate);
    const result = conversationTemplateSourceInspectionSchema.parse(
      await inspect(draft, 'DRAFT_TEST')
    );
    await this.audit('conversation_template.tested', actorUserId, draft, {
      revision: draft.revision,
      valid: result.valid,
      ...(result.code === null ? {} : { code: result.code })
    });
    return result;
  }

  async publish(
    actorUserId: number,
    templateId: string,
    raw: unknown,
    dispatch: PublishConversationTemplateDraft
  ): Promise<ConversationTemplatePublishJob> {
    const input = conversationTemplatePublishInputSchema.safeParse(raw);
    if (!input.success || input.data.templateId !== templateId)
      throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
    const row = await this.requireTemplateRow(templateId);
    if (Number(row['draft_revision']) !== input.data.draftRevision)
      throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
    const storedDraft = draftFromRow(row);
    await this.resources.assertCanUseWorkspace(
      actorUserId,
      storedDraft.nodeId,
      storedDraft.workspaceId
    );
    await this.resources.assertCanHostConversationTemplate(storedDraft.nodeId);
    const draft = await this.normalizeModels(storedDraft);

    let createdAt: number;
    let requestedByUserId: number;
    let queuedStage: ConversationTemplatePublishJob['stage'] = 'VALIDATING';
    const existing = await this.publishJobRow(input.data.requestId);
    if (existing !== undefined) {
      requireMatchingPublishJob(existing, templateId, input.data.draftRevision);
      const current = publishJob(existing);
      if (current.status !== 'QUEUED') return current;
      createdAt = current.createdAt;
      requestedByUserId = publishRequester(existing);
      queuedStage = current.stage;
    } else {
      createdAt = this.now();
      const [inserted] = await withMysqlTransaction(this.database.raw, async (connection) => {
        await lockMysqlUsers(connection, [actorUserId]);
        const template = await lockMysqlTemplate(connection, templateId);
        if (template['status'] === 'DELETED') throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
        return connection.execute<ResultSetHeader>(
          `INSERT IGNORE INTO conversation_template_publish_jobs
         (id,template_id,source_node_id,source_workspace_id,draft_revision,stage,status,version_id,
          error_code,error_summary,requested_by_user_id,created_at,updated_at)
         VALUES (?,?,?,?,?,'VALIDATING','QUEUED',NULL,NULL,NULL,?,?,?)`,
          [
            input.data.requestId,
            templateId,
            draft.nodeId,
            draft.workspaceId,
            input.data.draftRevision,
            actorUserId,
            createdAt,
            createdAt
          ]
        );
      });
      if (inserted.affectedRows === 1) {
        requestedByUserId = actorUserId;
      } else {
        const raced = await this.publishJobRow(input.data.requestId);
        if (raced === undefined) throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
        requireMatchingPublishJob(raced, templateId, input.data.draftRevision);
        const current = publishJob(raced);
        if (current.status !== 'QUEUED') return current;
        createdAt = current.createdAt;
        requestedByUserId = publishRequester(raced);
        queuedStage = current.stage;
      }
    }

    try {
      const result = conversationTemplatePublishResultSchema.parse(
        await dispatch(draft, input.data.requestId, requestedByUserId)
      );
      if (
        result.job.id !== input.data.requestId ||
        result.job.templateId !== templateId ||
        result.job.draftRevision !== input.data.draftRevision
      )
        throw new Error('CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID');
      return await this.applyPublishResult(
        actorUserId,
        requestedByUserId,
        draft,
        { ...result.job, createdAt },
        result.version
      );
    } catch (error) {
      const code = stableErrorCode(error, 'CONVERSATION_TEMPLATE_PUBLISH_FAILED');
      const failed = conversationTemplatePublishJobSchema.parse({
        id: input.data.requestId,
        templateId,
        draftRevision: input.data.draftRevision,
        stage: queuedStage,
        status: 'FAILED',
        errorCode: code,
        errorSummary: `The publish request failed (${code}).`,
        createdAt,
        updatedAt: this.now()
      });
      return this.applyPublishResult(actorUserId, requestedByUserId, draft, failed, undefined);
    }
  }

  async publishStatus(
    actorUserId: number,
    templateId: string,
    jobId: string,
    refresh: RefreshConversationTemplatePublish
  ): Promise<ConversationTemplatePublishJob> {
    await this.requireTemplateRow(templateId, true);
    const stored = await this.publishJobRow(jobId);
    if (stored === undefined || String(stored['template_id']) !== templateId)
      throw new Error('CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND');
    const current = publishJob(stored);
    if (current.status === 'SUCCEEDED' || current.status === 'FAILED') return current;
    const context = publishContext(stored);
    const result = conversationTemplatePublishResultSchema.parse(
      await refresh(context.nodeId, context.workspaceId, templateId, jobId)
    );
    if (
      result.job.id !== jobId ||
      result.job.templateId !== templateId ||
      result.job.draftRevision !== current.draftRevision
    )
      throw new Error('CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID');
    const requestedByUserId = publishRequester(stored);
    return this.applyPublishResult(
      actorUserId,
      requestedByUserId,
      context,
      { ...result.job, createdAt: current.createdAt },
      result.version
    );
  }

  async disable(actorUserId: number, templateId: string): Promise<void> {
    const row = await this.requireTemplateRow(templateId);
    const versionId =
      row['current_version_id'] === null ? undefined : String(row['current_version_id']);
    if (versionId === undefined) throw new Error('CONVERSATION_TEMPLATE_NOT_PUBLISHED');
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE conversation_template_versions SET status='DISABLED'
         WHERE id=? AND template_id=? AND status='AVAILABLE'`,
        [versionId, templateId]
      );
      if (result.affectedRows !== 1) throw new Error('CONVERSATION_TEMPLATE_NOT_PUBLISHED');
      await connection.execute('UPDATE conversation_templates SET updated_at=? WHERE id=?', [
        this.now(),
        templateId
      ]);
      await this.auditWithConnection(
        connection,
        'conversation_template.disabled',
        actorUserId,
        row,
        { versionId }
      );
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async archive(actorUserId: number, templateId: string): Promise<void> {
    const row = await this.requireTemplateRow(templateId);
    const [result] = await this.database.raw.execute<ResultSetHeader>(
      `UPDATE conversation_templates SET status='ARCHIVED',updated_at=?
       WHERE id=? AND status<>'DELETED'`,
      [this.now(), templateId]
    );
    if (result.affectedRows !== 1) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
    await this.audit('conversation_template.archived', actorUserId, row);
  }

  async remove(actorUserId: number, templateId: string): Promise<void> {
    const row = await this.requireTemplateRow(templateId);
    const now = this.now();
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE conversation_templates
         SET status='DELETED',deleted_at=?,updated_at=? WHERE id=? AND status<>'DELETED'`,
        [now, now, templateId]
      );
      if (result.affectedRows !== 1) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
      await connection.execute(
        `UPDATE conversation_template_publish_jobs
         SET status='FAILED',error_code='CONVERSATION_TEMPLATE_NOT_FOUND',
             error_summary='The conversation template was deleted.',updated_at=?
         WHERE template_id=? AND status IN ('QUEUED','RUNNING')`,
        [now, templateId]
      );
      await this.auditWithConnection(connection, 'conversation_template.deleted', actorUserId, row);
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async applyPublishResult(
    actorUserId: number,
    expectedPublisherUserId: number,
    context: ConversationTemplatePublishContext,
    job: ConversationTemplatePublishJob,
    version: ConversationTemplateVersion | undefined
  ): Promise<ConversationTemplatePublishJob> {
    if (version !== undefined && version.publishedByUserId !== expectedPublisherUserId)
      throw new Error('CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID');
    return withMysqlTransaction(this.database.raw, async (connection) => {
      await lockMysqlUsers(connection, [expectedPublisherUserId]);
      // Take the exclusive parent lock before the job lock; never upgrade a shared lock.
      const [templateRows] = await connection.execute<RowDataPacket[]>(
        `SELECT template.current_version_id,template.draft_revision,template.status,template.name,
                node.owner_type,node.owner_organization_id,node.display_name AS nodeName,
                version.version_number AS current_version_number
         FROM conversation_templates template
         JOIN nodes node ON node.id=template.source_node_id
         LEFT JOIN conversation_template_versions version ON version.id=template.current_version_id
         WHERE template.id=? FOR UPDATE`,
        [context.templateId]
      );
      const template = templateRows[0];
      if (
        template === undefined ||
        template['status'] === 'DELETED' ||
        Number(template['draft_revision']) < context.revision
      )
        throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
      const stored = await this.publishJobRow(job.id, connection, true);
      if (stored === undefined) throw new Error('CONVERSATION_TEMPLATE_PUBLISH_JOB_NOT_FOUND');
      requireMatchingPublishJob(stored, context.templateId, context.revision);
      const current = publishJob(stored);
      if (
        current.status === 'SUCCEEDED' ||
        current.status === 'FAILED' ||
        (current.status === 'RUNNING' && job.status === 'QUEUED')
      )
        return current;
      job = { ...job, createdAt: current.createdAt };
      if (job.status !== 'SUCCEEDED' || version === undefined) {
        await storePublishJobWithConnection(connection, job);
        return job;
      }
      const currentVersionId =
        template['current_version_id'] === null || template['current_version_id'] === undefined
          ? null
          : String(template['current_version_id']);
      const currentVersionNumber =
        template['current_version_number'] === null ||
        template['current_version_number'] === undefined
          ? null
          : Number(template['current_version_number']);
      if (
        (currentVersionId === null) !== (currentVersionNumber === null) ||
        (currentVersionNumber !== null &&
          (!Number.isSafeInteger(currentVersionNumber) || currentVersionNumber <= 0))
      )
        throw new Error('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
      await connection.execute(
        `INSERT INTO conversation_template_versions
         (id,template_id,version_number,draft_revision,status,content_hash,manifest_hash,
          mcp_config_hash,file_count,total_bytes,host_policy_version,published_by_user_id,published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          version.id,
          version.templateId,
          version.version,
          context.revision,
          version.status,
          version.contentHash,
          version.manifestHash,
          version.mcpConfigHash,
          version.fileCount,
          version.totalBytes,
          version.hostPolicyVersion,
          version.publishedByUserId,
          version.publishedAt
        ]
      );
      if (currentVersionNumber === null || version.version > currentVersionNumber) {
        const [templateResult] = await connection.execute<ResultSetHeader>(
          `UPDATE conversation_templates
           SET current_version_id=?,status='ACTIVE',updated_at=?
           WHERE id=? AND draft_revision>=? AND status<>'DELETED'`,
          [version.id, version.publishedAt, context.templateId, context.revision]
        );
        if (templateResult.affectedRows !== 1) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
      }
      await storePublishJobWithConnection(connection, job);
      await this.auditWithConnection(
        connection,
        'conversation_template.published',
        actorUserId,
        {
          ...context,
          name: template['name'],
          owner_type: template['owner_type'],
          owner_organization_id: template['owner_organization_id'],
          nodeName: template['nodeName'],
          workspaceName: template['workspaceName']
        },
        { revision: context.revision, jobId: job.id, versionId: version.id }
      );
      return job;
    });
  }

  private async publishJobRow(
    jobId: string,
    connection: Pick<PoolConnection, 'execute'> = this.database.raw,
    forUpdate = false
  ): Promise<RowDataPacket | undefined> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id,template_id,draft_revision,stage,status,version_id,error_code,error_summary,
              source_node_id,source_workspace_id,requested_by_user_id,created_at,updated_at
       FROM conversation_template_publish_jobs WHERE id=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [jobId]
    );
    return rows[0];
  }

  private async requireTemplateRow(
    templateId: string,
    includeDeleted = false
  ): Promise<RowDataPacket> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `${templateDirectorySql(false)} WHERE template.id=?${includeDeleted ? '' : " AND template.status<>'DELETED'"}`,
      [templateId]
    );
    const row = rows[0];
    if (row === undefined) throw new Error('CONVERSATION_TEMPLATE_NOT_FOUND');
    return row;
  }

  private async lockSourceNode(connection: PoolConnection, nodeId: string): Promise<RowDataPacket> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id,display_name AS nodeName,owner_type,owner_organization_id FROM nodes WHERE id=? FOR SHARE',
      [nodeId]
    );
    if (rows.length !== 1) throw new Error('NODE_NOT_FOUND');
    return rows[0]!;
  }

  private async audit(
    eventType: string,
    actorUserId: number,
    draftOrRow: ConversationTemplateDraft | ConversationTemplatePublishContext | RowDataPacket,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const context = templateAuditContext(draftOrRow);
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType,
          actorUserId,
          targetType: 'TEMPLATE',
          targetId: context.templateId,
          nodeId: context.nodeId,
          workspaceId: context.workspaceId
        },
        { ...draftOrRow },
        metadata
      )
    );
  }

  private async auditWithConnection(
    connection: Pick<PoolConnection, 'execute'>,
    eventType: string,
    actorUserId: number,
    draftOrRow: ConversationTemplateDraft | ConversationTemplatePublishContext | RowDataPacket,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const context = templateAuditContext(draftOrRow);
    emitAuditAfterCommit(
      this.database,
      connection,
      resourceAuditEvent(
        {
          eventType,
          actorUserId,
          targetType: 'TEMPLATE',
          targetId: context.templateId,
          nodeId: context.nodeId,
          workspaceId: context.workspaceId
        },
        { ...draftOrRow },
        metadata
      )
    );
  }

  private async normalizeModels(
    draft: ConversationTemplateDraft
  ): Promise<ConversationTemplateDraft> {
    const available = new Map(
      (await this.models.listTemplateOptionsForNode(draft.nodeId)).map((model) => [
        model.modelId,
        model
      ])
    );
    const allowedModels = draft.allowedModels.map((model) => {
      const authoritative = available.get(model.modelId);
      if (authoritative === undefined) throw new Error('CONVERSATION_TEMPLATE_MODEL_INVALID');
      return authoritative;
    });
    return {
      ...draft,
      allowedModels
    };
  }
}

function templateDirectorySql(activeOnly: boolean): string {
  return `SELECT template.id,template.source_node_id,template.source_workspace_id,template.name,
                 template.description,template.icon,template.status,template.current_version_id,
                 template.draft_revision,template.draft_config,template.created_at,template.updated_at,
                 node.owner_type,node.owner_organization_id,node.display_name AS nodeName,workspace.display_name AS workspaceName,
                 version.version_number AS current_version_number,
                 version.status AS current_version_status
          FROM conversation_templates template
          JOIN nodes node ON node.id=template.source_node_id
         LEFT JOIN workspaces workspace ON workspace.node_id=template.source_node_id AND workspace.workspace_id=template.source_workspace_id
          LEFT JOIN conversation_template_versions version ON version.id=template.current_version_id${
            activeOnly ? " WHERE template.status='ACTIVE' AND version.status='AVAILABLE'" : ''
          }`;
}

function parseDraft(
  raw: unknown,
  templateId: string,
  revision: number,
  updatedAt: number,
  updating: boolean
): ConversationTemplateDraft {
  if (!record(raw)) throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
  const keys = updating ? UPDATE_DRAFT_KEYS : CREATE_DRAFT_KEYS;
  if (Object.keys(raw).some((key) => !keys.has(key)))
    throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
  const candidate = { ...raw };
  delete candidate['draftRevision'];
  const parsed = conversationTemplateDraftSchema.safeParse({
    ...candidate,
    templateId,
    revision,
    updatedAt
  });
  if (!parsed.success) throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
  return parsed.data;
}

function draftRevision(raw: unknown): number {
  if (!record(raw)) throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
  const revision = raw['draftRevision'];
  if (!Number.isSafeInteger(revision) || Number(revision) <= 0)
    throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
  return Number(revision);
}

async function requireValidInspection(
  raw: unknown,
  draft: ConversationTemplateDraft
): Promise<void> {
  const inspection = conversationTemplateSourceInspectionSchema.parse(raw);
  if (!inspection.valid) throw new Error(inspection.code ?? 'CONVERSATION_TEMPLATE_INPUT_INVALID');
  const availableMcpIds = new Set(inspection.mcpServers.map((server) => server.id));
  if (draft.mcpIds.some((mcpId) => !availableMcpIds.has(mcpId)))
    throw new Error('CONVERSATION_TEMPLATE_MCP_INVALID');
}

function templateSummary(row: RowDataPacket): ConversationTemplateSummary {
  const status = row['status'];
  return conversationTemplateSummarySchema.parse({
    id: String(row['id']),
    nodeId: String(row['source_node_id']),
    name: String(row['name']),
    description: String(row['description']),
    ...(row['icon'] === null || row['icon'] === undefined ? {} : { icon: String(row['icon']) }),
    status,
    currentVersionId:
      row['current_version_id'] === null || row['current_version_id'] === undefined
        ? null
        : String(row['current_version_id']),
    available: status === 'ACTIVE' && row['current_version_status'] === 'AVAILABLE',
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  });
}

function adminTemplateSummary(row: RowDataPacket): AdminConversationTemplateSummary {
  const summary = templateSummary(row);
  const publishedVersion =
    row['current_version_number'] === null || row['current_version_number'] === undefined
      ? null
      : Number(row['current_version_number']);
  if (
    (summary.currentVersionId === null) !== (publishedVersion === null) ||
    (publishedVersion !== null &&
      (!Number.isSafeInteger(publishedVersion) || publishedVersion <= 0))
  )
    throw new Error('CONVERSATION_TEMPLATE_RESPONSE_INVALID');
  return {
    ...summary,
    draftRevision: Number(row['draft_revision']),
    publishedVersion
  };
}

function draftFromRow(row: RowDataPacket): ConversationTemplateDraft {
  const value = jsonValue(row['draft_config']);
  return conversationTemplateDraftSchema.parse(value);
}

function assertImmutableSource(row: RowDataPacket, draft: ConversationTemplateDraft): void {
  if (
    draft.nodeId !== String(row['source_node_id']) ||
    draft.workspaceId !== String(row['source_workspace_id'])
  )
    throw new Error('CONVERSATION_TEMPLATE_SOURCE_IMMUTABLE');
}

function templateVersion(row: RowDataPacket): ConversationTemplateVersion {
  return conversationTemplateVersionSchema.parse({
    id: String(row['id']),
    templateId: String(row['template_id']),
    version: Number(row['version_number']),
    status: row['status'],
    contentHash: String(row['content_hash']),
    manifestHash: String(row['manifest_hash']),
    mcpConfigHash: String(row['mcp_config_hash']),
    fileCount: Number(row['file_count']),
    totalBytes: Number(row['total_bytes']),
    hostPolicyVersion: Number(row['host_policy_version']),
    publishedByUserId: Number(row['published_by_user_id']),
    publishedAt: Number(row['published_at'])
  });
}

function requireMatchingPublishJob(
  row: RowDataPacket,
  templateId: string,
  draftRevision: number
): void {
  if (String(row['template_id']) !== templateId || Number(row['draft_revision']) !== draftRevision)
    throw new Error('CONVERSATION_TEMPLATE_REVISION_CONFLICT');
}

function publishRequester(row: RowDataPacket): number {
  const requestedByUserId = Number(row['requested_by_user_id']);
  if (!Number.isSafeInteger(requestedByUserId) || requestedByUserId <= 0)
    throw new Error('CONVERSATION_TEMPLATE_PUBLISH_RESULT_INVALID');
  return requestedByUserId;
}

function publishContext(row: RowDataPacket): ConversationTemplatePublishContext {
  return {
    templateId: String(row['template_id']),
    nodeId: String(row['source_node_id']),
    workspaceId: String(row['source_workspace_id']),
    revision: Number(row['draft_revision'])
  };
}

function publishJob(row: RowDataPacket): ConversationTemplatePublishJob {
  return conversationTemplatePublishJobSchema.parse({
    id: String(row['id']),
    templateId: String(row['template_id']),
    draftRevision: Number(row['draft_revision']),
    stage: row['stage'],
    status: row['status'],
    ...(row['version_id'] === null || row['version_id'] === undefined
      ? {}
      : { versionId: String(row['version_id']) }),
    errorCode:
      row['error_code'] === null || row['error_code'] === undefined
        ? null
        : String(row['error_code']),
    ...(row['error_summary'] === null || row['error_summary'] === undefined
      ? {}
      : { errorSummary: String(row['error_summary']) }),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  });
}

async function storePublishJobWithConnection(
  connection: Pick<PoolConnection, 'execute'>,
  job: ConversationTemplatePublishJob
): Promise<void> {
  if (job.versionId !== undefined)
    await lockMysqlTemplateVersion(connection, job.versionId, job.templateId);
  await connection.execute(
    `UPDATE conversation_template_publish_jobs
     SET stage=?,status=?,version_id=?,error_code=?,error_summary=?,updated_at=? WHERE id=?`,
    [
      job.stage,
      job.status,
      job.versionId ?? null,
      job.errorCode,
      job.errorSummary ?? null,
      job.updatedAt,
      job.id
    ]
  );
}

function templateAuditContext(
  draftOrRow: ConversationTemplateDraft | ConversationTemplatePublishContext | RowDataPacket
): {
  readonly templateId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
} {
  if ('templateId' in draftOrRow)
    return {
      templateId: draftOrRow.templateId,
      nodeId: draftOrRow.nodeId,
      workspaceId: draftOrRow.workspaceId
    };
  return {
    templateId: String(draftOrRow['id']),
    nodeId: String(draftOrRow['source_node_id']),
    workspaceId: String(draftOrRow['source_workspace_id'])
  };
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function stableErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)
    ? error.message
    : fallback;
}

function mysqlErrorCode(error: unknown): string | undefined {
  return record(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
