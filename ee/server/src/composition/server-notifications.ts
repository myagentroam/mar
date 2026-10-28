import type { FastifyInstance } from 'fastify';
import type { NodeRequestAuthorization } from '@myagentroam/server-core/node-access-contracts';
import type { RecentRunService } from '@myagentroam/server-core/recent-run-service';
import { WebPushConfiguration } from '@myagentroam/server-core/web-push-configuration';
import { WebPushClients } from '@myagentroam/server-core/web-push-clients';
import {
  WebPushDispatcher,
  type WebPushTransport
} from '@myagentroam/server-core/web-push-dispatcher';
import { registerWebPushRoutes } from '@myagentroam/server-core/web-push-routes';
import { createWebPushTransport } from '@myagentroam/server-core/web-push-transport';
import { loadOrCreateRuntimeCredentialHmacKey } from '@myagentroam/server-core/runtime-credential-service';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { NodeControl } from '../node-control.js';
import { WorkbenchNotificationService } from '../service/workbench-notification-service.js';
import { registerNotificationRoutes } from '../route/notification-routes.js';

/** Compose notification persistence, delivery, and their Node event subscriptions together. */
export function composeServerNotifications(input: {
  app: FastifyInstance;
  database: MysqlServerDatabase;
  nodeControl: NodeControl;
  recentRuns: RecentRunService;
  authorize: NodeRequestAuthorization;
  authorizeHosted: (userId: number, nodeId: string, templateId: string) => Promise<boolean>;
  dataDirectory: string;
  publicOrigin: string | undefined;
  now: () => number;
  transport: WebPushTransport | undefined;
}) {
  const { app, database, nodeControl, recentRuns, authorize, authorizeHosted, now, publicOrigin } =
    input;
  const configuration = new WebPushConfiguration(
    database,
    loadOrCreateRuntimeCredentialHmacKey(input.dataDirectory),
    publicOrigin,
    () => true
  );
  const clients = new WebPushClients(database, now);
  let dispatcher: WebPushDispatcher;
  const notifications = new WorkbenchNotificationService(
    database,
    authorize,
    (userId, message) => nodeControl.pushUserWorkbench(userId, message),
    now,
    authorizeHosted,
    (userId, notification, reauthorize) => dispatcher.enqueue(userId, notification.id, reauthorize)
  );
  dispatcher = new WebPushDispatcher({
    configuration,
    clients,
    online: (userId) => nodeControl.hasUserWorkbenchConnection(userId),
    resolve: (userId, id) => notifications.forPush(userId, id),
    transport: input.transport ?? createWebPushTransport(),
    now,
    report: (code) => app.log.warn({ code }, 'Web Push operation failed')
  });
  registerWebPushRoutes({ app, database, clients, configuration, publicOrigin, now });
  registerNotificationRoutes({ app, database, notifications, recentRuns, publicOrigin });
  return { notifications, configuration, dispatcher };
}
