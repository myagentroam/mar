import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BROWSER_DOWNLOAD_CHUNK_BYTES,
  BROWSER_UPLOAD_REQUEST_BYTES,
  browserDownloadPageSchema,
  browserDownloadRequestSchema,
  browserUploadSchema
} from '@myagentroam/protocol';
import { protectedAdmin, validCsrf, type SessionLookup } from '@myagentroam/server-core/session';
import { isAllowedOrigin } from '@myagentroam/server-core/auth';
import {
  errorResponseOptions,
  safePublicError,
  sendError
} from '@myagentroam/server-core/http-errors';
import { fileContentChunks } from '@myagentroam/server-core/file-content-stream';
import type { NodeControl } from '../node-control.js';

const target = z.object({ connectionId: z.string().min(1).max(512) });
const downloadTarget = target.extend({ attachmentId: z.string().uuid() });
const listTarget = downloadTarget.extend({
  offset: z.coerce.number().int().nonnegative().safe(),
  progress: z.literal('1').optional()
});
const fileTarget = downloadTarget.extend({ id: z.string().uuid() });

/** File HTTP adapter. The Browser coordinator authorizes every RPC, including
 * each pull from a device download stream. HTTP owns device delivery only. */
export function registerBrowserFileRoutes(
  routes: FastifyInstance,
  database: SessionLookup,
  origin: string | undefined,
  node: Pick<NodeControl, 'uploadBrowserFile' | 'downloadBrowserFile' | 'openBrowserDownload'>
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

  routes.post(
    '/api/browser/uploads',
    { bodyLimit: BROWSER_UPLOAD_REQUEST_BYTES },
    async (request, reply) => {
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
    }
  );

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
        (action !== 'cancel' && action !== 'delete') ||
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

  routes.get('/api/browser/downloads/file', async (request, reply) => {
    const user = session(request, reply, false);
    if (!user) return;
    const query = fileTarget.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'BROWSER_DOWNLOAD_INVALID');
    const { connectionId, attachmentId, id } = query.data;
    try {
      const { name, size, read } = await node.openBrowserDownload(
        user,
        connectionId,
        attachmentId,
        id
      );
      return reply
        .header('cache-control', 'private, no-store')
        .header('content-type', 'application/octet-stream')
        .header('content-length', size)
        .header('x-content-type-options', 'nosniff')
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16)}`)}`
        )
        .send(Readable.from(fileContentChunks(read, 0, size - 1, BROWSER_DOWNLOAD_CHUNK_BYTES)));
    } catch (error) {
      return fileError(reply, error, 'BROWSER_DOWNLOAD_FAILED');
    }
  });
}

function fileError(reply: FastifyReply, error: unknown, fallback: string) {
  const failure = safePublicError(error, fallback);
  return sendError(
    reply,
    failure.code === 'BROWSER_NOT_AUTHORIZED' || failure.code === 'BROWSER_LEASE_ENDED' ? 403 : 409,
    failure.code,
    errorResponseOptions(failure)
  );
}
