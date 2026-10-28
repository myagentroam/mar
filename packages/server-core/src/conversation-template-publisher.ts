import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  conversationTemplatePublishInputSchema,
  conversationTemplatePublishJobSchema,
  conversationTemplatePublishResultSchema,
  type ConversationTemplateDraft,
  type ConversationTemplatePublishJob,
  type ConversationTemplateVersion
} from '@myagentroam/protocol';
import { emitAuditAfterCommit, resourceAuditEvent } from './audit.js';
import {
  withMysqlTransaction,
  lockMysqlUsers,
  lockMysqlTemplate,
  lockMysqlTemplateVersion
} from './mysql-reference-store.js';
import type { TemplateStore, TemplateResourcePolicy } from './hosted-contracts.js';

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
interface ConversationTemplatePublishContext {
  readonly templateId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly revision: number;
}
export class ConversationTemplatePublisher {
  constructor(
    private readonly database: TemplateStore,
    private readonly resources: Pick<TemplateResourcePolicy, 'assertCanManageConversationTemplate'>,
    private readonly prepareDraft: (
      actorUserId: number,
      templateId: string,
      revision: number
    ) => Promise<ConversationTemplateDraft>,
    private readonly assertTemplateExists: (templateId: string) => Promise<void>,
    private readonly now: () => number
  ) {}

  async publish(
    actorUserId: number,
    templateId: string,
    raw: unknown,
    dispatch: PublishConversationTemplateDraft
  ): Promise<ConversationTemplatePublishJob> {
    const input = conversationTemplatePublishInputSchema.safeParse(raw);
    if (!input.success || input.data.templateId !== templateId)
      throw new Error('CONVERSATION_TEMPLATE_INPUT_INVALID');
    const draft = await this.prepareDraft(actorUserId, templateId, input.data.draftRevision);

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
        await this.resources.assertCanManageConversationTemplate(
          actorUserId,
          draft.nodeId,
          draft.workspaceId,
          connection
        );
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
    await this.assertTemplateExists(templateId);
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
      await this.auditPublished(
        connection,
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

  private async auditPublished(
    connection: Pick<PoolConnection, 'execute'>,
    actorUserId: number,
    snapshot: ConversationTemplatePublishContext & Record<string, unknown>,
    metadata: Record<string, unknown>
  ): Promise<void> {
    emitAuditAfterCommit(
      this.database,
      connection,
      resourceAuditEvent(
        {
          eventType: 'conversation_template.published',
          actorUserId,
          targetType: 'TEMPLATE',
          targetId: snapshot.templateId,
          nodeId: snapshot.nodeId,
          workspaceId: snapshot.workspaceId
        },
        { ...snapshot },
        metadata
      )
    );
  }
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

function stableErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)
    ? error.message
    : fallback;
}
