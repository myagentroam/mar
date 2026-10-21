import type { ManagementPageMetadata } from '@myagentroam/protocol';
import type { RowDataPacket } from 'mysql2/promise';
import type { AuditObserver } from './audit.js';
import type { Pool } from 'mysql2/promise';
export interface CatalogScopeContext {
  readonly ownerType?: 'PERSONAL' | 'ORGANIZATION' | 'SYSTEM';
  readonly ownerUserId?: number;
  readonly organizationId?: number;
}
export interface CatalogAuthorization {
  authorize(
    userId: number,
    action: string,
    context?: CatalogScopeContext
  ): Promise<{ readonly allowed: boolean }>;
}
export interface CatalogDatabase extends Partial<AuditObserver> {
  readonly raw: Pool;
}

export interface CatalogListRows {
  readonly rows: RowDataPacket[];
  readonly metadata?: ManagementPageMetadata;
  readonly facets?: { readonly tags: readonly string[] };
}
