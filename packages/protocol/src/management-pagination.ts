import { z } from 'zod';

export const MANAGEMENT_DEFAULT_LIMIT = 20;
export const MANAGEMENT_MAX_LIMIT = 500;

export const managementPageMetadataSchema = z.object({
  page: z.number().int().positive().safe(),
  pageSize: z.number().int().min(1).max(MANAGEMENT_MAX_LIMIT),
  total: z.number().int().nonnegative().safe(),
  hasMore: z.boolean()
});
export type ManagementPageMetadata = z.infer<typeof managementPageMetadataSchema>;
export interface ManagementPageQuery {
  readonly page: number;
  readonly limit: number;
}
export interface ManagementPage<T> extends ManagementPageMetadata {
  readonly items: readonly T[];
  readonly facets?: { readonly tags: readonly string[] };
}
