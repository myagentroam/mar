import type { FastifyInstance } from 'fastify';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type {
  AuthorizationProvider,
  ProductCapabilityProvider
} from '../product/product-policy.js';
import { LicenseService } from '../license/license-service.js';
import { LICENSE_PUBLIC_KEY } from '../license/public-key.js';
import { registerManagementLicenseGate } from '../license/management-gate.js';
import { registerLicenseRoutes } from '../route/license-routes.js';
import { AuthorizationService } from '../rbac/authorization-service.js';
import { loadPermissionMatrix } from '../rbac/permission-matrix.js';

export interface EnterpriseServerProduct {
  readonly licenses: LicenseService;
  readonly authorization: AuthorizationProvider;
  readonly capabilities: ProductCapabilityProvider;
  registerLicenseManagement(app: FastifyInstance, publicOrigin: string | undefined): void;
}

export function createEnterpriseServerProduct(input: {
  readonly database: MysqlServerDatabase;
  readonly now: () => number;
  readonly productUuid?: string | null;
  readonly publicKey?: string;
}): EnterpriseServerProduct {
  const licenses = new LicenseService(input.database, input.publicKey ?? LICENSE_PUBLIC_KEY, {
    now: input.now,
    ...(input.productUuid === undefined ? {} : { productUuid: input.productUuid })
  });
  const authorization = new AuthorizationService(
    input.database,
    loadPermissionMatrix(),
    async (userId) => (await licenses.capability(userId)).edition === 'COMMUNITY'
  );
  return {
    licenses,
    authorization,
    capabilities: licenses,
    registerLicenseManagement(app, publicOrigin) {
      registerManagementLicenseGate(app, licenses, input.database, publicOrigin);
      registerLicenseRoutes({ app, database: input.database, licenses, publicOrigin });
    }
  };
}
