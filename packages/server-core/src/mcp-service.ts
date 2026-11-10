import type { CatalogListRows } from './catalog-policy.js';
import { ManagementQueryError } from './management-pagination.js';
import { emitAudit, resourceAuditEvent } from './audit.js';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import {
  mcpCatalogEntrySchema,
  mcpRuntimeDescriptorSchema,
  mcpSourceInputSchema,
  type McpCatalogEntry,
  type McpRuntimeDescriptor,
  type McpSourceInput
} from '@myagentroam/protocol';
import type {
  CatalogScopeContext as AuthorizationContext,
  CatalogAuthorization,
  CatalogDatabase
} from './catalog-policy.js';

const OFFICIAL_SOURCE_ID = 'official-mcp-registry';
const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io';

export interface McpSourceSummary extends McpSourceInput {
  readonly id: string;
  readonly ownerUserId?: number;
  readonly builtIn: boolean;
  readonly status: 'READY' | 'DEGRADED' | 'DISABLED';
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly manageable: boolean;
}

export interface McpCandidate {
  readonly id: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly runtime: McpRuntimeDescriptor;
}
export type McpCatalogSummary = McpCatalogEntry & { readonly manageable: boolean };
export interface McpCatalogUpdate {
  readonly updateAvailable: boolean;
  readonly latestVersion: string;
}

export abstract class McpService {
  protected abstract sourceRows(actorUserId: number): Promise<RowDataPacket[]>;
  protected abstract catalogRows(actorUserId: number): Promise<RowDataPacket[]>;
  constructor(
    protected readonly database: CatalogDatabase,
    private readonly authorization: CatalogAuthorization,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async ensureOfficialSource(): Promise<void> {
    const timestamp = this.now();
    await this.database.raw.execute(
      `INSERT INTO mcp_sources
       (id,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,status,
        last_error_code,created_by_user_id,created_at,updated_at,owner_key)
       SELECT ?, 'ENTERPRISE',NULL,NULL,'Official MCP Registry',?,TRUE,TRUE,'READY',NULL,id,?,?,
              'ENTERPRISE::'
       FROM users WHERE username='admin' LIMIT 1
       ON DUPLICATE KEY UPDATE built_in=TRUE,name='Official MCP Registry'`,
      [OFFICIAL_SOURCE_ID, OFFICIAL_REGISTRY, timestamp, timestamp]
    );
  }

  async listSources(actorUserId: number): Promise<readonly McpSourceSummary[]> {
    const rows = await this.sourceRows(actorUserId);
    return Promise.all(
      rows.map(async (row) => {
        const source = sourceSummary(row);
        const result = await this.authorization.authorize(
          actorUserId,
          'SKILL_SOURCE_MANAGE',
          scopeContext(
            source.scope,
            source.ownerUserId ?? actorUserId,
            source.organizationId,
            source.builtIn
          )
        );
        return { ...source, manageable: result.allowed };
      })
    );
  }

  async createSource(actorUserId: number, raw: unknown): Promise<McpSourceSummary> {
    const input = mcpSourceInputSchema.parse(raw);
    await this.assertManage(actorUserId, input.scope, input.organizationId);
    const id = randomUUID();
    const timestamp = this.now();
    const ownerUserId = input.scope === 'PERSONAL' ? actorUserId : null;
    const organizationId = input.scope === 'ORGANIZATION' ? input.organizationId! : null;
    const enabled = input.enabled ?? true;
    await this.database.raw.execute(
      `INSERT INTO mcp_sources
       (id,scope,owner_organization_id,owner_user_id,name,locator,enabled,built_in,status,
        last_error_code,created_by_user_id,created_at,updated_at,owner_key)
       VALUES (?,?,?,?,?,?,?,FALSE,?,NULL,?,?,?,?)`,
      [
        id,
        input.scope,
        organizationId,
        ownerUserId,
        input.name,
        input.locator.replace(/\/$/u, ''),
        enabled,
        enabled ? 'READY' : 'DISABLED',
        actorUserId,
        timestamp,
        timestamp,
        ownerKey(input.scope, organizationId, ownerUserId)
      ]
    );
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.source.created',
          actorUserId: actorUserId,
          targetType: 'MCP_SOURCE',
          targetId: id
        },
        { ...input, organizationId },
        {}
      )
    );
    return {
      ...input,
      id,
      ...(ownerUserId === null ? {} : { ownerUserId }),
      enabled,
      builtIn: false,
      status: enabled ? 'READY' : 'DISABLED',
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      manageable: true
    };
  }

  async setSourceEnabled(actorUserId: number, sourceId: string, enabled: boolean): Promise<void> {
    const row = await this.sourceRow(sourceId);
    await this.assertManageRow(actorUserId, row);
    await this.database.raw.execute(
      'UPDATE mcp_sources SET enabled=?,status=?,last_error_code=NULL,updated_at=? WHERE id=?',
      [enabled, enabled ? 'READY' : 'DISABLED', this.now(), sourceId]
    );
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.source.updated',
          actorUserId: actorUserId,
          targetType: 'MCP_SOURCE',
          targetId: sourceId
        },
        row,
        { after: { enabled }, before: { enabled: row['enabled'] } }
      )
    );
  }

  async removeSource(actorUserId: number, sourceId: string): Promise<void> {
    const row = await this.sourceRow(sourceId);
    if (row['built_in']) throw new Error('MCP_SOURCE_BUILT_IN');
    await this.assertManageRow(actorUserId, row);
    const [entries] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT id FROM mcp_catalog_entries WHERE source_id=? LIMIT 1',
      [sourceId]
    );
    if (entries.length > 0) throw new Error('MCP_SOURCE_IN_USE');
    await this.database.raw.execute('DELETE FROM mcp_sources WHERE id=?', [sourceId]);
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.source.deleted',
          actorUserId: actorUserId,
          targetType: 'MCP_SOURCE',
          targetId: sourceId
        },
        row,
        {}
      )
    );
  }

  async discover(
    actorUserId: number,
    sourceId: string,
    query: string
  ): Promise<readonly McpCandidate[]> {
    if (query.length > 200) throw new Error('MCP_SOURCE_QUERY_INVALID');
    const source = (await this.listSources(actorUserId)).find((item) => item.id === sourceId);
    if (source === undefined) throw new Error('MCP_SOURCE_NOT_FOUND');
    if (!source.enabled) throw new Error('MCP_SOURCE_DISABLED');
    const params = new URLSearchParams({ version: 'latest' });
    if (query.trim() !== '') params.set('search', query.trim());
    const response = await this.fetchImpl(
      `${source.locator.replace(/\/$/u, '')}/v0.1/servers?${params}`,
      {
        headers: { accept: 'application/json', 'user-agent': 'MyAgentRoam' },
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) throw new Error('MCP_SOURCE_UNAVAILABLE');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload['servers']))
      throw new Error('MCP_SOURCE_RESPONSE_INVALID');
    return payload['servers']
      .map(registryCandidate)
      .filter((candidate): candidate is McpCandidate => candidate !== undefined)
      .slice(0, 50);
  }

  async listCatalog(actorUserId: number): Promise<readonly McpCatalogSummary[]> {
    return this.summarizeRows(actorUserId, await this.catalogRows(actorUserId));
  }

  protected async queryRows(
    actorUserId: number,
    query: Record<string, unknown>
  ): Promise<CatalogListRows> {
    if (Object.keys(query).length) throw new ManagementQueryError();
    return { rows: await this.catalogRows(actorUserId) };
  }

  async listQuery(actorUserId: number, query: Record<string, unknown>) {
    const { rows, metadata, facets } = await this.queryRows(actorUserId, query);
    return {
      entries: await this.summarizeRows(actorUserId, rows),
      ...metadata,
      ...(facets === undefined ? {} : { facets })
    };
  }

  private async summarizeRows(
    actorUserId: number,
    rows: RowDataPacket[]
  ): Promise<readonly McpCatalogSummary[]> {
    return Promise.all(
      rows.map(async (row) => {
        const entry = catalogEntry(row);
        const authorization = await this.authorization.authorize(
          actorUserId,
          'SKILL_SOURCE_MANAGE',
          scopeContext(entry.scope, entry.ownerUserId ?? actorUserId, entry.ownerOrganizationId)
        );
        return { ...entry, manageable: authorization.allowed };
      })
    );
  }

  async getVisibleCatalog(actorUserId: number, entryId: string): Promise<McpCatalogEntry> {
    const entry = (
      await this.listQuery(actorUserId, { ids: JSON.stringify([entryId]) })
    ).entries.find((item) => item.id === entryId);
    if (entry === undefined) throw new Error('MCP_CATALOG_NOT_FOUND');
    const { manageable, ...catalog } = entry;
    void manageable;
    return catalog;
  }

  async checkCatalogUpdate(actorUserId: number, entryId: string): Promise<McpCatalogUpdate> {
    const entry = await this.requireManageableCatalog(actorUserId, entryId);
    const latest = (await this.discover(actorUserId, entry.sourceId, entry.serverName)).find(
      (candidate) => candidate.serverName === entry.serverName
    );
    if (latest === undefined) throw new Error('MCP_CATALOG_CANDIDATE_STALE');
    return { updateAvailable: latest.version !== entry.version, latestVersion: latest.version };
  }

  async updateCatalogPresentation(
    actorUserId: number,
    entryId: string,
    raw: unknown
  ): Promise<void> {
    if (!isRecord(raw) || typeof raw['featured'] !== 'boolean' || !Array.isArray(raw['tags']))
      throw new Error('MCP_CATALOG_INPUT_INVALID');
    const tags = raw['tags'].map(String);
    if (
      tags.length > 10 ||
      tags.some((tag) => tag.trim().length === 0 || tag.trim().length > 32) ||
      new Set(tags.map((tag) => tag.trim().toLocaleLowerCase())).size !== tags.length
    )
      throw new Error('MCP_CATALOG_INPUT_INVALID');
    const entry = await this.requireManageableCatalog(actorUserId, entryId);
    await this.database.raw.execute(
      'UPDATE mcp_catalog_entries SET featured=?,tags=?,updated_at=? WHERE id=?',
      [raw['featured'], JSON.stringify(tags.map((tag) => tag.trim())), this.now(), entryId]
    );
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.catalog.updated',
          actorUserId: actorUserId,
          targetType: 'MCP',
          targetId: entryId
        },
        { ...entry },
        {}
      )
    );
  }

  async upgradeCatalog(actorUserId: number, entryId: string): Promise<McpCatalogEntry> {
    const entry = await this.requireManageableCatalog(actorUserId, entryId);
    const latest = (await this.discover(actorUserId, entry.sourceId, entry.serverName)).find(
      (candidate) => candidate.serverName === entry.serverName
    );
    if (latest === undefined) throw new Error('MCP_CATALOG_CANDIDATE_STALE');
    const timestamp = this.now();
    await this.database.raw.execute(
      `UPDATE mcp_catalog_entries
       SET display_name=?,description=?,version=?,runtime=?,updated_at=? WHERE id=?`,
      [
        latest.displayName,
        latest.description,
        latest.version,
        JSON.stringify(latest.runtime),
        timestamp,
        entryId
      ]
    );
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.catalog.upgraded',
          actorUserId: actorUserId,
          targetType: 'MCP',
          targetId: entryId
        },
        { ...entry },
        { before: { version: entry.version }, after: { version: latest.version } }
      )
    );
    return { ...entry, ...latest, id: entry.id, updatedAt: timestamp };
  }

  async addCatalog(actorUserId: number, raw: unknown): Promise<McpCatalogEntry> {
    if (!isRecord(raw)) throw new Error('MCP_CATALOG_INPUT_INVALID');
    const sourceId = String(raw['sourceId'] ?? '');
    const requestedCandidate = raw['candidate'];
    if (
      !isRecord(requestedCandidate) ||
      typeof requestedCandidate['serverName'] !== 'string' ||
      typeof requestedCandidate['version'] !== 'string' ||
      requestedCandidate['version'] === 'latest'
    )
      throw new Error('MCP_CATALOG_INPUT_INVALID');
    const source = (await this.listSources(actorUserId)).find((item) => item.id === sourceId);
    if (source === undefined || !source.enabled) throw new Error('MCP_SOURCE_NOT_FOUND');
    const candidate = (
      await this.discover(actorUserId, sourceId, requestedCandidate['serverName'])
    ).find(
      (item) =>
        item.serverName === requestedCandidate['serverName'] &&
        item.version === requestedCandidate['version']
    );
    if (candidate === undefined) throw new Error('MCP_CATALOG_CANDIDATE_STALE');
    const scope = raw['scope'];
    if (scope !== 'ORGANIZATION' && scope !== 'PERSONAL')
      throw new Error('MCP_CATALOG_INPUT_INVALID');
    const organizationId = scope === 'ORGANIZATION' ? Number(raw['organizationId']) : undefined;
    await this.assertManage(actorUserId, scope, organizationId);
    const ownerUserId = scope === 'PERSONAL' ? actorUserId : null;
    const [duplicates] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT id FROM mcp_catalog_entries
       WHERE scope=? AND owner_organization_id <=> ? AND owner_user_id <=> ? AND server_name=?
       LIMIT 1`,
      [scope, organizationId ?? null, ownerUserId, candidate.serverName]
    );
    if (duplicates.length > 0) throw new Error('MCP_CATALOG_ALREADY_EXISTS');
    const id = randomUUID();
    const timestamp = this.now();
    const tags = Array.isArray(raw['tags']) ? raw['tags'].map(String).slice(0, 10) : [];
    const featured = Boolean(raw['featured']);
    const entry = mcpCatalogEntrySchema.parse({
      id,
      sourceId,
      scope,
      ...(organizationId === undefined ? {} : { ownerOrganizationId: organizationId }),
      ...(ownerUserId === null ? {} : { ownerUserId }),
      serverName: candidate.serverName,
      displayName: candidate.displayName,
      description: candidate.description,
      version: candidate.version,
      runtime: candidate.runtime,
      featured,
      tags,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    try {
      await this.database.raw.execute(
        `INSERT INTO mcp_catalog_entries
         (id,source_id,scope,owner_organization_id,owner_user_id,server_name,display_name,
          description,version,featured,tags,runtime,created_by_user_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          sourceId,
          scope,
          organizationId ?? null,
          ownerUserId,
          entry.serverName,
          entry.displayName,
          entry.description,
          entry.version,
          featured,
          JSON.stringify(tags),
          JSON.stringify(entry.runtime),
          actorUserId,
          timestamp,
          timestamp
        ]
      );
    } catch (error) {
      if (isMysqlDuplicate(error)) throw new Error('MCP_CATALOG_ALREADY_EXISTS');
      throw error;
    }
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.catalog.created',
          actorUserId: actorUserId,
          targetType: 'MCP',
          targetId: id
        },
        { ...entry },
        {}
      )
    );
    return entry;
  }

  async removeCatalog(actorUserId: number, entryId: string): Promise<void> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT display_name,scope,owner_organization_id,owner_user_id FROM mcp_catalog_entries WHERE id=?',
      [entryId]
    );
    const row = rows[0];
    if (row === undefined) throw new Error('MCP_CATALOG_NOT_FOUND');
    await this.assertManageRow(actorUserId, row);
    await this.database.raw.execute('DELETE FROM mcp_catalog_entries WHERE id=?', [entryId]);
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'mcp.catalog.deleted',
          actorUserId: actorUserId,
          targetType: 'MCP',
          targetId: entryId
        },
        row,
        {}
      )
    );
  }

  private async requireManageableCatalog(
    actorUserId: number,
    entryId: string
  ): Promise<McpCatalogEntry> {
    const entry = (
      await this.listQuery(actorUserId, { ids: JSON.stringify([entryId]) })
    ).entries.find((item) => item.id === entryId);
    if (entry === undefined) throw new Error('MCP_CATALOG_NOT_FOUND');
    if (!entry.manageable) throw new Error('MCP_SOURCE_FORBIDDEN');
    const { manageable, ...catalog } = entry;
    void manageable;
    return catalog;
  }

  private async sourceRow(sourceId: string): Promise<RowDataPacket> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT built_in,scope,owner_organization_id,owner_user_id FROM mcp_sources WHERE id=?',
      [sourceId]
    );
    if (rows[0] === undefined) throw new Error('MCP_SOURCE_NOT_FOUND');
    return rows[0];
  }

  private async assertManage(
    actorUserId: number,
    scope: McpSourceInput['scope'],
    organizationId?: number
  ): Promise<void> {
    const result = await this.authorization.authorize(
      actorUserId,
      'SKILL_SOURCE_MANAGE',
      scopeContext(scope, actorUserId, organizationId)
    );
    if (!result.allowed) throw new Error('MCP_SOURCE_FORBIDDEN');
  }

  private async assertManageRow(actorUserId: number, row: RowDataPacket): Promise<void> {
    const scope = String(row['scope']) as 'ENTERPRISE' | McpSourceInput['scope'];
    const result = await this.authorization.authorize(
      actorUserId,
      'SKILL_SOURCE_MANAGE',
      scopeContext(
        scope,
        Number(row['owner_user_id']),
        Number(row['owner_organization_id']),
        Boolean(row['built_in'])
      )
    );
    if (!result.allowed) throw new Error('MCP_SOURCE_FORBIDDEN');
  }
}

function registryCandidate(raw: unknown): McpCandidate | undefined {
  if (!isRecord(raw)) return undefined;
  const server = isRecord(raw['server']) ? raw['server'] : raw;
  const serverName = typeof server['name'] === 'string' ? server['name'] : undefined;
  const version = typeof server['version'] === 'string' ? server['version'] : undefined;
  if (serverName === undefined || version === undefined || version === 'latest') return undefined;
  const title =
    typeof server['title'] === 'string' ? server['title'] : serverName.split('/').at(-1)!;
  const description = typeof server['description'] === 'string' ? server['description'] : '';
  const runtime = runtimeFromRegistry(server, serverName, version);
  if (runtime === undefined) return undefined;
  return {
    id: `${serverName}@${version}`,
    serverName,
    displayName: title,
    description,
    version,
    runtime
  };
}

function runtimeFromRegistry(
  server: Record<string, unknown>,
  serverName: string,
  version: string
): McpRuntimeDescriptor | undefined {
  const packages = Array.isArray(server['packages']) ? server['packages'] : [];
  for (const value of packages) {
    if (
      !isRecord(value) ||
      value['registryType'] !== 'npm' ||
      typeof value['identifier'] !== 'string'
    )
      continue;
    const packageVersion = typeof value['version'] === 'string' ? value['version'] : version;
    if (packageVersion === 'latest') continue;
    const args = ['-y', `${value['identifier']}@${packageVersion}`];
    if (serverName === 'io.github.microsoft/playwright-mcp') args.push('--headless', '--isolated');
    const environment = Object.fromEntries(
      (Array.isArray(value['environmentVariables']) ? value['environmentVariables'] : []).flatMap(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate['name'] === 'string' &&
          candidate['isRequired'] === true &&
          /^[A-Z_][A-Z0-9_]*$/u.test(candidate['name'])
            ? [[candidate['name'], { secretName: candidate['name'] }]]
            : []
      )
    );
    return mcpRuntimeDescriptorSchema.parse({
      transport: 'STDIO',
      command: 'npx',
      args,
      ...(Object.keys(environment).length === 0 ? {} : { environment })
    });
  }
  const remotes = Array.isArray(server['remotes']) ? server['remotes'] : [];
  for (const value of remotes) {
    if (isRecord(value) && typeof value['url'] === 'string') {
      const parsed = mcpRuntimeDescriptorSchema.safeParse({ transport: 'HTTP', url: value['url'] });
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

function catalogEntry(row: RowDataPacket): McpCatalogEntry {
  return mcpCatalogEntrySchema.parse({
    id: String(row['id']),
    sourceId: String(row['source_id']),
    scope: row['scope'],
    ...(row['owner_organization_id'] === null
      ? {}
      : { ownerOrganizationId: Number(row['owner_organization_id']) }),
    ...(row['owner_user_id'] === null ? {} : { ownerUserId: Number(row['owner_user_id']) }),
    serverName: String(row['server_name']),
    displayName: String(row['display_name']),
    description: String(row['description']),
    version: String(row['version']),
    featured: Boolean(row['featured']),
    tags: mysqlJson(row['tags']),
    runtime: mysqlJson(row['runtime']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  });
}

function mysqlJson(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as unknown;
  return value;
}

function sourceSummary(row: RowDataPacket): McpSourceSummary {
  return {
    id: String(row['id']),
    scope: row['scope'] as McpSourceInput['scope'],
    ...(row['owner_organization_id'] === null
      ? {}
      : { organizationId: Number(row['owner_organization_id']) }),
    ...(row['owner_user_id'] === null ? {} : { ownerUserId: Number(row['owner_user_id']) }),
    name: String(row['name']),
    locator: String(row['locator']),
    enabled: Boolean(row['enabled']),
    builtIn: Boolean(row['built_in']),
    status: row['status'] as McpSourceSummary['status'],
    lastErrorCode: row['last_error_code'] === null ? null : String(row['last_error_code']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    manageable: false
  };
}

function scopeContext(
  scope: 'ENTERPRISE' | McpSourceInput['scope'],
  userId: number,
  organizationId?: number,
  builtIn = false
): AuthorizationContext {
  if (scope === 'ENTERPRISE' && builtIn) return { ownerType: 'SYSTEM' };
  if (scope === 'PERSONAL') return { ownerType: 'PERSONAL', ownerUserId: userId };
  if (scope === 'ORGANIZATION')
    return { ownerType: 'ORGANIZATION', organizationId: organizationId! };
  return {};
}

function ownerKey(
  scope: 'ENTERPRISE' | McpSourceInput['scope'],
  organizationId: number | null,
  userId: number | null
): string {
  if (scope === 'ENTERPRISE') return 'ENTERPRISE::';
  if (scope === 'ORGANIZATION') return `ORGANIZATION:${organizationId}:`;
  return `PERSONAL:${userId}:`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMysqlDuplicate(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ER_DUP_ENTRY';
}
