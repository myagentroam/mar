import { resolve } from 'node:path';
import serverPackage from '../../ee/server/package.json';
import { serverWorkbenchCapabilities } from '../../packages/server-core/src/runner-capabilities.ts';
import { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.ts';
import { ManagementQueryError } from '../../packages/server-core/src/management-pagination.ts';
import { registerNodeRegistrationRoute } from '../../packages/server-core/src/node-registration-route.ts';
import { personalWorkspacePolicy } from '../../packages/server-core/test/support/workspace-resource-policy.ts';
import type { ServerApplication, ServerAppOptions } from '../../ee/server/src/app.ts';
import { createServerHttp } from '../../ee/server/src/composition/server-http.ts';
import { openServerDatabase } from '../../ee/server/src/database.ts';
import { createTestNodeControl } from './create-test-node-control.ts';
import { EnvironmentSecretService } from '../../ee/server/src/service/environment-secret-service.ts';
import { databaseError, type LoginRateRecord } from '../../ee/server/src/util/http-request.ts';
import { registerAuthRoutes } from '../../ee/server/src/route/auth-routes.ts';
import { registerManagementRoutes } from '../../ee/server/src/route/management-routes.ts';
import { registerNodeRoutes } from '../../ee/server/src/route/node-routes.ts';
import { registerWorkspaceRoutes } from '../../ee/server/src/route/workspace-routes.ts';
import { registerRealtimeRoutes } from '../../ee/server/src/route/realtime-routes.ts';
import { registerSessionRunRoutes } from '../../ee/server/src/route/session-run-routes.ts';
import { registerRunControlRoutes } from '../../ee/server/src/route/run-control-routes.ts';
import { registerEnvironmentSecretRoutes } from '../../ee/server/src/route/environment-secret-routes.ts';
import { registerWebSearchRoutes } from '../../ee/server/src/route/web-search-routes.ts';

/** SQLite-backed fixture for Server boundary tests; not a product composition. */
export function createTestServerApp(
  input: ServerAppOptions & { readonly databasePath: string }
): ServerApplication {
  const { databasePath, ...options } = input;
  const now = options.now ?? Date.now;
  const database = openServerDatabase(databasePath, { now });
  const { app: httpApp, traffic } = createServerHttp({
    dataDirectory: resolve(options.dataDirectory ?? process.env['MAR_DATA_DIR'] ?? './data'),
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  const app = httpApp as unknown as ServerApplication;
  const publicOrigin = options.publicOrigin ?? process.env['MAR_PUBLIC_ORIGIN'];
  const authorizeNodeRequest = (userId: number, nodeId: string) =>
    database.userOwnsNode(userId, nodeId);
  const nodeControl = createTestNodeControl(
    database,
    authorizeNodeRequest,
    (event, fields) => app.log.info({ event, ...fields }),
    traffic
  );
  const secrets = new EnvironmentSecretService(database);
  const nodeUpgrades = options.nodeUpgrades ?? new NodeUpgradeService(serverPackage.version);
  registerAuthRoutes({
    app,
    store: database,
    audit: { record: (event) => database.audit(event) },
    nodeControl,
    publicOrigin,
    secureCookies: options.secureCookies ?? true,
    now,
    loginRate: new Map<string, LoginRateRecord>()
  });
  registerManagementRoutes({
    app,
    database,
    nodeControl,
    nodeUpgrades,
    traffic,
    publicOrigin,
    resources: {
      assertCanHostConversationTemplate: async () => {
        throw new Error('NODE_ACCESS_DENIED');
      }
    },
    directory: {
      listManagedResourcePage: async () => {
        throw new Error('MANAGEMENT_QUERY_INVALID');
      }
    },
    users: {
      list: async (query) => {
        if (Object.keys(query).length > 0) throw new ManagementQueryError();
        return { users: database.listUsers() };
      },
      deletionSummary: async () => undefined
    }
  });
  registerWebSearchRoutes({
    app,
    database,
    endpoint: options.webSearchEndpoint ?? process.env['MAR_SEARXNG_URL'] ?? 'http://searxng:8080',
    ...(options.webSearchFetch ? { request: options.webSearchFetch } : {})
  });
  const canManageNode = async (userId: number, nodeId: string) =>
    database.userOwnsNode(userId, nodeId);
  const assertCanManageNode = async (userId: number, nodeId: string) => {
    if (!(await canManageNode(userId, nodeId))) throw new Error('NODE_ACCESS_DENIED');
  };
  registerNodeRegistrationRoute({
    app,
    sessions: database,
    publicOrigin,
    requireDisplayName: false,
    authorize: (userId, ownership) => {
      if (ownership.ownerType !== 'PERSONAL' || ownership.ownerUserId !== userId)
        throw new Error('NODE_ACCESS_DENIED');
    },
    createToken: (userId, ttlMs) => database.createNodeRegistrationToken(userId, ttlMs),
    onError: databaseError
  });
  registerNodeRoutes({
    app,
    database,
    nodeControl,
    nodeUpgrades,
    publicOrigin,
    capabilities: serverWorkbenchCapabilities(serverPackage.version),
    secrets,
    resources: {
      canAccessNodeContainer: canManageNode,
      canManageNode,
      canRegisterWorkspace: canManageNode,
      canManageNodeSecrets: canManageNode,
      assertCanManageNode,
      nodeOwnership: async (nodeId) => {
        const node = database.listNodes().find((candidate) => candidate.id === nodeId);
        if (node === undefined) throw new Error('NODE_NOT_FOUND');
        return { ownerType: 'PERSONAL', ownerUserId: node.ownerUserId };
      }
    },
    mutations: {
      changeNodeOwnership: async () => {
        throw new Error('NODE_ACCESS_DENIED');
      }
    }
  });
  registerWorkspaceRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    resources: personalWorkspacePolicy()
  });
  registerRealtimeRoutes({ app, database, nodeControl, publicOrigin });
  registerSessionRunRoutes({ app, database, nodeControl, secrets, publicOrigin });
  registerRunControlRoutes({
    app,
    database,
    authorizeNodeRequest,
    nodeControl,
    secrets,
    publicOrigin
  });
  registerEnvironmentSecretRoutes({ app, database, secrets, publicOrigin });
  let shutdown: Promise<void> | undefined;
  app.decorate('shutdown', () => {
    shutdown ??= (async () => {
      nodeControl.close();
      app.server.closeAllConnections?.();
      await app.close();
    })();
    return shutdown;
  });
  app.addHook('preClose', async () => {
    nodeControl.close();
  });
  app.addHook('onClose', async () => {
    traffic.close();
    database.close();
  });
  return app;
}
