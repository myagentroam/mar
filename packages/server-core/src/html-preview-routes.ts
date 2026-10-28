import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin, parseCookies, SESSION_COOKIE_NAME } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError, safeErrorCode } from './http-errors.js';
import type { WorkspaceNodeControl } from './workspace-route-contracts.js';
import {
  fileContentChunks,
  fileContentType,
  parseHttpByteRange,
  sendFileContentHead
} from './file-content-stream.js';
import { isSafeResourceText } from './workspace-http-support.js';
import type { HtmlPreviewOrigin } from './html-preview-origin.js';
import type { SessionShares } from './session-shares.js';
import type { UserNodeAuthorization } from './node-access-contracts.js';
import { SESSION_SHARE_COOKIE } from './session-share-routes.js';

const GRANT_LIFETIME_MS = 30 * 60 * 1000;
const CHUNK_BYTES = 512 * 1024;

interface Grant {
  readonly authorization:
    | { readonly kind: 'ACCOUNT'; readonly sessionId: string }
    | { readonly kind: 'SHARE'; readonly shareId: string };
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly directory: string;
  readonly origin: string;
  readonly expiresAt: number;
}

export function htmlPreviewResourcePath(directory: string, resource: string): string | undefined {
  if (
    resource.length === 0 ||
    resource.length > 4096 ||
    resource.includes('\\') ||
    resource.includes('\0') ||
    resource.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return undefined;
  return directory === '' ? resource : `${directory}/${resource}`;
}

function previewDocumentPath(path: unknown): { directory: string; name: string } | undefined {
  if (!isSafeResourceText(path) || !/\.html?$/iu.test(path)) return undefined;
  if (htmlPreviewResourcePath('', path) === undefined) return undefined;
  const parts = path.split('/');
  return { directory: parts.slice(0, -1).join('/'), name: parts.at(-1)! };
}

function resourceContentType(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return (
    {
      html: 'text/html; charset=utf-8',
      htm: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      wasm: 'application/wasm'
    }[extension ?? ''] ?? fileContentType(path)
  );
}

export function registerHtmlPreviewRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly nodeControl: WorkspaceNodeControl;
  readonly originSetting: Pick<HtmlPreviewOrigin, 'read'>;
  readonly publicOrigin: string | undefined;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly shares?: SessionShares;
}): void {
  const { app, database, nodeControl, originSetting, publicOrigin, databaseError } = input;
  const grants = new Map<string, Grant>();
  async function grantActor(grant: Grant): Promise<UserNodeAuthorization> {
    if (grant.authorization.kind === 'SHARE') {
      if (input.shares === undefined) throw new Error('SESSION_SHARE_NOT_FOUND');
      return (await input.shares.resolvePreview(grant.authorization.shareId)).context.user;
    }
    const actor = database.findCurrentUserSession(grant.authorization.sessionId);
    if (actor === undefined || actor.mustChangePassword) throw new Error('UNAUTHENTICATED');
    return { userId: actor.userId, sessionHash: actor.sessionHash };
  }
  async function createGrant(
    request: FastifyRequest,
    reply: FastifyReply,
    actor: UserNodeAuthorization,
    authorization: Grant['authorization'],
    nodeId: string,
    workspaceId: string,
    path: string
  ) {
    const document = previewDocumentPath(path);
    if (document === undefined) return sendError(reply, 400, 'FILE_RANGE_INVALID');
    const authorized = (await nodeControl.requestNode(
      nodeId,
      'workspace.file.content.read',
      { workspaceId, path, previewDirectory: document.directory, offset: 0, limit: 1 },
      { userId: actor.userId, sessionHash: actor.sessionHash, workspaceId }
    )) as { previewBoundaryVerified?: unknown };
    if (authorized.previewBoundaryVerified !== true) throw new Error('FILE_PREVIEW_UNAVAILABLE');
    const configured = await originSetting.read();
    if (configured !== '' && publicOrigin === undefined)
      throw new Error('HTML_PREVIEW_ORIGIN_INVALID');
    const origin = configured || publicOrigin || `${request.protocol}://${request.headers.host}`;
    for (const [key, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(key);
    const ticket = randomBytes(32).toString('hex');
    grants.set(ticket, {
      authorization,
      nodeId,
      workspaceId,
      directory: document.directory,
      origin,
      expiresAt: Date.now() + GRANT_LIFETIME_MS
    });
    return reply.header('cache-control', 'private, no-store').send({
      url: `${origin}/api/html-preview/grants/${ticket}/files/${encodeURIComponent(document.name)}`
    });
  }
  if (input.shares !== undefined)
    app.post<{ Params: { shareId: string }; Body: { path?: unknown } }>(
      '/api/session-shares/:shareId/html-preview/grants',
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        if (!isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        try {
          const { context } = await input.shares!.resolve(
            request.params.shareId,
            parseCookies(request)[SESSION_SHARE_COOKIE]
          );
          if (typeof request.body?.path !== 'string')
            return sendError(reply, 400, 'FILE_RANGE_INVALID');
          return await createGrant(
            request,
            reply,
            context.user,
            { kind: 'SHARE', shareId: request.params.shareId },
            context.nodeId,
            context.workspaceId,
            request.body.path
          );
        } catch (error) {
          return databaseError(reply, error);
        }
      }
    );
  app.addHook('onRequest', async (request, reply) => {
    let configured: string;
    try {
      configured = await originSetting.read();
    } catch {
      // Keep the management route reachable so an invalid stored value can be corrected.
      return;
    }
    if (configured === '' || publicOrigin === undefined) return;
    if (new URL(configured).hostname === new URL(publicOrigin).hostname) return;
    const previewHost = new URL(configured).host;
    const requestedHost = request.headers.host;
    if (
      requestedHost === undefined ||
      new URL(`${new URL(configured).protocol}//${requestedHost}`).host !== previewHost
    )
      return;
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      !/^\/api\/html-preview\/grants\/[a-f0-9]{64}\/files\/[^?]+(?:\?|$)/u.test(request.url)
    )
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
  });
  app.post<{ Body: { nodeId?: unknown; workspaceId?: unknown; path?: unknown } }>(
    '/api/html-preview/grants',
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      if (!validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
      const { nodeId, workspaceId, path } = request.body ?? {};
      const document = previewDocumentPath(path);
      if (document === undefined || !isSafeResourceText(nodeId) || !isSafeResourceText(workspaceId))
        return sendError(reply, 400, 'FILE_RANGE_INVALID');
      try {
        const sessionId = parseCookies(request)[SESSION_COOKIE_NAME];
        if (sessionId === undefined) return sendError(reply, 401, 'UNAUTHENTICATED');
        return await createGrant(
          request,
          reply,
          actor,
          { kind: 'ACCOUNT', sessionId },
          nodeId,
          workspaceId,
          path as string
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { ticket: string; '*': string } }>(
    '/api/html-preview/grants/:ticket/files/*',
    async (request, reply) => {
      const grant = grants.get(request.params.ticket);
      if (grant === undefined || grant.expiresAt <= Date.now()) {
        grants.delete(request.params.ticket);
        return sendError(reply, 403, 'FILE_PREVIEW_UNAVAILABLE');
      }
      try {
        await grantActor(grant);
        const currentOrigin = await originSetting.read();
        if (
          grant.origin !==
            (currentOrigin || publicOrigin || `${request.protocol}://${request.headers.host}`) ||
          new URL(grant.origin).host !==
            new URL(`${new URL(grant.origin).protocol}//${request.headers.host}`).host
        )
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const path = htmlPreviewResourcePath(grant.directory, request.params['*']);
        if (path === undefined) return sendError(reply, 400, 'FILE_RANGE_INVALID');
        const read = async (offset: number, limit: number) => {
          const current = await grantActor(grant);
          const response = (await nodeControl.requestNode(
            grant.nodeId,
            'workspace.file.content.read',
            {
              workspaceId: grant.workspaceId,
              path,
              previewDirectory: grant.directory,
              offset,
              limit
            },
            { ...current, workspaceId: grant.workspaceId }
          )) as {
            previewBoundaryVerified?: unknown;
            file?: { size: number; offset: number; contentBase64: string };
          };
          if (
            response.previewBoundaryVerified !== true ||
            !Number.isSafeInteger(response.file?.size) ||
            !Number.isSafeInteger(response.file?.offset) ||
            typeof response.file?.contentBase64 !== 'string'
          )
            throw new Error('NODE_RESPONSE_INVALID');
          return response.file!;
        };
        const first = await read(0, 1);
        const range = parseHttpByteRange(request.headers.range, first.size);
        if (range === null) return sendError(reply, 416, 'FILE_RANGE_INVALID');
        const start = range?.start ?? 0;
        const end = range?.end ?? first.size - 1;
        const length = first.size === 0 ? 0 : end - start + 1;
        const contentType = resourceContentType(path);
        reply
          .header('content-type', contentType)
          .header('cache-control', 'private, no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff')
          .header('accept-ranges', 'bytes')
          .header('content-disposition', 'inline');
        if (contentType.startsWith('text/html'))
          reply.header(
            'content-security-policy',
            "sandbox allow-scripts allow-same-origin; base-uri 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"
          );
        else if (contentType === 'image/svg+xml')
          reply.header('content-security-policy', 'sandbox');
        if (range !== undefined && first.size > 0)
          reply.code(206).header('content-range', `bytes ${start}-${end}/${first.size}`);
        if (request.method === 'HEAD') return sendFileContentHead(reply, length);
        return reply
          .header('content-length', String(length))
          .send(Readable.from(fileContentChunks(read, start, end, CHUNK_BYTES)));
      } catch (error) {
        if (safeErrorCode(error) === 'UNAUTHENTICATED')
          return sendError(reply, 401, 'UNAUTHENTICATED');
        return databaseError(reply, error);
      }
    }
  );
}
