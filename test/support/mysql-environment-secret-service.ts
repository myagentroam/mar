import {
  MysqlEnvironmentSecretService,
  type EnvironmentSecretAccess
} from '../../ee/server/src/mysql/environment-secret-service.ts';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.ts';

/** Personal-only defaults belong to isolated tests, not production composition. */
export function createTestMysqlEnvironmentSecretService(
  database: MysqlServerDatabase,
  canManageNode: EnvironmentSecretAccess['canManageNode'] = (userId, nodeId) =>
    personalNodeAccess(database, userId, nodeId),
  canUseNode: EnvironmentSecretAccess['canUseNode'] = (userId, nodeId) =>
    personalNodeAccess(database, userId, nodeId),
  managedOrganizationIds: EnvironmentSecretAccess['managedOrganizationIds'] = async () => [],
  canManageOrganization: EnvironmentSecretAccess['canManageOrganization'] = async (
    userId,
    organizationId
  ) => (await managedOrganizationIds(userId)).includes(organizationId),
  canManageWorkspace: EnvironmentSecretAccess['canManageWorkspace'] = async () => false,
  canUseWorkspace: EnvironmentSecretAccess['canUseWorkspace'] = async () => false
): MysqlEnvironmentSecretService {
  return new MysqlEnvironmentSecretService(database, {
    canManageNode,
    canUseNode,
    managedOrganizationIds,
    canManageOrganization,
    canManageWorkspace,
    canUseWorkspace
  });
}

async function personalNodeAccess(
  database: MysqlServerDatabase,
  userId: number,
  nodeId: string
): Promise<boolean> {
  return (await database.listNodesForUser(userId)).some(
    (node) => node.id === nodeId && !node.disabled
  );
}
