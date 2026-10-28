import type { PoolConnection } from 'mysql2/promise';
import type { ResourceOwnership } from '@myagentroam/protocol';
import type { AuthorizationProvider } from '../product/product-policy.js';

export function authorizationOwnership(resource: ResourceOwnership) {
  return resource.ownerType === 'PERSONAL'
    ? { ownerType: resource.ownerType, ownerUserId: resource.ownerUserId }
    : { ownerType: resource.ownerType, organizationId: resource.ownerOrganizationId };
}

export async function requireOwnershipManagement(
  authorization: AuthorizationProvider,
  actorUserId: number,
  resource: ResourceOwnership,
  permissionId = 'RESOURCE_MANAGE',
  connection?: Pick<PoolConnection, 'execute'>
): Promise<void> {
  if (resource.ownerType === 'PERSONAL' && resource.ownerUserId !== actorUserId)
    throw new Error('RBAC_SCOPE_DENIED');
  const allowed = await authorization.authorize(
    actorUserId,
    permissionId,
    authorizationOwnership(resource),
    connection
  );
  if (!allowed.allowed) throw new Error(allowed.reason ?? 'RBAC_DENIED');
}
