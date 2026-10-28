import { SkillSourceService } from '../skill/skill-source-service.js';
import { GithubSkillProvider } from '../skill/github-skill-provider.js';
import { SkillFavoriteService } from '../skill/skill-favorite-service.js';
import { SkillArtifactService } from '../skill/skill-artifact-service.js';
import { publicHttpsFetch, SkillNetworkPolicy } from '../skill/skill-network-policy.js';
import { McpService } from '../mcp/mcp-service.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { createEnterpriseServerProduct } from './enterprise-product.js';

/** Compose the Skill and MCP directories around their shared authorization policy. */
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
  const skillFavorites = new SkillFavoriteService(
    database,
    authorization,
    skillSources,
    new GithubSkillProvider(skillNetwork.fetch, () => skillNetwork.disabled()),
    cacheDirectory,
    now,
    input.cacheMaxBytes,
    input.warnCacheUsage
  );
  const skillArtifacts = new SkillArtifactService(cacheDirectory, now);
  const mcps = new McpService(database, authorization, publicHttpsFetch, now);
  return { skillSources, skillNetwork, skillFavorites, skillArtifacts, mcps };
}
