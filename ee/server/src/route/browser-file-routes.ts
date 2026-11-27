import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  browserDownloadPageSchema,
  browserDownloadRequestSchema,
  browserUploadSchema,
  browserUploadStreamSchema
} from '@myagentroam/protocol';
import { protectedAdmin, validCsrf, type SessionLookup } from '@myagentroam/server-core/session';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import {
  errorResponseOptions,
  safePublicError,
  sendError
} from '@myagentroam/server-core/http-errors';
import { domainErrorStatus } from '@myagentroam/server-core/domain-errors';
import type { NodeControl } from '../node-control.js';

const target = z.object({ connectionId: z.string().min(1).max(512) });
const downloadTarget = target.extend({ attachmentId: z.string().uuid() });
const listTarget = downloadTarget.extend({
  offset: z.coerce.number().int().nonnegative().safe(),
  progress: z.literal('1').optional()
});
const fileTarget = z.strictObject({ attachmentId: z.string().uuid(), id: z.string().uuid() });
const directTarget = z.strictObject({
  ticket: z.string().uuid(),
  kind: z.enum(['browser-file-upload', 'browser-file-download']),
  nodeId: z.string().min(1).max(512),
  transportId: z.string().min(1).max(512)
});
const streamTicket = z.strictObject({ ticket: z.string().uuid() });

/** Browser file controls and admission; device saves carry their bytes on NodeConnection. */
export function registerBrowserFileRoutes(
  routes: FastifyInstance,
  database: SessionLookup,
  origin: string | undefined,
  node: Pick<
    NodeControl,
    | 'uploadBrowserFile'
    | 'downloadBrowserFile'
    | 'createBrowserDownloadTicket'
    | 'createBrowserUploadTicket'
    | 'openBrowserDirectFile'
    | 'closeBrowserDirectFile'
  >
): void {
  function session(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    if (write && !isAllowedOrigin(request, origin)) {
      void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    const user = protectedAdmin(database, request, reply);
    if (!user) return;
    if (write && !validCsrf(request, user)) {
      void sendError(reply, 403, 'CSRF_INVALID');
      return;
    }
    return { userId: user.userId, sessionHash: user.sessionHash };
  }

  routes.post('/api/browser/uploads', async (request, reply) => {
    const user = session(request, reply, true);
    if (!user) return;
    const query = target.safeParse(request.query);
    const parsed = browserUploadSchema.safeParse(request.body);
    if (!query.success || !parsed.success) return sendError(reply, 400, 'BROWSER_UPLOAD_INVALID');
    try {
      await node.uploadBrowserFile(user, query.data.connectionId, parsed.data);
      return reply.send({});
    } catch (error) {
      return fileError(reply, error, 'BROWSER_UPLOAD_FAILED');
    }
  });

  routes.post('/api/browser/uploads/stream-ticket', async (request, reply) => {
    const user = session(request, reply, true);
    if (!user) return;
    const query = target.safeParse(request.query);
    const upload = browserUploadStreamSchema.safeParse(request.body);
    if (!query.success || !upload.success) return sendError(reply, 400, 'BROWSER_UPLOAD_INVALID');
    try {
      return reply
        .header('cache-control', 'private, no-store')
        .send(await node.createBrowserUploadTicket(user, query.data.connectionId, upload.data));
    } catch (error) {
      return fileError(reply, error, 'BROWSER_UPLOAD_FAILED');
    }
  });

  routes.get('/api/browser/downloads', async (request, reply) => {
    const user = session(request, reply, false);
    if (!user) return;
    const query = listTarget.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'BROWSER_DOWNLOAD_INVALID');
    const { connectionId, attachmentId, offset, progress } = query.data;
    try {
      const result = await node.downloadBrowserFile(user, connectionId, {
        attachmentId,
        command: { action: 'list', offset, ...(progress && { progress: true }) }
      });
      return reply
        .header('cache-control', 'private, no-store')
        .send(browserDownloadPageSchema.parse(result));
    } catch (error) {
      return fileError(reply, error, 'BROWSER_DOWNLOAD_FAILED');
    }
  });

  routes.post<{ Params: { action: string } }>(
    '/api/browser/downloads/:action',
    async (request, reply) => {
      const user = session(request, reply, true);
      if (!user) return;
      const { action } = request.params;
      const query = target.safeParse(request.query);
      const body = browserDownloadRequestSchema.safeParse(request.body);
      if (
        !query.success ||
        !body.success ||
        (action !== 'cancel' && action !== 'delete' && action !== 'workspace') ||
        body.data.command.action !== action
      )
        return sendError(reply, 400, 'BROWSER_DOWNLOAD_INVALID');
      try {
        await node.downloadBrowserFile(user, query.data.connectionId, body.data);
        return reply.send({});
      } catch (error) {
        return fileError(reply, error, 'BROWSER_DOWNLOAD_FAILED');
      }
    }
  );

  routes.post('/api/browser/downloads/stream-ticket', async (request, reply) => {
    const user = session(request, reply, true);
    if (!user) return;
    const query = target.safeParse(request.query);
    const body = fileTarget.safeParse(request.body);
    if (!query.success || !body.success) return sendError(reply, 400, 'BROWSER_DOWNLOAD_INVALID');
    const { connectionId } = query.data;
    const { attachmentId, id } = body.data;
    try {
      reply.header('cache-control', 'private, no-store');
      return reply.send(
        await node.createBrowserDownloadTicket(user, connectionId, attachmentId, id)
      );
    } catch (error) {
      return fileError(reply, error, 'BROWSER_DOWNLOAD_FAILED');
    }
  });

  routes.post('/api/browser/direct-file-streams', async (request, reply) => {
    const user = session(request, reply, true);
    if (!user) return;
    const body = directTarget.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'BROWSER_RESOURCE_INVALID');
    const { kind, ticket, nodeId, transportId } = body.data;
    try {
      const result = await node.openBrowserDirectFile(kind, ticket, nodeId, transportId, user);
      return reply.header('cache-control', 'private, no-store').send(result);
    } catch (error) {
      return fileError(reply, error, 'BROWSER_FAILED');
    }
  });

  routes.delete('/api/browser/direct-file-streams', async (request, reply) => {
    const user = session(request, reply, true);
    if (!user) return;
    const params = streamTicket.safeParse(request.body);
    if (!params.success) return sendError(reply, 400, 'BROWSER_RESOURCE_INVALID');
    node.closeBrowserDirectFile(params.data.ticket, user);
    return reply.code(204).send();
  });
}

function fileError(reply: FastifyReply, error: unknown, fallback: string) {
  const failure = safePublicError(error, fallback);
  return sendError(
    reply,
    failure.code === 'BROWSER_OUTCOME_UNKNOWN'
      ? 504
      : failure.code === 'BROWSER_NOT_AUTHORIZED' || failure.code === 'BROWSER_LEASE_ENDED'
        ? 403
        : failure.code === 'FILE_RELAY_BUSY' ||
            failure.code === 'FILE_RELAY_UNAVAILABLE' ||
            failure.code === 'NODE_RESPONSE_INVALID'
          ? domainErrorStatus(failure.code)
          : 409,
    failure.code,
    errorResponseOptions(failure)
  );
}
