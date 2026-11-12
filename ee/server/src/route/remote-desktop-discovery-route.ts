import type { FastifyInstance } from 'fastify';
import { remoteDesktopDescriptionSchema } from '@myagentroam/protocol';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import { protectedAdmin, type SessionLookup } from '@myagentroam/server-core/session';
import { requestUserNode } from '@myagentroam/server-core/workspace-http-support';
import { databaseError } from '@myagentroam/server-core/domain-errors';
import { sendError } from '@myagentroam/server-core/http-errors';
import type { NodeControl } from '../node-control.js';
import type { ResourceAccessService } from '../rbac/resource-access-service.js';

/** Discovers one authorized Node's current desktop; the result is not an attachment grant. */
export function registerRemoteDesktopDiscoveryRoute(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly nodeControl: Pick<NodeControl, 'nodeCapabilities' | 'requestNode' | 'listNodes'>;
  readonly resources: Pick<ResourceAccessService, 'canUseNode'>;
  readonly publicOrigin: string | undefined;
}): void {
  const { app, database, nodeControl, resources, publicOrigin } = input;
  app.get<{ Params: { nodeId: string } }>('/api/nodes/:nodeId/desktop', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const user = protectedAdmin(database, request, reply);
    if (user === undefined) return;
    const { nodeId } = request.params;
    try {
      if (!(await resources.canUseNode(user.userId, nodeId)))
        return sendError(reply, 403, 'NODE_ACCESS_DENIED');
      const node = (await nodeControl.listNodes()).find((candidate) => candidate.id === nodeId);
      const nodeName = node?.displayName?.trim() || node?.registeredAddress || undefined;
      const admitted = protectedAdmin(database, request, reply);
      if (admitted === undefined) return;
      if (admitted.userId !== user.userId || admitted.sessionHash !== user.sessionHash)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      const capability = nodeControl.nodeCapabilities(nodeId)?.remoteDesktop;
      if (!capability?.available) return sendError(reply, 409, 'DESKTOP_UNAVAILABLE');
      const raw = await requestUserNode(nodeControl, user, nodeId, 'desktop.describe', {});
      const description = remoteDesktopDescriptionSchema.safeParse(raw);
      const current = protectedAdmin(database, request, reply);
      if (current === undefined) return;
      if (current.userId !== user.userId || current.sessionHash !== user.sessionHash)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!(await resources.canUseNode(user.userId, nodeId)))
        return sendError(reply, 403, 'NODE_ACCESS_DENIED');
      const latest = nodeControl.nodeCapabilities(nodeId)?.remoteDesktop;
      const authorized = protectedAdmin(database, request, reply);
      if (authorized === undefined) return;
      if (authorized.userId !== user.userId || authorized.sessionHash !== user.sessionHash)
        return sendError(reply, 401, 'UNAUTHENTICATED');
      if (!latest?.available || latest.nodeGeneration !== capability.nodeGeneration)
        return sendError(reply, 409, 'DESKTOP_UNAVAILABLE');
      if (!description.success) return sendError(reply, 502, 'DESKTOP_DESCRIPTION_INVALID');
      return reply.send({ capability: latest, description: description.data, nodeName });
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}
