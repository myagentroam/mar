import {
  createMcpCenterService as createCore,
  type McpCatalogCard as CoreCard
} from '@myagentroam/web-core/mcp-center';
export type { McpInstallationCard, McpTargetInspection } from '@myagentroam/web-core/mcp-center';
type CatalogScope = 'ENTERPRISE' | 'ORGANIZATION' | 'PERSONAL';
export type McpCatalogCard = CoreCard<CatalogScope>;
export const createMcpCenterService = createCore<CatalogScope>;
