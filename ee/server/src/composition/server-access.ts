import { createEnterpriseServerProduct } from './enterprise-product.js';
import { ResourceAccessService } from '../rbac/resource-access-service.js';
import { ResourceMutationService } from '../rbac/resource-mutation-service.js';
import { ResourceManagementDirectory } from '../rbac/resource-management-directory.js';
import {
  CodexCredentialService,
  type CodexCredentialServiceOptions
} from '../service/codex-credential-service.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';

/** Assemble authentication product policy and resource access against one store. */
export function composeServerAccess(input: {
  readonly database: MysqlServerDatabase;
  readonly now: () => number;
  readonly projectVersion: string;
  readonly chatgptNodeRequest: NonNullable<CodexCredentialServiceOptions['chatgptNodeRequest']>;
  readonly publicKey?: string;
  readonly productUuid?: string | null;
}) {
  const { database, now } = input;
  const product = createEnterpriseServerProduct({
    database,
    now,
    ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    ...(input.productUuid === undefined ? {} : { productUuid: input.productUuid })
  });
  const { licenses, authorization } = product;
  const personalHostingAdmission = async (userId: number): Promise<boolean> =>
    userId === 1 &&
    (await licenses.capability(userId)).edition === 'COMMUNITY' &&
    (await authorization.isPersonalAdmin(userId)) === true;
  const codexCredentials = new CodexCredentialService(database, {
    authorization,
    chatgptNodeRequest: input.chatgptNodeRequest,
    now,
    projectVersion: input.projectVersion
  });
  const resources = new ResourceAccessService(
    database,
    authorization,
    now,
    codexCredentials,
    personalHostingAdmission
  );
  const directory = new ResourceManagementDirectory(database, authorization);
  const mutations = new ResourceMutationService(database, authorization, resources, now);
  return {
    product,
    licenses,
    authorization,
    codexCredentials,
    resources,
    directory,
    mutations,
    personalHostingAdmission
  };
}
