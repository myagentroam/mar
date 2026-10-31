import type { NodeRequestAuthorization } from '../../packages/server-core/src/node-access-contracts.js';
import type { RuntimeCredentialService } from '../../packages/server-core/src/runtime-credential-service.js';
import { createNodeControl } from '../../ee/server/src/composition/node-control-factory.ts';
import type {
  NodeControl,
  NodeControlConsumers,
  NodeControlStore
} from '../../ee/server/src/node-control.js';
import type { ServerTrafficMetrics } from '../../ee/server/src/service/server-traffic-metrics.js';
import { testNodeBrokerServices } from './node-broker-services.ts';

type MutableConsumers = { -readonly [K in keyof NodeControlConsumers]: NodeControlConsumers[K] };
const consumersByControl = new WeakMap<NodeControl, MutableConsumers>();

export function testNodeConsumers(control: NodeControl): MutableConsumers {
  const consumers = consumersByControl.get(control);
  if (consumers === undefined) throw new Error('TEST_NODE_CONSUMERS_MISSING');
  return consumers;
}

export function createTestNodeControl(
  database: NodeControlStore,
  authorize: NodeRequestAuthorization,
  log?: (event: string, fields: Record<string, unknown>) => void,
  traffic?: ServerTrafficMetrics,
  runtimeCredentials?: Pick<
    RuntimeCredentialService,
    'activateNodeConnection' | 'deactivateNodeConnection' | 'resolve'
  >
): NodeControl {
  const consumers: MutableConsumers = {
    authorizeHostedConversation: async () => false,
    notification: async () => false,
    hostedConversationActivity: async () => false,
    recentRuns: async () => false,
    recentRunDisconnected: async () => {},
    sessionGroupChanged: async () => {},
    modelUsage: {
      consume: async () => {
        throw new Error('TEST_USAGE_NOT_CONFIGURED');
      }
    },
    mailNotifications: {
      send: async () => {
        throw new Error('TEST_MAIL_NOT_CONFIGURED');
      }
    },
    notificationChannels: {
      send: async () => {
        throw new Error('TEST_NOTIFICATION_NOT_CONFIGURED');
      }
    },
    scheduleAuthorizer: async () => {
      throw new Error('TEST_SCHEDULE_NOT_CONFIGURED');
    },
    marctlExecutionCredential: async () => {
      throw new Error('TEST_MARCTL_EXECUTION_CREDENTIAL_NOT_CONFIGURED');
    },
    runtimeCredentials: runtimeCredentials ?? {
      activateNodeConnection: () => {},
      deactivateNodeConnection: () => {},
      resolve: async () => {
        throw new Error('TEST_RUNTIME_CREDENTIAL_SERVICE_NOT_CONFIGURED');
      }
    }
  };
  const control = createNodeControl(
    database,
    authorize,
    {
      authorizeHostedConversation: (...args) => consumers.authorizeHostedConversation(...args),
      notification: (...args) => consumers.notification(...args),
      hostedConversationActivity: (...args) => consumers.hostedConversationActivity(...args),
      recentRuns: (...args) => consumers.recentRuns(...args),
      recentRunDisconnected: (...args) => consumers.recentRunDisconnected(...args),
      sessionGroupChanged: (...args) => consumers.sessionGroupChanged(...args),
      modelUsage: { consume: (...args) => consumers.modelUsage.consume(...args) },
      mailNotifications: { send: (...args) => consumers.mailNotifications.send(...args) },
      notificationChannels: { send: (...args) => consumers.notificationChannels.send(...args) },
      scheduleAuthorizer: (...args) => consumers.scheduleAuthorizer(...args),
      marctlExecutionCredential: (...args) => consumers.marctlExecutionCredential(...args),
      runtimeCredentials: consumers.runtimeCredentials
    },
    testNodeBrokerServices(),
    log,
    traffic
  );
  consumersByControl.set(control, consumers);
  return control;
}
