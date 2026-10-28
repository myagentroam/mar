import type { NodeRequestAuthorization } from '@myagentroam/server-core/node-access-contracts';
import { NodeControl, type NodeControlConsumers, type NodeControlStore } from '../node-control.js';
import { NodeRequestBroker } from '../service/node-request-broker.js';
import type { ServerTrafficMetrics } from '../service/server-traffic-metrics.js';
import type { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import type { GitExecutionForwarding } from '@myagentroam/server-core/git-execution-forwarding';
import { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import { TerminalRelayService } from '@myagentroam/server-core/terminal-relay-service';
import { WorkbenchRelayService } from '@myagentroam/server-core/workbench-relay-service';
import { NodeMessageProjector } from '@myagentroam/server-core/node-message-projector';

/** Compose the connection owner with its request, relay, projection and transfer owners. */
export function createNodeControl(
  database: NodeControlStore,
  authorize: NodeRequestAuthorization,
  consumers: NodeControlConsumers,
  brokerServices: {
    readonly usageGrants: Pick<ModelUsageGrants, 'issue'>;
    readonly gitForwarding: Pick<GitExecutionForwarding, 'prepare'>;
  },
  log?: (event: string, fields: Record<string, unknown>) => void,
  traffic?: ServerTrafficMetrics
): NodeControl {
  return new NodeControl(
    database,
    (transport) => {
      const constructed: Array<() => void> = [];
      try {
        const requestBroker = new NodeRequestBroker(
          database,
          authorize,
          transport.socketFor,
          { allows: transport.allows, encode: transport.encode },
          brokerServices,
          log,
          traffic
        );
        constructed.push(() => requestBroker.close());
        const workbenchRelay = new WorkbenchRelayService({
          authorizeNodeRequest: authorize,
          authorizeHostedConversation: consumers.authorizeHostedConversation,
          ...(traffic === undefined ? {} : { traffic })
        });
        constructed.push(() => workbenchRelay.close());
        const directTransfers = new DirectTransferCoordinator({
          audits: database,
          authorize: async (userId, nodeId, workspaceId) => {
            if (transport.capabilities(nodeId)?.workspaceDirectTransfer === undefined) return false;
            return authorize(
              userId,
              nodeId,
              'workspace.direct-transfer',
              workspaceId === undefined ? {} : { workspaceId },
              workspaceId
            );
          },
          sendNode: transport.sendNode,
          sendBrowser: (connectionId, message) =>
            workbenchRelay.sendDirectConnection(connectionId, message)
        });
        constructed.push(() => directTransfers.close());
        workbenchRelay.setDirectTransferHandler({
          message: (identity, message) => directTransfers.handleBrowserMessage(identity, message),
          disconnected: (connectionId) => directTransfers.connectionDisconnected(connectionId),
          resumed: (connectionId) => directTransfers.connectionResumed(connectionId),
          revoked: (connectionId, code) => directTransfers.revokeConnection(connectionId, code)
        });
        const terminalRelay = new TerminalRelayService({
          database,
          authorizeNodeRequest: authorize,
          ...(traffic === undefined ? {} : { traffic }),
          requestNode: transport.request
        });
        constructed.push(() => terminalRelay.close());
        const terminalDirect = new TerminalDirectCoordinator({
          transport: directTransfers,
          authorize: async (userId, nodeId, workspaceId) => {
            if (transport.capabilities(nodeId)?.terminalDirect?.apiVersion !== 1) return false;
            return authorize(userId, nodeId, 'terminal.attach.authorize', {}, workspaceId);
          },
          preflight: async (nodeId, terminalId, workspaceId, identity) => {
            await transport.request(
              nodeId,
              'terminal.direct.preflight',
              { terminalId, ...(workspaceId === undefined ? {} : { workspaceId }) },
              {
                userId: identity.userId,
                sessionHash: identity.sessionHash,
                ...(workspaceId === undefined ? {} : { workspaceId })
              }
            );
          },
          sendNode: (nodeId, message) => transport.sendNode(nodeId, message.type, message),
          sendBrowser: (connectionId, message) =>
            workbenchRelay.sendDirectConnection(connectionId, message),
          relayCount: (sessionHash) => terminalRelay.countSession(sessionHash)
        });
        constructed.push(() => terminalDirect.close());
        terminalRelay.setDirectCoordination({
          directCount: (sessionHash) => terminalDirect.sessionCount(sessionHash)
        });
        workbenchRelay.setTerminalDirectHandler({
          message: (identity, message) => terminalDirect.handleBrowser(identity, message),
          revoked: (connectionId, code) => terminalDirect.revokeConnection(connectionId, code)
        });
        const messageProjector = new NodeMessageProjector({
          sessionGroupChanged: (change) => consumers.sessionGroupChanged(change),
          relay: workbenchRelay,
          notification: (nodeId, payload) => consumers.notification(nodeId, payload),
          hostedConversationActivity: (nodeId, payload) =>
            consumers.hostedConversationActivity(nodeId, payload),
          recentRuns: (nodeId, payload) => consumers.recentRuns(nodeId, payload),
          sendWatchEvent: (connectionId, message) =>
            workbenchRelay.sendConnection(connectionId, { type: 'watch.event', event: message }),
          send: transport.send,
          sendInvalid: transport.sendInvalid,
          ...(log === undefined ? {} : { log })
        });
        return {
          requestBroker,
          workbenchRelay,
          directTransfers,
          terminalRelay,
          terminalDirect,
          messageProjector
        };
      } catch (error) {
        const errors: unknown[] = [error];
        for (const close of constructed.reverse()) {
          try {
            close();
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        if (errors.length > 1)
          throw new AggregateError(errors, 'Failed to construct Node relay components', {
            cause: error
          });
        throw error;
      }
    },
    consumers,
    traffic
  );
}
