import type { NodeRequestAuthorization } from '@myagentroam/server-core/node-access-contracts';
import { NodeControl, type NodeControlConsumers, type NodeControlStore } from '../node-control.js';
import { NodeRequestBroker } from '../service/node-request-broker.js';
import type { ServerTrafficMetrics } from '../service/server-traffic-metrics.js';
import type { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import type { GitExecutionForwarding } from '@myagentroam/server-core/git-execution-forwarding';
import { DirectTransferCoordinator } from '@myagentroam/server-core/direct-transfer-coordinator';
import { TerminalDirectCoordinator } from '@myagentroam/server-core/terminal-direct-coordinator';
import { RemoteDesktopAdmission } from '@myagentroam/server-core/remote-desktop-admission';
import { RemoteDesktopDirectCoordinator } from '@myagentroam/server-core/remote-desktop-direct-coordinator';
import { RemoteDesktopRelayCoordinator } from '@myagentroam/server-core/remote-desktop-relay-coordinator';
import { RemoteDesktopRelayPairing } from '@myagentroam/server-core/remote-desktop-relay-pairing';
import { RemoteDesktopRelaySockets } from '@myagentroam/server-core/remote-desktop-relay-sockets';
import { remoteDesktopDescriptionSchema } from '@myagentroam/protocol';
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
          { allows: transport.allows },
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
          authorizeTransport: async (userId, nodeId) => {
            const capabilities = transport.capabilities(nodeId);
            if (
              capabilities?.workspaceDirectTransfer !== undefined &&
              (await authorize(userId, nodeId, 'workspace.direct-transfer', {}))
            )
              return true;
            const desktop = capabilities?.remoteDesktop;
            return (
              !!desktop?.available &&
              desktop.transports.includes('DIRECT') &&
              (await authorize(userId, nodeId, 'desktop.describe', {}))
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
        const desktopAdmission = new RemoteDesktopAdmission();
        const desktopAuthorize = async (
          userId: number,
          nodeId: string,
          mode: 'VIEW' | 'CONTROL',
          path: 'DIRECT' | 'RELAY'
        ) => {
          const capability = transport.capabilities(nodeId)?.remoteDesktop;
          if (
            !capability?.available ||
            !capability.transports.includes(path) ||
            (mode === 'CONTROL' && !capability.supportsControl)
          )
            return false;
          return authorize(userId, nodeId, 'desktop.describe', {});
        };
        const desktopPreflight = async (
          request: {
            nodeId: string;
            nodeGeneration: string;
            desktopGeneration: string;
            topologyRevision: number;
            mode: 'VIEW' | 'CONTROL';
          },
          identity: { userId: number; sessionHash: string },
          signal: AbortSignal,
          path: 'DIRECT' | 'RELAY'
        ) => {
          const capability = transport.capabilities(request.nodeId)?.remoteDesktop;
          if (
            !capability?.available ||
            capability.nodeGeneration !== request.nodeGeneration ||
            !capability.transports.includes(path) ||
            (request.mode === 'CONTROL' && !capability.supportsControl)
          )
            throw new Error('Desktop unavailable');
          const raw = await transport.request(
            request.nodeId,
            'desktop.describe',
            { desktopGeneration: request.desktopGeneration },
            { userId: identity.userId, sessionHash: identity.sessionHash },
            15_000,
            signal
          );
          const description = remoteDesktopDescriptionSchema.parse(raw);
          const current = transport.capabilities(request.nodeId)?.remoteDesktop;
          if (
            !current?.available ||
            current.nodeGeneration !== request.nodeGeneration ||
            !current.transports.includes(path) ||
            (request.mode === 'CONTROL' && !current.supportsControl)
          )
            throw new Error('Desktop unavailable');
          if (
            description.desktopGeneration !== request.desktopGeneration ||
            description.topologyRevision !== request.topologyRevision
          )
            throw new Error('Desktop topology changed');
        };
        const desktopDirect = new RemoteDesktopDirectCoordinator({
          admission: desktopAdmission,
          transport: directTransfers,
          authorize: (userId, nodeId, mode) => desktopAuthorize(userId, nodeId, mode, 'DIRECT'),
          preflight: (request, identity, signal) =>
            desktopPreflight(request, identity, signal, 'DIRECT'),
          sendNode: (nodeId, message) => transport.sendNode(nodeId, message.type, message),
          sendBrowser: (connectionId, message) =>
            workbenchRelay.sendDirectConnection(connectionId, message)
        });
        constructed.push(() => desktopDirect.close());
        let desktopRelay!: RemoteDesktopRelayCoordinator;
        const desktopPairing = new RemoteDesktopRelayPairing({
          admission: desktopAdmission,
          maxFrameBytes: 16_384,
          maxInFlightBytes: 1_048_576,
          onClosed: (id) => desktopRelay.pairingClosed(id)
        });
        constructed.push(() => desktopPairing.close());
        desktopRelay = new RemoteDesktopRelayCoordinator({
          admission: desktopAdmission,
          pairing: desktopPairing,
          authorize: (userId, nodeId, mode) => desktopAuthorize(userId, nodeId, mode, 'RELAY'),
          preflight: (request, identity, signal) =>
            desktopPreflight(request, identity, signal, 'RELAY'),
          sendNode: (nodeId, message) => transport.sendNode(nodeId, message.type, message),
          sendBrowser: (connectionId, message) =>
            workbenchRelay.sendDirectConnection(connectionId, message)
        });
        constructed.push(() => desktopRelay.close());
        const desktopRelaySockets = new RemoteDesktopRelaySockets({
          pairing: desktopPairing,
          ownsPage: (identity, id) => workbenchRelay.ownsConnection(identity.sessionHash, id),
          authenticateNode: async (id, credential) => database.authenticateNode(id, credential),
          currentNodeGeneration: (id) => transport.capabilities(id)?.remoteDesktop?.nodeGeneration
        });
        constructed.push(() => desktopRelaySockets.close());
        workbenchRelay.setDesktopDirectHandler({
          message: (identity, message) =>
            message.type === 'desktop.ready' &&
            desktopAdmission.get(message.attachmentId)?.path === 'RELAY'
              ? desktopRelay.handleBrowser(identity, message)
              : desktopDirect.handleBrowser(identity, message),
          revoked: (connectionId, code) => desktopDirect.revokeConnection(connectionId, code)
        });
        workbenchRelay.setDesktopRelayHandler({
          message: (identity, message) => desktopRelay.handleBrowser(identity, message),
          revoked: (connectionId) => desktopRelay.revokeConnection(connectionId)
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
          desktopDirect,
          desktopRelay,
          desktopPairing,
          desktopRelaySockets,
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
