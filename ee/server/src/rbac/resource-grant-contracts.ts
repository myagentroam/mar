export type GrantTarget =
  | { readonly targetType: 'USER'; readonly targetUserId: number }
  | { readonly targetType: 'ORGANIZATION'; readonly targetOrganizationId: number };
export type GrantResourceType = 'NODE' | 'WORKSPACE' | 'MODEL' | 'IMAGE_MODEL' | 'TEMPLATE';

export function resourceKey(
  resourceType: GrantResourceType,
  resourceId: string,
  workspaceId: string | null
): string {
  return resourceType === 'MODEL' || resourceType === 'IMAGE_MODEL' || resourceType === 'TEMPLATE'
    ? `${resourceType}:${resourceId}`
    : `${resourceType}:${resourceId}:${workspaceId ?? ''}`;
}
