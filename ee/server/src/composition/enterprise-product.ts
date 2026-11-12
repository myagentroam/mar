import type { FastifyInstance } from 'fastify';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type {
  AuthorizationProvider,
  ProductCapabilityProvider
} from '../product/product-policy.js';
import {
  LicenseService,
  readQuickStartHostFingerprint,
  type LicenseStatus
} from '../license/license-service.js';
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
  return assembleProduct(input.database, licenses, { activationAvailable: true });
}

/** Non-Linux Quick Start retains fixed community policy without host identity or activation. */
class QuickStartLicenseService extends LicenseService {
  override async status(): Promise<LicenseStatus> {
    return {
      edition: 'COMMUNITY',
      state: 'COMMUNITY',
      reason: null,
      licenseId: null,
      enterpriseName: null,
      expiresAt: null,
      managementWritable: true
    };
  }
  override requestCode(): never {
    throw new Error('LICENSE_ACTIVATION_UNAVAILABLE');
  }
  override async import(): Promise<never> {
    throw new Error('LICENSE_ACTIVATION_UNAVAILABLE');
  }
}

export function createQuickStartServerProduct(input: {
  readonly database: MysqlServerDatabase;
  readonly now: () => number;
  readonly publicKey?: string;
}): EnterpriseServerProduct {
  if (process.platform === 'linux') {
    const licenses = new LicenseService(input.database, input.publicKey ?? LICENSE_PUBLIC_KEY, {
      now: input.now,
      hostFingerprint: readQuickStartHostFingerprint()
    });
    return assembleProduct(input.database, licenses, {
      activationAvailable: true,
      activationVisible: false
    });
  }
  const licenses = new QuickStartLicenseService(input.database, LICENSE_PUBLIC_KEY, {
    now: input.now,
    productUuid: null
  });
  return assembleProduct(input.database, licenses, { activationAvailable: false });
}

function assembleProduct(
  database: MysqlServerDatabase,
  licenses: LicenseService,
  activation: { readonly activationAvailable: boolean; readonly activationVisible?: boolean }
): EnterpriseServerProduct {
  const authorization = new AuthorizationService(
    database,
    loadPermissionMatrix(),
    async (userId) => (await licenses.capability(userId)).edition === 'COMMUNITY'
  );
  return {
    licenses,
    authorization,
    capabilities: licenses,
    registerLicenseManagement(app, publicOrigin) {
      registerManagementLicenseGate(app, licenses, database, publicOrigin);
      registerLicenseRoutes({ app, database, licenses, publicOrigin, ...activation });
    }
  };
}
