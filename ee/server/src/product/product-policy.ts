import type { PoolConnection } from 'mysql2/promise';

export type {
  ProductCapabilities,
  ProductCapabilityProvider
} from '@myagentroam/server-core/product-capabilities';

export interface AuthorizationContext {
  readonly ownerType?: 'PERSONAL' | 'ORGANIZATION' | 'SYSTEM';
  readonly ownerUserId?: number;
  readonly organizationId?: number;
  readonly granted?: boolean;
  readonly strictDescendant?: boolean;
}

export interface ActorAuthorizationContext {
  readonly role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER';
  readonly organizationId: number;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type AuthorizationConnection = Pick<PoolConnection, 'execute'>;
export interface GrantScope {
  readonly role: 'ADMIN' | 'ORG_ADMIN';
  readonly organizationId: number;
}

export interface AuthorizationProvider {
  authorize(
    actorUserId: number,
    permissionId: string,
    context?: AuthorizationContext,
    connection?: AuthorizationConnection
  ): Promise<AuthorizationDecision>;
  actorContext(
    actorUserId: number,
    connection?: AuthorizationConnection
  ): Promise<ActorAuthorizationContext | undefined>;
  isPersonalAdmin(actorUserId: number): Promise<boolean>;
  managedOrganizationIds(actorUserId: number): Promise<readonly number[]>;
  authorizeManagedUser(
    actorUserId: number,
    targetUserId: number,
    connection?: AuthorizationConnection
  ): Promise<AuthorizationDecision>;
  authorizeRoleAssignment(
    actorUserId: number,
    assignedRole: ActorAuthorizationContext['role'],
    targetOrganizationId: number,
    connection?: AuthorizationConnection
  ): Promise<AuthorizationDecision>;
  grantScope(
    actorUserId: number,
    connection?: AuthorizationConnection
  ): Promise<GrantScope | undefined>;
}
