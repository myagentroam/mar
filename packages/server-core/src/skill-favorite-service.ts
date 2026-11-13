import type { CatalogListRows } from './catalog-policy.js';
import { ManagementQueryError } from './management-pagination.js';
import { emitAudit, emitAuditAfterCommit, resourceAuditEvent } from './audit.js';
import { withSkillCacheTransaction } from './skill-cache-transaction.js';
import {
  lockMysqlUsers,
  lockMysqlSkillSource,
  withMysqlTransaction
} from './mysql-reference-store.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  skillFavoriteCreateInputSchema,
  skillFavoritePresentationInputSchema,
  type SkillFavoriteCreateInput
} from '@myagentroam/protocol';
import type {
  CatalogScopeContext as AuthorizationContext,
  CatalogAuthorization,
  CatalogDatabase
} from './catalog-policy.js';
import type { GitSkillRepository } from './git-skill-repository.js';
import type { ResolvedSkillBundle } from './skill-bundle.js';
import type { SkillSourceService } from './skill-source-service.js';

export interface SkillFavoriteSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly scope: 'ENTERPRISE' | 'ORGANIZATION' | 'PERSONAL';
  readonly ownerOrganizationId: number | null;
  readonly ownerUserId: number | null;
  readonly normalizedName: string;
  readonly featured: boolean;
  readonly tags: readonly string[];
  readonly description: string;
  readonly repositoryIdentity: string;
  readonly skillPath: string;
  readonly currentVersionId: string;
  readonly commitSha: string;
  readonly contentHash: string;
  readonly tlsVerified: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly manageable: boolean;
}

/**
 * Owns favorite/version transactions, cache publication, and each resolved bundle's lifetime.
 * Repository reads and archive encoding remain in the provider; policy subclasses own visibility.
 */
export abstract class SkillFavoriteService {
  protected abstract favoriteRows(actorUserId: number): Promise<RowDataPacket[]>;
  protected abstract lockOrganization(
    connection: PoolConnection,
    organizationId: number | null,
    exclusive?: boolean,
    scope?: SkillFavoriteSummary['scope']
  ): Promise<void>;
  constructor(
    protected readonly database: CatalogDatabase,
    private readonly authorization: CatalogAuthorization,
    private readonly sources: SkillSourceService,
    private readonly provider: Pick<GitSkillRepository, 'resolve'>,
    private readonly cacheDirectory: string,
    private readonly now: () => number = Date.now,
    private readonly maxCacheBytes = 10 * 1024 * 1024 * 1024,
    private readonly warnCacheUsage: (usedBytes: number, maxBytes: number) => void = () => undefined
  ) {}

  async list(actorUserId: number): Promise<readonly SkillFavoriteSummary[]> {
    return this.summarizeRows(actorUserId, await this.favoriteRows(actorUserId));
  }

  protected async queryRows(
    actorUserId: number,
    query: Record<string, unknown>
  ): Promise<CatalogListRows> {
    if (Object.keys(query).length) throw new ManagementQueryError();
    return { rows: await this.favoriteRows(actorUserId) };
  }

  async listQuery(actorUserId: number, query: Record<string, unknown>) {
    const { rows, metadata, facets } = await this.queryRows(actorUserId, query);
    return {
      favorites: await this.summarizeRows(actorUserId, rows),
      ...metadata,
      ...(facets === undefined ? {} : { facets })
    };
  }

  private async summarizeRows(
    actorUserId: number,
    rows: RowDataPacket[]
  ): Promise<readonly SkillFavoriteSummary[]> {
    return Promise.all(
      rows.map(async (row) => {
        const summary = favoriteSummary(row);
        const authorization = await this.authorization.authorize(
          actorUserId,
          'SKILL_FAVORITE_MANAGE',
          favoriteContext(
            summary.scope,
            summary.ownerUserId ?? undefined,
            summary.ownerOrganizationId ?? undefined
          )
        );
        return { ...summary, manageable: authorization.allowed };
      })
    );
  }

  async create(actorUserId: number, rawInput: unknown): Promise<SkillFavoriteSummary> {
    const input = skillFavoriteCreateInputSchema.parse(rawInput);
    await this.assertManage(actorUserId, input);
    const source = await this.sources.getVisible(actorUserId, input.sourceId);
    const request = resolveCandidate(source, input);
    const bundle = await this.provider.resolve(request);
    try {
      const favoriteId = randomUUID();
      const versionId = randomUUID();
      const timestamp = this.now();
      const ownerUserId = input.scope === 'PERSONAL' ? actorUserId : null;
      const organizationId = input.scope === 'ORGANIZATION' ? input.organizationId! : null;
      const key = ownerKey(input.scope, organizationId, ownerUserId);
      const [countRows] = await this.database.raw.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM skill_favorites WHERE owner_key=?',
        [key]
      );
      if (Number(countRows[0]?.['total'] ?? 0) >= 500)
        throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
      await withSkillCacheTransaction(
        this.database.raw,
        bundle.contentHash,
        async (connection, assertConnected) => {
          // Match organization deletion: organization, users, then dependent resources.
          await this.lockOrganization(connection, organizationId, true, input.scope);
          await lockMysqlUsers(connection, [actorUserId, ownerUserId], ownerUserId !== null);
          await lockMysqlSkillSource(connection, input.sourceId);
          // Lock the owner before any snapshot read, including storeBundle's cache usage read.
          const [countRows] = await connection.execute<RowDataPacket[]>(
            'SELECT COUNT(*) AS total FROM skill_favorites WHERE owner_key=?',
            [key]
          );
          if (Number(countRows[0]?.['total'] ?? 0) >= 500)
            throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
          await this.storeBundle(bundle, connection, assertConnected);
          await connection.execute(
            `INSERT INTO skill_favorites
           (id,source_id,scope,owner_organization_id,owner_user_id,repository_url,
            repository_identity,skill_path,normalized_name,featured,tags,current_version_id,
            created_by_user_id,created_at,updated_at,owner_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
            [
              favoriteId,
              input.sourceId,
              input.scope,
              organizationId,
              ownerUserId,
              bundle.repositoryUrl,
              bundle.repositoryIdentity,
              bundle.skillPath,
              bundle.name,
              input.featured ?? false,
              JSON.stringify(input.tags ?? []),
              actorUserId,
              timestamp,
              timestamp,
              key
            ]
          );
          await connection.execute(
            `INSERT INTO skill_versions
           (id,favorite_id,commit_sha,content_hash,archive_hash,cache_key,file_count,content_bytes,
            metadata,tls_verified,cache_state,unreferenced_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'READY',NULL,?)`,
            [
              versionId,
              favoriteId,
              bundle.commitSha,
              bundle.contentHash,
              bundle.archiveHash,
              bundle.contentHash,
              bundle.fileCount,
              bundle.contentBytes,
              JSON.stringify({ name: bundle.name, description: bundle.description }),
              bundle.tlsVerified,
              timestamp
            ]
          );
          await connection.execute('UPDATE skill_favorites SET current_version_id=? WHERE id=?', [
            versionId,
            favoriteId
          ]);
          await connection.execute(
            "UPDATE skill_versions SET unreferenced_at=NULL WHERE content_hash=? AND cache_key=? AND cache_state='READY'",
            [bundle.contentHash, bundle.contentHash]
          );
        }
      );
      const summary = summaryFromBundle({
        favoriteId,
        versionId,
        sourceId: input.sourceId,
        scope: input.scope,
        ownerOrganizationId: organizationId,
        ownerUserId,
        bundle,
        featured: input.featured ?? false,
        tags: input.tags ?? [],
        timestamp
      });
      emitAudit(
        this.database,
        resourceAuditEvent(
          {
            eventType: 'skill.catalog.created',
            actorUserId: actorUserId,
            targetType: 'SKILL',
            targetId: favoriteId
          },
          { ...summary, ownerOrganizationId: organizationId },
          {}
        )
      );
      return summary;
    } finally {
      await bundle.dispose();
    }
  }

  async getVisible(actorUserId: number, favoriteId: string): Promise<SkillFavoriteSummary> {
    const favorite = (
      await this.listQuery(actorUserId, { ids: JSON.stringify([favoriteId]) })
    ).favorites.find((candidate) => candidate.id === favoriteId);
    if (favorite === undefined) throw new Error('SKILL_FAVORITE_NOT_FOUND');
    return favorite;
  }

  async checkUpdate(
    actorUserId: number,
    favoriteId: string
  ): Promise<{ readonly updateAvailable: boolean; readonly latestCommitSha: string }> {
    const row = await this.requireFavorite(actorUserId, favoriteId, true);
    const bundle = await this.provider.resolve({
      repositoryUrl: String(row['repository_url']),
      skillPath: String(row['skill_path'])
    });
    try {
      if (bundle.name !== String(row['normalized_name'])) throw new Error('SKILL_NAME_CONFLICT');
      const [versions] = await this.database.raw.execute<RowDataPacket[]>(
        'SELECT commit_sha FROM skill_versions WHERE id=?',
        [String(row['current_version_id'])]
      );
      const currentCommitSha = versions[0]?.['commit_sha'];
      if (typeof currentCommitSha !== 'string') throw new Error('SKILL_VERSION_NOT_FOUND');
      return {
        updateAvailable: bundle.commitSha !== currentCommitSha,
        latestCommitSha: bundle.commitSha
      };
    } finally {
      await bundle.dispose();
    }
  }

  async updatePresentation(
    actorUserId: number,
    favoriteId: string,
    rawInput: unknown
  ): Promise<void> {
    const input = skillFavoritePresentationInputSchema.parse(rawInput);
    const row = await this.requireFavorite(actorUserId, favoriteId, true);
    await this.database.raw.execute(
      'UPDATE skill_favorites SET featured=?,tags=?,updated_at=? WHERE id=?',
      [input.featured, JSON.stringify(input.tags), this.now(), favoriteId]
    );
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'skill.catalog.updated',
          actorUserId: actorUserId,
          targetType: 'SKILL',
          targetId: favoriteId
        },
        row,
        {}
      )
    );
  }

  async upgrade(actorUserId: number, favoriteId: string): Promise<SkillFavoriteSummary> {
    const row = await this.requireFavorite(actorUserId, favoriteId, true);
    const bundle = await this.provider.resolve({
      repositoryUrl: String(row['repository_url']),
      skillPath: String(row['skill_path'])
    });
    try {
      if (bundle.name !== String(row['normalized_name'])) throw new Error('SKILL_NAME_CONFLICT');
      const timestamp = this.now();
      const versionId = randomUUID();
      return await withSkillCacheTransaction(
        this.database.raw,
        bundle.contentHash,
        async (connection, assertConnected) => {
          await this.storeBundle(bundle, connection, assertConnected);
          const [parents] = await connection.execute<RowDataPacket[]>(
            `SELECT favorite.id,version.cache_key FROM skill_favorites favorite
             LEFT JOIN skill_versions version ON version.id=favorite.current_version_id
             WHERE favorite.id=? FOR UPDATE`,
            [favoriteId]
          );
          if (parents.length !== 1) throw new Error('SKILL_FAVORITE_NOT_FOUND');
          const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM skill_versions WHERE favorite_id=? AND commit_sha=?',
            [favoriteId, bundle.commitSha]
          );
          const effectiveVersionId =
            existing[0] === undefined ? versionId : String(existing[0]['id']);
          if (existing[0] === undefined)
            await connection.execute(
              `INSERT INTO skill_versions
             (id,favorite_id,commit_sha,content_hash,archive_hash,cache_key,file_count,content_bytes,
              metadata,tls_verified,cache_state,unreferenced_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,'READY',NULL,?)`,
              [
                versionId,
                favoriteId,
                bundle.commitSha,
                bundle.contentHash,
                bundle.archiveHash,
                bundle.contentHash,
                bundle.fileCount,
                bundle.contentBytes,
                JSON.stringify({ name: bundle.name, description: bundle.description }),
                bundle.tlsVerified,
                timestamp
              ]
            );
          else
            await connection.execute(
              "UPDATE skill_versions SET cache_state='READY',unreferenced_at=NULL WHERE id=?",
              [effectiveVersionId]
            );
          await connection.execute(
            'UPDATE skill_favorites SET current_version_id=?,updated_at=? WHERE id=?',
            [effectiveVersionId, timestamp, favoriteId]
          );
          const previousKey = parents[0]?.['cache_key'];
          if (typeof previousKey === 'string' && previousKey !== bundle.contentHash)
            await this.markCacheUnreferenced(connection, previousKey);
          await connection.execute(
            "UPDATE skill_versions SET unreferenced_at=NULL WHERE content_hash=? AND cache_key=? AND cache_state='READY'",
            [bundle.contentHash, bundle.contentHash]
          );
          emitAuditAfterCommit(
            this.database,
            connection,
            resourceAuditEvent(
              {
                eventType: 'skill.catalog.upgraded',
                actorUserId: actorUserId,
                targetType: 'SKILL',
                targetId: favoriteId
              },
              row,
              { version: effectiveVersionId }
            )
          );
          return summaryFromBundle({
            favoriteId,
            versionId: effectiveVersionId,
            sourceId: String(row['source_id']),
            scope: String(row['scope']) as SkillFavoriteSummary['scope'],
            ownerOrganizationId: nullableNumber(row['owner_organization_id']),
            ownerUserId: nullableNumber(row['owner_user_id']),
            bundle,
            featured: Boolean(row['featured']),
            tags: skillTags(row['tags']),
            timestamp,
            createdAt: Number(row['created_at'])
          });
        }
      );
    } finally {
      await bundle.dispose();
    }
  }

  async remove(actorUserId: number, favoriteId: string): Promise<void> {
    const row = await this.requireFavorite(actorUserId, favoriteId, true);
    await withMysqlTransaction(this.database.raw, async (connection) => {
      const [parents] = await connection.execute<RowDataPacket[]>(
        `SELECT favorite.id,version.cache_key FROM skill_favorites favorite
         LEFT JOIN skill_versions version ON version.id=favorite.current_version_id
         WHERE favorite.id=? FOR UPDATE`,
        [favoriteId]
      );
      if (parents.length !== 1) throw new Error('SKILL_FAVORITE_NOT_FOUND');
      const [versions] = await connection.execute<RowDataPacket[]>(
        'SELECT DISTINCT cache_key FROM skill_versions WHERE favorite_id=?',
        [favoriteId]
      );
      const timestamp = new Date(this.now());
      for (const version of versions) {
        try {
          await utimes(
            path.join(this.cacheDirectory, `${String(version['cache_key'])}.json`),
            timestamp,
            timestamp
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await connection.execute('DELETE FROM skill_versions WHERE favorite_id=?', [favoriteId]);
      await connection.execute('DELETE FROM skill_favorites WHERE id=?', [favoriteId]);
      const previousKey = parents[0]?.['cache_key'];
      if (typeof previousKey === 'string')
        await this.markCacheUnreferenced(connection, previousKey);
    });
    emitAudit(
      this.database,
      resourceAuditEvent(
        {
          eventType: 'skill.catalog.deleted',
          actorUserId: actorUserId,
          targetType: 'SKILL',
          targetId: favoriteId
        },
        row,
        {}
      )
    );
  }

  async cleanupCache(graceMs = 24 * 60 * 60 * 1000): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.cacheDirectory);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      const match = /^([0-9a-f]{64})\.json$/u.exec(entry);
      if (match === null) continue;
      const cacheKey = match[1]!;
      const reclaimed = await withSkillCacheTransaction(
        this.database.raw,
        cacheKey,
        async (connection, assertConnected) => {
          const [references] = await connection.execute<RowDataPacket[]>(
            `SELECT version.cache_key FROM skill_favorites favorite
             JOIN skill_versions version ON version.id=favorite.current_version_id
             WHERE version.cache_key=? LIMIT 1`,
            [cacheKey]
          );
          if (references.length > 0) return false;
          const [eligible] = await connection.execute<RowDataPacket[]>(
            `SELECT COUNT(*) AS versions,MIN(unreferenced_at) AS unreferenced_at FROM skill_versions
             WHERE cache_key=? AND cache_state='READY'`,
            [cacheKey]
          );
          const file = path.join(this.cacheDirectory, entry);
          let modifiedAt: number;
          try {
            modifiedAt = (await stat(file)).mtimeMs;
          } catch (error) {
            if (isMissing(error)) return false;
            throw error;
          }
          const eligibleAt = eligible[0]?.['unreferenced_at'];
          let unreferencedAt = eligibleAt == null ? modifiedAt : Number(eligibleAt);
          if (eligibleAt == null && Number(eligible[0]?.['versions']) > 0) {
            // Start previously unobserved orphan periods only after the fresh key reference check.
            unreferencedAt = this.now();
            await this.markCacheUnreferenced(connection, cacheKey, unreferencedAt);
          }
          if (this.now() - unreferencedAt < graceMs) return false;
          assertConnected();
          await unlink(file);
          await connection.execute(
            `UPDATE skill_versions SET cache_state='TRASHED',unreferenced_at=COALESCE(unreferenced_at,?)
             WHERE content_hash=? AND cache_key=?`,
            [this.now(), cacheKey, cacheKey]
          );
          return true;
        }
      );
      if (reclaimed) removed += 1;
    }
    return removed;
  }

  private async markCacheUnreferenced(
    connection: PoolConnection,
    cacheKey: string,
    timestamp = this.now()
  ): Promise<void> {
    // Every reference release renews the key's remaining orphan rows in the same transaction.
    // Rows still selected by another favorite are not orphaned and keep their NULL timestamp.
    // The indexed content identity prevents grace writes from locking unrelated cache keys.
    await connection.execute(
      `UPDATE skill_versions version
       LEFT JOIN skill_favorites favorite ON favorite.current_version_id=version.id
       SET version.unreferenced_at=?
       WHERE version.content_hash=? AND version.cache_key=? AND favorite.id IS NULL AND version.cache_state='READY'`,
      [timestamp, cacheKey, cacheKey]
    );
  }

  private async requireFavorite(
    actorUserId: number,
    favoriteId: string,
    writable: boolean
  ): Promise<RowDataPacket> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT * FROM skill_favorites WHERE id=?',
      [favoriteId]
    );
    const row = rows[0];
    if (row === undefined) throw new Error('SKILL_FAVORITE_NOT_FOUND');
    if (writable) {
      const scope = String(row['scope']) as SkillFavoriteSummary['scope'];
      const result = await this.authorization.authorize(
        actorUserId,
        'SKILL_FAVORITE_MANAGE',
        favoriteContext(scope, Number(row['owner_user_id']), Number(row['owner_organization_id']))
      );
      if (!result.allowed) throw new Error('SKILL_FAVORITE_FORBIDDEN');
    }
    return row;
  }

  private async assertManage(actorUserId: number, input: SkillFavoriteCreateInput): Promise<void> {
    const result = await this.authorization.authorize(
      actorUserId,
      'SKILL_FAVORITE_MANAGE',
      favoriteContext(input.scope, actorUserId, input.organizationId)
    );
    if (!result.allowed) throw new Error('SKILL_FAVORITE_FORBIDDEN');
  }

  private async storeBundle(
    bundle: ResolvedSkillBundle,
    connection: PoolConnection,
    assertConnected: () => void
  ): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });
    const destination = path.join(this.cacheDirectory, `${bundle.contentHash}.json`);
    try {
      await stat(destination);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const [usageRows] = await connection.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(content_bytes),0) AS total FROM (
         SELECT content_hash,MAX(content_bytes) AS content_bytes
         FROM skill_versions WHERE cache_state='READY' GROUP BY content_hash
       ) cached_versions`
    );
    const used = Number(usageRows[0]?.['total'] ?? 0);
    if (used + bundle.contentBytes > this.maxCacheBytes * 0.8)
      this.warnCacheUsage(used + bundle.contentBytes, this.maxCacheBytes);
    if (used + bundle.contentBytes > this.maxCacheBytes * 0.9)
      throw new Error('SKILL_SOURCE_LIMIT_EXCEEDED');
    const staging = `${destination}.${randomUUID()}.tmp`;
    try {
      assertConnected();
      await pipeline(bundle.archive(), createWriteStream(staging, { flags: 'wx', mode: 0o600 }));
      assertConnected();
      await rename(staging, destination);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ))
        throw error;
    } finally {
      await rm(staging, { force: true });
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function resolveCandidate(
  source: { readonly kind: 'SKILLS_SH' | 'REPOSITORY'; readonly locator: string },
  input: SkillFavoriteCreateInput
): { repositoryUrl: string; skillPath?: string; skillName?: string } {
  if (source.kind === 'REPOSITORY') {
    if (input.skillPath === undefined) throw new Error('SKILL_CONTENT_INVALID');
    return { repositoryUrl: source.locator, skillPath: input.skillPath };
  }
  const parts = input.candidateId.split('/');
  if (parts.length < 3 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part)))
    throw new Error('SKILL_CONTENT_INVALID');
  return {
    repositoryUrl: `https://github.com/${parts[0]}/${parts[1]}`,
    skillName: parts.at(-1)!
  };
}

function favoriteContext(
  scope: SkillFavoriteSummary['scope'],
  userId?: number,
  organizationId?: number
): AuthorizationContext {
  if (scope === 'PERSONAL') {
    if (!Number.isSafeInteger(userId)) throw new Error('SKILL_FAVORITE_INVALID');
    return { ownerType: 'PERSONAL', ownerUserId: userId! };
  }
  if (scope === 'ORGANIZATION') {
    if (!Number.isSafeInteger(organizationId)) throw new Error('SKILL_FAVORITE_INVALID');
    return { ownerType: 'ORGANIZATION', organizationId: organizationId! };
  }
  return {};
}

function ownerKey(
  scope: SkillFavoriteSummary['scope'],
  organizationId: number | null,
  userId: number | null
): string {
  return scope === 'ENTERPRISE'
    ? 'ENTERPRISE::'
    : scope === 'ORGANIZATION'
      ? `ORGANIZATION:${organizationId}:`
      : `PERSONAL:${userId}:`;
}

function summaryFromBundle(input: {
  favoriteId: string;
  versionId: string;
  sourceId: string;
  scope: SkillFavoriteSummary['scope'];
  ownerOrganizationId: number | null;
  ownerUserId: number | null;
  bundle: ResolvedSkillBundle;
  featured: boolean;
  tags: readonly string[];
  timestamp: number;
  createdAt?: number;
}): SkillFavoriteSummary {
  return {
    id: input.favoriteId,
    sourceId: input.sourceId,
    scope: input.scope,
    ownerOrganizationId: input.ownerOrganizationId,
    ownerUserId: input.ownerUserId,
    normalizedName: input.bundle.name,
    featured: input.featured,
    tags: input.tags,
    description: input.bundle.description,
    repositoryIdentity: input.bundle.repositoryIdentity,
    skillPath: input.bundle.skillPath,
    currentVersionId: input.versionId,
    commitSha: input.bundle.commitSha,
    contentHash: input.bundle.contentHash,
    tlsVerified: input.bundle.tlsVerified,
    createdAt: input.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
    manageable: true
  };
}

function favoriteSummary(row: RowDataPacket): SkillFavoriteSummary {
  const metadata = skillMetadata(row['metadata']);
  return {
    id: String(row['id']),
    sourceId: String(row['source_id']),
    scope: String(row['scope']) as SkillFavoriteSummary['scope'],
    ownerOrganizationId: nullableNumber(row['owner_organization_id']),
    ownerUserId: nullableNumber(row['owner_user_id']),
    normalizedName: String(row['normalized_name']),
    featured: Boolean(row['featured']),
    tags: skillTags(row['tags']),
    description: typeof metadata['description'] === 'string' ? metadata['description'] : '',
    repositoryIdentity: String(row['repository_identity']),
    skillPath: String(row['skill_path']),
    currentVersionId: String(row['current_version_id']),
    commitSha: String(row['commit_sha']),
    contentHash: String(row['content_hash']),
    tlsVerified: Boolean(row['tls_verified']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    manageable: false
  };
}

function skillMetadata(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  const parsed = JSON.parse(String(value)) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function skillTags(value: unknown): readonly string[] {
  const parsed = Array.isArray(value) ? value : (JSON.parse(String(value ?? '[]')) as unknown);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
