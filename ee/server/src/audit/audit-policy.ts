import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { AuditEvent } from '@myagentroam/server-core/audit';

const securityEvents = new Set([
  'admin_initialized',
  'login_failed',
  'login_rate_limited',
  'login_succeeded',
  'logout',
  'login_session_lru_evicted',
  'user_session_revoked',
  'password_changed',
  'password_reset',
  'password_reset_by_admin',
  'node_registration_token_created',
  'node_registered',
  'node_revoked',
  'node_deleted',
  'workspace.registered',
  'workspace.unregistered',
  'oauth_login_failed',
  'oauth_login_succeeded',
  'oauth_identity_linked',
  'oauth_identity_unlinked',
  'oauth_identity_bound',
  'oauth_identity_unbound',
  'user_password_reset'
]);
const systemPrefixes = ['license_', 'system_setting', 'oauth_provider', 'mail_', 'smtp_'];
const systemEvents = new Set(['mail.test.executed']);
export function auditsPersonalServerEvent(eventType: string): boolean {
  return (
    securityEvents.has(eventType) ||
    systemEvents.has(eventType) ||
    systemPrefixes.some((prefix) => eventType.startsWith(prefix))
  );
}
const resourceTables: Readonly<Record<string, readonly [string, string, string, string]>> = {
  NODE: ['nodes', 'id', 'display_name', 'owner_type'],
  WORKSPACE: ['workspaces', 'workspace_id', 'display_name', 'owner_type'],
  MODEL: ['mar_agent_models', 'id', 'name', 'owner_type'],
  IMAGE_MODEL: ['mar_agent_image_models', 'id', 'name', 'owner_type'],
  SKILL_SOURCE: ['skill_sources', 'id', 'name', 'scope'],
  SKILL: ['skill_favorites', 'id', 'display_name', 'scope'],
  MCP_SOURCE: ['mcp_sources', 'id', 'name', 'scope'],
  MCP: ['mcp_catalog_entries', 'id', 'display_name', 'scope']
};

/** Product-owned scope resolution; no request path or actor-organization fallback. */
export async function scopedAuditEvent(
  pool: Pool,
  input: AuditEvent
): Promise<AuditEvent | undefined> {
  if (
    input.eventType.startsWith('conversation.hosted.') ||
    input.eventType === 'conversation_template.tested' ||
    input.eventType === 'operation' ||
    input.eventType === 'conversation_hosting_storage_inspected' ||
    input.eventType === 'conversation_hosting_cleanup_previewed' ||
    input.eventType.startsWith('relay_')
  )
    return;
  let metadata: Record<string, unknown>;
  try {
    if ((input.metadata?.length ?? 0) > 64 * 1024) throw new Error('AUDIT_METADATA_INVALID');
    const parsed: unknown = JSON.parse(input.metadata ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('AUDIT_METADATA_INVALID');
    metadata = parsed as Record<string, unknown>;
  } catch {
    console.warn('AUDIT_METADATA_INVALID');
    return;
  }
  const lifecycle = securityEvents.has(input.eventType);
  const system =
    lifecycle ||
    systemEvents.has(input.eventType) ||
    systemPrefixes.some((prefix) => input.eventType.startsWith(prefix));
  let event = input;
  let ownerType = metadata['ownerType'] ?? metadata['scope'];
  if (!system && ownerType === 'PERSONAL') return;
  if (input.targetType === 'ORGANIZATION') ownerType = 'ORGANIZATION';
  if (input.organizationId !== undefined) ownerType = 'ORGANIZATION';
  const scopeType =
    input.targetType === 'SESSION' ||
    input.targetType === 'RUN' ||
    input.targetType === 'TERMINAL' ||
    input.targetType === 'FILE'
      ? input.workspaceId
        ? 'WORKSPACE'
        : 'NODE'
      : (input.targetType ?? (input.workspaceId ? 'WORKSPACE' : 'NODE'));
  const spec = resourceTables[scopeType];
  const targetId =
    scopeType === 'WORKSPACE'
      ? (input.workspaceId ?? input.targetId)
      : scopeType === 'NODE'
        ? (input.nodeId ?? input.targetId)
        : input.targetId;
  if (input.targetType === 'TEMPLATE' && input.targetId && ownerType === undefined) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT template.name AS target_name,node.owner_type,node.owner_organization_id
       FROM conversation_templates template JOIN nodes node ON node.id=template.source_node_id
       WHERE template.id=?`,
      [input.targetId]
    );
    const row = rows[0];
    if (row) {
      ownerType = row['owner_type'];
      event = {
        ...event,
        ...(row['owner_organization_id'] == null
          ? {}
          : { organizationId: Number(row['owner_organization_id']) }),
        targetName: input.targetName ?? String(row['target_name'] ?? input.targetId)
      };
    }
  }
  if (input.targetType === 'USER' && input.targetId && event.organizationId === undefined) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT username,organization_id FROM users WHERE id=?',
      [input.targetId]
    );
    const row = rows[0];
    if (row)
      event = {
        ...event,
        organizationId: Number(row['organization_id']),
        targetName: input.targetName ?? String(row['username'])
      };
  }
  if (spec && targetId && ownerType === undefined) {
    const [table, id, name, ownershipColumn] = spec;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${name} AS target_name,${ownershipColumn} AS owner_type,owner_organization_id FROM ${table} WHERE ${id}=?${scopeType === 'WORKSPACE' && input.nodeId ? ' AND node_id=?' : ''}`,
      [targetId, ...(scopeType === 'WORKSPACE' && input.nodeId ? [input.nodeId] : [])]
    );
    const row = rows[0];
    if (row) {
      if (ownerType === undefined) ownerType = row['owner_type'];
      event = {
        ...event,
        ...(event.organizationId !== undefined || row['owner_organization_id'] == null
          ? {}
          : { organizationId: Number(row['owner_organization_id']) }),
        ...(input.targetType === scopeType
          ? { targetName: input.targetName ?? String(row['target_name'] ?? targetId) }
          : {})
      };
      if (
        scopeType === 'WORKSPACE' &&
        typeof row['target_name'] === 'string' &&
        metadata['workspaceName'] === undefined
      )
        metadata['workspaceName'] = row['target_name'];
      if (
        scopeType === 'NODE' &&
        typeof row['target_name'] === 'string' &&
        metadata['nodeName'] === undefined
      )
        metadata['nodeName'] = row['target_name'];
    }
  }
  if (
    input.targetType === 'ENVIRONMENT_SECRET' &&
    (ownerType === 'NODE' || ownerType === 'WORKSPACE')
  ) {
    const workspace = ownerType === 'WORKSPACE';
    const id = workspace ? metadata['workspaceId'] : metadata['nodeId'];
    if (typeof id !== 'string') return;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT owner_type,owner_organization_id FROM ${workspace ? 'workspaces' : 'nodes'} WHERE ${workspace ? 'workspace_id' : 'id'}=?`,
      [id]
    );
    ownerType = rows[0]?.['owner_type'];
    if (rows[0]?.['owner_organization_id'] != null)
      event = { ...event, organizationId: Number(rows[0]['owner_organization_id']) };
  }
  if (
    !system &&
    ownerType !== 'ORGANIZATION' &&
    ownerType !== 'ENTERPRISE' &&
    ownerType !== 'SYSTEM'
  )
    return;
  const targetName =
    event.targetName ??
    (event.targetType === 'SESSION' && typeof metadata['sessionName'] === 'string'
      ? metadata['sessionName']
      : typeof metadata['name'] === 'string'
        ? metadata['name']
        : undefined);
  event = { ...event, ...(targetName === undefined ? {} : { targetName }) };
  event = await completeAuditNames(pool, event, metadata);
  return {
    ...event,
    ...(event.targetName === undefined && event.targetId !== undefined
      ? { targetName: event.targetId }
      : {}),
    metadata: JSON.stringify({
      ...metadata,
      category: system
        ? 'SECURITY'
        : ownerType === 'ENTERPRISE' || ownerType === 'SYSTEM'
          ? 'SYSTEM'
          : 'ORGANIZATION'
    })
  };
}

/** Missing friendly associations are best effort; saved snapshots always win. */
async function completeAuditNames(
  pool: Pool,
  event: AuditEvent,
  metadata: Record<string, unknown>
): Promise<AuditEvent> {
  const ownKey = (
    {
      NODE: 'nodeName',
      WORKSPACE: 'workspaceName',
      SESSION: 'sessionName',
      ORGANIZATION: 'organizationName'
    } as Readonly<Record<string, string>>
  )[event.targetType ?? ''];
  if (
    ownKey &&
    metadata[ownKey] === undefined &&
    event.targetName !== undefined &&
    event.targetName !== event.targetId
  )
    metadata[ownKey] = event.targetName;
  const nodeId =
    event.nodeId ??
    (typeof metadata['nodeId'] === 'string'
      ? metadata['nodeId']
      : event.targetType === 'NODE'
        ? event.targetId
        : undefined);
  const workspaceId =
    event.workspaceId ??
    (typeof metadata['workspaceId'] === 'string'
      ? metadata['workspaceId']
      : event.targetType === 'WORKSPACE'
        ? event.targetId
        : undefined);
  try {
    if (event.targetName === undefined && event.targetId !== undefined) {
      const spec = resourceTables[event.targetType ?? ''];
      const nameSpec = spec
        ? [spec[0], spec[1], spec[2]]
        : event.targetType === 'TEMPLATE'
          ? ['conversation_templates', 'id', 'name']
          : event.targetType === 'USER'
            ? ['users', 'id', 'username']
            : undefined;
      if (nameSpec) {
        const [table, id, name] = nameSpec;
        const [rows] = await pool.execute<RowDataPacket[]>(
          `SELECT ${name} AS target_name FROM ${table} WHERE ${id}=?`,
          [event.targetId]
        );
        if (typeof rows[0]?.['target_name'] === 'string') {
          event = { ...event, targetName: rows[0]['target_name'] };
          if (ownKey && metadata[ownKey] === undefined) metadata[ownKey] = event.targetName;
        }
      }
    }
    if (workspaceId && metadata['workspaceName'] === undefined) {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT display_name FROM workspaces WHERE workspace_id=?${nodeId ? ' AND node_id=?' : ''}`,
        [workspaceId, ...(nodeId ? [nodeId] : [])]
      );
      if (typeof rows[0]?.['display_name'] === 'string')
        metadata['workspaceName'] = rows[0]['display_name'];
    }
    if (nodeId && metadata['nodeName'] === undefined) {
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT display_name FROM nodes WHERE id=?',
        [nodeId]
      );
      if (typeof rows[0]?.['display_name'] === 'string')
        metadata['nodeName'] = rows[0]['display_name'];
    }
    for (const [id, key] of [
      [event.organizationId, 'organizationName'],
      [metadata['targetOrganizationId'], 'targetOrganizationName']
    ] as const) {
      if ((typeof id !== 'string' && typeof id !== 'number') || metadata[key] !== undefined)
        continue;
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT name FROM organizations WHERE id=?',
        [id]
      );
      if (typeof rows[0]?.['name'] === 'string') metadata[key] = rows[0]['name'];
    }
    const targetUserId = metadata['targetUserId'];
    if (
      (typeof targetUserId === 'string' || typeof targetUserId === 'number') &&
      metadata['targetUserName'] === undefined
    ) {
      const [rows] = await pool.execute<RowDataPacket[]>('SELECT username FROM users WHERE id=?', [
        targetUserId
      ]);
      if (typeof rows[0]?.['username'] === 'string')
        metadata['targetUserName'] = rows[0]['username'];
    }
  } catch {
    console.warn('AUDIT_NAME_SNAPSHOT_FAILED');
  }
  return event;
}
