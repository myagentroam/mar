import { SkillSourceService } from '../skill/skill-source-service.js';
import { GitSkillRepository } from '../skill/git-skill-repository.js';
import { SkillDiscoveryService } from '../skill/skill-discovery-service.js';
import { SkillFavoriteService } from '../skill/skill-favorite-service.js';
import { SkillArtifactService } from '../skill/skill-artifact-service.js';
import { publicHttpsFetch, SkillNetworkPolicy } from '../skill/skill-network-policy.js';
import { McpService } from '../mcp/mcp-service.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { createEnterpriseServerProduct } from './enterprise-product.js';

/**
 * Composes the catalog services and shared Git reader; domain services own their caches and I/O.
 * The application owns service lifecycles; this module contains no transport or catalog rules.
 */
export function composeServerCatalog(input: {
  readonly database: MysqlServerDatabase;
  readonly authorization: ReturnType<typeof createEnterpriseServerProduct>['authorization'];
  readonly cacheDirectory: string;
  readonly cacheMaxBytes: number;
  readonly warnCacheUsage: (usedBytes: number, maxBytes: number) => void;
  readonly now: () => number;
}) {
  const { database, authorization, now, cacheDirectory } = input;
  const skillSources = new SkillSourceService(database, authorization, now);
  const skillNetwork = new SkillNetworkPolicy(database);
  const skillRepository = new GitSkillRepository(() => skillNetwork.disabled());
  const skillDiscovery = new SkillDiscoveryService(skillNetwork.fetch, skillRepository);
  const skillFavorites = new SkillFavoriteService(
    database,
    authorization,
    skillSources,
    skillRepository,
    cacheDirectory,
    now,
    input.cacheMaxBytes,
    input.warnCacheUsage
  );
  const skillArtifacts = new SkillArtifactService(cacheDirectory, now);
  const mcps = new McpService(database, authorization, publicHttpsFetch, now);
  return { skillSources, skillNetwork, skillDiscovery, skillFavorites, skillArtifacts, mcps };
}
