import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  workspaceGitSettingsSchema,
  workspaceFileReferenceSchema,
  workspaceSymbolDefinitionSchema,
  workspaceSymbolIndexPreparationSchema
} from '@myagentroam/protocol';
import { Readable } from 'node:stream';
import { resourceOwnershipSchema } from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import type { CurrentUserSession, SessionLookup } from './session.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError, safePublicError, errorResponseOptions } from './http-errors.js';
import type {
  WorkspaceNodeControl as NodeControl,
  WorkspaceResourcePolicy as ResourceAccessService
} from './workspace-route-contracts.js';
import { normalizeWorkspaceGroupName } from './workspace-group.js';
import {
  sendWorkspaceFileContent,
  fileContentChunks,
  fileContentType,
  parseHttpByteRange,
  sendFileContentHead,
  type FileContentChunk
} from './file-content-stream.js';
import {
  isNonEmptyString,
  isPlainObject,
  isSafeResourceText,
  isUuid,
  parseBoundedInteger,
  parseFileRange,
  parseResourcePage,
  requestUserNode
} from './workspace-http-support.js';

const WORKSPACE_UPLOAD_CHUNK_BYTES = 512 * 1024;
const FILE_CONTENT_CHUNK_BYTES = 512 * 1024;
const FILE_CONTENT_FULL_LIMIT = 20 * 1024 * 1024;
const FILE_WRITE_LIMIT = 8 * 1024 * 1024;

export function registerWorkspaceRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
  readonly nodeControl: NodeControl;
  readonly publicOrigin: string | undefined;
  readonly resources?: ResourceAccessService;
}): void {
  const { app, database, nodeControl, publicOrigin, resources, databaseError } = input;
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: WORKSPACE_UPLOAD_CHUNK_BYTES },
    (_request, body, done) => done(null, body)
  );
  app.get<{ Querystring: { nodeId?: string } }>('/api/workspaces', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0) {
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    }
    try {
      const result = (await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'workspace.list',
        {}
      )) as { workspaces?: unknown };
      if (resources === undefined) return reply.send(result);
      if (!Array.isArray(result.workspaces)) throw new Error('WORKSPACE_LIST_INVALID');
      const workspaces = result.workspaces.filter(
        (workspace): workspace is { id: string } & Record<string, unknown> =>
          typeof workspace === 'object' &&
          workspace !== null &&
          typeof (workspace as { id?: unknown }).id === 'string'
      );
      if (workspaces.length !== result.workspaces.length) throw new Error('WORKSPACE_LIST_INVALID');
      return reply.send({
        ...result,
        workspaces: await resources.projectNodeWorkspaces(
          admin.userId,
          request.query.nodeId,
          workspaces
        )
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Querystring: { nodeId?: string; path?: string } }>(
    '/api/workspace-directories',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      if (request.query.path !== undefined && !isSafeResourceText(request.query.path))
        return sendError(reply, 400, 'WORKSPACE_DIRECTORY_INVALID');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.directories.list',
            {
              ...(request.query.path === undefined ? {} : { path: request.query.path })
            }
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Body: {
      nodeId?: unknown;
      path?: unknown;
      createDirectoryName?: unknown;
      preserveGitConfig?: unknown;
      ownership?: unknown;
    };
  }>('/api/workspaces', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const nodeId = request.body?.nodeId;
    const path = request.body?.path;
    const createDirectoryName = request.body?.createDirectoryName;
    const preserveGitConfig = request.body?.preserveGitConfig;
    if (preserveGitConfig !== undefined && typeof preserveGitConfig !== 'boolean')
      return sendError(reply, 400, 'GIT_CONFIGURATION_INVALID');
    const normalizedDirectoryName =
      typeof createDirectoryName === 'string' ? createDirectoryName.trim() : undefined;
    if (typeof nodeId !== 'string' || typeof path !== 'string' || path.length === 0) {
      return sendError(reply, 400, 'WORKSPACE_INVALID');
    }
    if (
      createDirectoryName !== undefined &&
      (normalizedDirectoryName === undefined ||
        normalizedDirectoryName.length === 0 ||
        normalizedDirectoryName.length > 255 ||
        normalizedDirectoryName === '.' ||
        normalizedDirectoryName === '..' ||
        /[\\/\0]/u.test(normalizedDirectoryName) ||
        !isSafeResourceText(normalizedDirectoryName))
    )
      return sendError(reply, 400, 'WORKSPACE_DIRECTORY_NAME_INVALID');
    const requestedOwnership =
      request.body?.ownership === undefined
        ? undefined
        : resourceOwnershipSchema.safeParse(request.body.ownership).data;
    if (request.body?.ownership !== undefined && requestedOwnership === undefined)
      return sendError(reply, 400, 'RESOURCE_OWNERSHIP_INVALID');
    try {
      const ownership =
        resources === undefined
          ? (requestedOwnership ?? { ownerType: 'PERSONAL' as const, ownerUserId: admin.userId })
          : await resources.resolveWorkspaceOwnership(admin.userId, nodeId, requestedOwnership);
      const result = (await requestUserNode(nodeControl, admin, nodeId, 'workspace.register', {
        path,
        ...(preserveGitConfig === undefined ? {} : { preserveGitConfig }),
        ...(normalizedDirectoryName === undefined
          ? {}
          : { createDirectoryName: normalizedDirectoryName })
      })) as { workspace?: { id?: unknown; path?: unknown } };
      const workspaceId = result.workspace?.id;
      if (typeof workspaceId !== 'string') throw new Error('WORKSPACE_REGISTER_RESPONSE_INVALID');
      const workspacePath = result.workspace?.['path'];
      const displayName =
        typeof workspacePath === 'string'
          ? (workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspaceId)
          : workspaceId;
      if (resources !== undefined)
        await resources.registerWorkspace(
          admin.userId,
          nodeId,
          workspaceId,
          ownership,
          displayName
        );
      return reply.code(201).send(result);
    } catch (error) {
      const failure = safePublicError(error, 'WORKSPACE_INVALID');
      return sendError(
        reply,
        failure.code === 'NODE_OFFLINE' ? 409 : 400,
        failure.code,
        errorResponseOptions(failure)
      );
    }
  });

  app.delete<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string };
  }>('/api/workspaces/:workspaceId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (typeof request.query.nodeId !== 'string' || request.query.nodeId.length === 0)
      return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      if (resources !== undefined)
        await resources.assertCanUnregisterWorkspace(
          admin.userId,
          request.query.nodeId,
          request.params.workspaceId
        );
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'workspace.remove',
        { workspaceId: request.params.workspaceId }
      );
      if (resources !== undefined)
        await resources.unregisterWorkspace(
          admin.userId,
          request.query.nodeId,
          request.params.workspaceId
        );
      return reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.patch<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string };
    Body: { ownership?: unknown; displayName?: unknown; groupName?: unknown };
  }>('/api/workspaces/:workspaceId', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    const ownership =
      request.body?.ownership === undefined
        ? undefined
        : resourceOwnershipSchema.safeParse(request.body.ownership).data;
    const displayName = request.body?.displayName;
    const groupName = request.body?.groupName;
    if (
      (ownership === undefined && displayName === undefined && groupName === undefined) ||
      (request.body?.ownership !== undefined && ownership === undefined) ||
      (displayName !== undefined &&
        (typeof displayName !== 'string' ||
          displayName.trim().length === 0 ||
          displayName.trim().length > 255))
    )
      return sendError(reply, 400, 'RESOURCE_OWNERSHIP_INVALID');
    if (resources === undefined) return sendError(reply, 400, 'RESOURCE_OWNERSHIP_UNAVAILABLE');
    let normalizedGroupName: string | null | undefined;
    try {
      if (groupName !== undefined && groupName !== null && typeof groupName !== 'string')
        throw new Error('WORKSPACE_GROUP_NAME_INVALID');
      normalizedGroupName =
        groupName === undefined ? undefined : normalizeWorkspaceGroupName(groupName ?? null);
    } catch {
      return sendError(reply, 400, 'WORKSPACE_GROUP_NAME_INVALID');
    }
    try {
      if (normalizedGroupName !== undefined) {
        if (ownership !== undefined || displayName !== undefined)
          return sendError(reply, 400, 'WORKSPACE_GROUP_UPDATE_MIXED');
        await resources.updateWorkspaceGroupName(
          admin.userId,
          request.query.nodeId,
          request.params.workspaceId,
          normalizedGroupName
        );
        return reply.send({ groupName: normalizedGroupName });
      }
      await resources.updateWorkspace(
        admin.userId,
        request.query.nodeId,
        request.params.workspaceId,
        {
          ...(ownership === undefined ? {} : { ownership }),
          ...(displayName === undefined ? {} : { displayName: displayName.trim() })
        }
      );
      await nodeControl.revalidateTerminalAuthorizations();
      return reply.send({
        ...(ownership === undefined ? {} : { ownership }),
        ...(displayName === undefined ? {} : { displayName: displayName.trim() })
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  for (const method of ['GET', 'PUT'] as const) {
    app.route<{ Params: { workspaceId: string }; Querystring: { nodeId?: string }; Body: unknown }>(
      {
        method,
        url: '/api/workspaces/:workspaceId/git-policy',
        handler: async (request, reply) => {
          if (method === 'PUT' && !isAllowedOrigin(request, publicOrigin))
            return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
          const actor = protectedAdmin(database, request, reply);
          if (actor === undefined) return;
          if (method === 'PUT' && !validCsrf(request, actor))
            return sendError(reply, 403, 'CSRF_INVALID');
          if (!isNonEmptyString(request.query.nodeId))
            return sendError(reply, 400, 'NODE_ID_REQUIRED');
          const policy =
            method === 'PUT' ? workspaceGitSettingsSchema.safeParse(request.body) : undefined;
          if (policy !== undefined && !policy.success)
            return sendError(reply, 400, 'GIT_CONFIGURATION_INVALID');
          try {
            if (method === 'PUT' && resources !== undefined)
              await resources.assertCanManageWorkspace(
                actor.userId,
                request.query.nodeId,
                request.params.workspaceId
              );
            reply.header('cache-control', 'no-store');
            return reply.send(
              await requestUserNode(
                nodeControl,
                actor,
                request.query.nodeId,
                method === 'PUT' ? 'workspace.git.settings.update' : 'workspace.git.settings.get',
                { workspaceId: request.params.workspaceId, ...(policy?.success ? policy.data : {}) }
              )
            );
          } catch (error) {
            return databaseError(reply, error);
          }
        }
      }
    );
  }

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; from?: string; to?: string };
  }>('/api/workspaces/:workspaceId/diff', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (
      typeof request.query.nodeId !== 'string' ||
      typeof request.query.from !== 'string' ||
      typeof request.query.to !== 'string'
    ) {
      return sendError(reply, 400, 'GIT_DIFF_INVALID');
    }
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.diff', {
          workspaceId: request.params.workspaceId,
          fromRef: request.query.from,
          toRef: request.query.to
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; path?: string; cursor?: string; limit?: string };
  }>('/api/workspaces/:workspaceId/files', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    const page = parseResourcePage(request.query);
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (
      page === undefined ||
      (request.query.path !== undefined && !isSafeResourceText(request.query.path))
    )
      return sendError(reply, 400, 'DIRECTORY_CURSOR_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.files.list', {
          workspaceId: request.params.workspaceId,
          ...(request.query.path === undefined ? {} : { path: request.query.path }),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          ...(page.limit === undefined ? {} : { limit: page.limit })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      workbenchConnectionId?: unknown;
      watchId?: unknown;
      mode?: unknown;
      prepareFiles?: unknown;
      topics?: unknown;
    };
  }>('/api/workspaces/:workspaceId/watch', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.workbenchConnectionId) ||
      !nodeControl.ownsWorkbenchConnection(admin.sessionHash, body.workbenchConnectionId) ||
      typeof body.watchId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(body.watchId) ||
      (body.mode !== 'initial' && body.mode !== 'renew') ||
      (body.mode === 'initial' && !isPlainObject(body.topics)) ||
      (body.prepareFiles !== undefined && (body.mode !== 'initial' || body.prepareFiles !== true))
    )
      return sendError(reply, 400, 'WORKSPACE_WATCH_INVALID');
    request.log.info(
      {
        event: 'workspace.watch.requested',
        workspaceId: request.params.workspaceId,
        nodeId: request.body.nodeId,
        workbenchConnectionId: request.body.workbenchConnectionId,
        watchId: request.body.watchId,
        mode: request.body.mode
      },
      'workspace_watch_requested'
    );
    try {
      const result = await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.watch', {
        workspaceId: request.params.workspaceId,
        workbenchConnectionId: body.workbenchConnectionId,
        watchId: body.watchId,
        mode: body.mode,
        ...(body.mode === 'initial'
          ? { topics: body.topics, ...(body.prepareFiles === true ? { prepareFiles: true } : {}) }
          : {})
      });
      return body.mode === 'renew' ? reply.code(204).send() : reply.send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.delete<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; workbenchConnectionId?: unknown; watchId?: unknown };
  }>('/api/workspaces/:workspaceId/watch', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      !isNonEmptyString(body.workbenchConnectionId) ||
      !nodeControl.ownsWorkbenchConnection(admin.sessionHash, body.workbenchConnectionId) ||
      typeof body.watchId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(body.watchId)
    )
      return sendError(reply, 400, 'WORKSPACE_WATCH_INVALID');
    request.log.info(
      {
        event: 'workspace.watch.requested',
        workspaceId: request.params.workspaceId,
        nodeId: request.body.nodeId,
        workbenchConnectionId: request.body.workbenchConnectionId,
        watchId: request.body.watchId,
        mode: 'stop'
      },
      'workspace_watch_requested'
    );
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.unwatch', {
          workspaceId: request.params.workspaceId,
          workbenchConnectionId: body.workbenchConnectionId,
          watchId: body.watchId
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      nodeId?: string;
      path?: string;
      worktreePath?: string;
      offset?: string;
      limit?: string;
    };
  }>('/api/workspaces/:workspaceId/files/read', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    const range = parseFileRange(request.query);
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.query.path) || range === undefined)
      return sendError(reply, 400, 'FILE_RANGE_INVALID');
    if (request.query.worktreePath !== undefined && !isSafeResourceText(request.query.worktreePath))
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.file.read', {
          workspaceId: request.params.workspaceId,
          path: request.query.path,
          ...(request.query.worktreePath === undefined
            ? {}
            : { worktreePath: request.query.worktreePath }),
          ...range
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.put<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      path?: unknown;
      content?: unknown;
      expectedRevision?: unknown;
    };
  }>(
    '/api/workspaces/:workspaceId/files/write',
    { bodyLimit: FILE_WRITE_LIMIT + 64 * 1024 },
    async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      const body = request.body ?? {};
      if (
        !isNonEmptyString(body.nodeId) ||
        !isSafeResourceText(body.path) ||
        typeof body.content !== 'string' ||
        Buffer.byteLength(body.content, 'utf8') > FILE_WRITE_LIMIT ||
        typeof body.expectedRevision !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(body.expectedRevision)
      )
        return sendError(reply, 400, 'FILE_WRITE_INVALID');
      try {
        return reply.send(
          await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.file.write', {
            workspaceId: request.params.workspaceId,
            path: body.path,
            content: body.content,
            expectedRevision: body.expectedRevision
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; path?: string; worktreePath?: string; download?: string };
  }>('/api/workspaces/:workspaceId/files/content', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.query.path)) return sendError(reply, 400, 'FILE_RANGE_INVALID');
    if (request.query.worktreePath !== undefined && !isSafeResourceText(request.query.worktreePath))
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    if (request.query.download !== undefined && request.query.download !== '1')
      return sendError(reply, 400, 'FILE_RANGE_INVALID');
    try {
      return await sendWorkspaceFileContent({
        reply,
        method: request.method,
        range: request.headers.range,
        path: request.query.path,
        download: request.query.download === '1',
        read: (offset, limit) =>
          readFileContentChunk(
            nodeControl,
            admin,
            request.query.nodeId as string,
            request.params.workspaceId,
            request.query.path as string,
            request.query.worktreePath,
            offset,
            limit
          )
      });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      nodeId?: string;
      path?: string;
      worktreePath?: string;
      offset?: string;
      length?: string;
      size?: string;
      revision?: string;
    };
  }>('/api/workspaces/:workspaceId/files/direct-metadata', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.query.path)) return sendError(reply, 400, 'FILE_RANGE_INVALID');
    if (request.query.worktreePath !== undefined && !isSafeResourceText(request.query.worktreePath))
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    const directRange = parseDirectMetadataRange(request.query);
    if (directRange === null) return sendError(reply, 400, 'FILE_RANGE_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'workspace.file.direct.metadata',
          {
            workspaceId: request.params.workspaceId,
            path: request.query.path,
            ...(request.query.worktreePath === undefined
              ? {}
              : { worktreePath: request.query.worktreePath }),
            ...(directRange === undefined ? {} : directRange)
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      action?: unknown;
      path?: unknown;
      destination?: unknown;
    };
  }>('/api/workspaces/:workspaceId/files/mutate', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body ?? {};
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.action !== 'CREATE_FILE' &&
        body.action !== 'CREATE_DIRECTORY' &&
        body.action !== 'MOVE' &&
        body.action !== 'DELETE') ||
      !isSafeResourceText(body.path) ||
      (body.action === 'MOVE' && !isSafeResourceText(body.destination))
    )
      return sendError(reply, 400, 'FILE_MUTATION_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.files.mutate', {
          workspaceId: request.params.workspaceId,
          action: body.action,
          path: body.path,
          ...(body.action === 'MOVE' ? { destination: body.destination } : {})
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      nodeId?: string;
      q?: string;
      cursor?: string;
      limit?: string;
      includeDirectories?: string;
      waitForIndex?: string;
    };
  }>('/api/workspaces/:workspaceId/files/search', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    const page = parseResourcePage(request.query);
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (
      !isSafeResourceText(request.query.q) ||
      page === undefined ||
      (request.query.includeDirectories !== undefined &&
        request.query.includeDirectories !== 'true') ||
      (request.query.waitForIndex !== undefined && request.query.waitForIndex !== 'false')
    )
      return sendError(reply, 400, 'FILE_SEARCH_LIMIT_EXCEEDED');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.files.search', {
          workspaceId: request.params.workspaceId,
          query: request.query.q,
          ...(request.query.includeDirectories === 'true' ? { includeDirectories: true } : {}),
          ...(request.query.waitForIndex === 'false' ? { waitForIndex: false } : {}),
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          ...(page.limit === undefined ? {} : { limit: page.limit })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; q?: string; regex?: string };
  }>('/api/workspaces/:workspaceId/content/search', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (
      !isSafeResourceText(request.query.q) ||
      request.query.q.length > 256 ||
      (request.query.regex !== undefined && request.query.regex !== 'true')
    )
      return sendError(reply, 400, 'FILE_CONTENT_SEARCH_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'workspace.content.search',
          {
            workspaceId: request.params.workspaceId,
            query: request.query.q,
            ...(request.query.regex === 'true' ? { regex: true } : {})
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; path?: string };
  }>('/api/workspaces/:workspaceId/symbols/prepare', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.query.path))
      return sendError(reply, 400, 'SYMBOL_DEFINITION_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'workspace.symbol.prepare',
        {
          workspaceId: request.params.workspaceId,
          path: request.query.path
        },
        undefined,
        15_000
      );
      const preparation = workspaceSymbolIndexPreparationSchema.safeParse(
        (result as { readonly preparation?: unknown }).preparation
      );
      if (!preparation.success) throw new Error('NODE_RESPONSE_INVALID');
      return reply.send({ preparation: preparation.data });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string; path?: string; symbol?: string; references?: string };
  }>('/api/workspaces/:workspaceId/symbols/definition', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (
      !isSafeResourceText(request.query.path) ||
      !isSafeResourceText(request.query.symbol) ||
      request.query.symbol.length > 512 ||
      !/^-*[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(request.query.symbol) ||
      (request.query.references !== undefined &&
        request.query.references !== '0' &&
        request.query.references !== '1')
    )
      return sendError(reply, 400, 'SYMBOL_DEFINITION_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        request.query.nodeId,
        'workspace.symbol.definition',
        {
          workspaceId: request.params.workspaceId,
          path: request.query.path,
          symbol: request.query.symbol,
          ...(request.query.references === undefined
            ? {}
            : { includeReferences: request.query.references === '1' })
        },
        undefined,
        15_000
      );
      const definition = workspaceSymbolDefinitionSchema.safeParse(
        (result as { readonly definition?: unknown }).definition
      );
      if (!definition.success) throw new Error('NODE_RESPONSE_INVALID');
      return reply.send({ definition: definition.data });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; path?: unknown; reference?: unknown };
  }>('/api/workspaces/:workspaceId/symbols/definition', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body;
    const reference = workspaceFileReferenceSchema.safeParse(body.reference);
    if (!isNonEmptyString(body.nodeId) || !isSafeResourceText(body.path) || !reference.success)
      return sendError(reply, 400, 'SYMBOL_DEFINITION_INVALID');
    try {
      const result = await requestUserNode(
        nodeControl,
        admin,
        body.nodeId,
        'workspace.symbol.definition',
        {
          workspaceId: request.params.workspaceId,
          path: body.path,
          reference: reference.data
        },
        undefined,
        15_000
      );
      const definition = workspaceSymbolDefinitionSchema.safeParse(
        (result as { readonly definition?: unknown }).definition
      );
      if (!definition.success) throw new Error('NODE_RESPONSE_INVALID');
      return reply.send({ definition: definition.data });
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: { nodeId?: unknown; directory?: unknown; files?: unknown };
  }>('/api/workspaces/:workspaceId/uploads/preflight', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body;
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.directory !== undefined && !isSafeResourceText(body.directory)) ||
      !Array.isArray(body.files) ||
      body.files.length === 0 ||
      body.files.some(
        (file) =>
          !isPlainObject(file) ||
          typeof file.name !== 'string' ||
          file.name.length === 0 ||
          file.name.length > 512
      )
    )
      return sendError(reply, 400, 'UPLOAD_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.files.upload.preflight', {
          workspaceId: request.params.workspaceId,
          ...(typeof body.directory === 'string' ? { directory: body.directory } : {}),
          files: body.files.map((file) => ({ name: (file as { name: string }).name }))
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      directory?: unknown;
      name?: unknown;
      size?: unknown;
      overwrite?: unknown;
      composerAttachmentId?: unknown;
      mime?: unknown;
    };
  }>('/api/workspaces/:workspaceId/uploads', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const body = request.body;
    if (
      !isNonEmptyString(body.nodeId) ||
      (body.directory !== undefined && !isSafeResourceText(body.directory)) ||
      typeof body.name !== 'string' ||
      body.name.length === 0 ||
      body.name.length > 512 ||
      !Number.isSafeInteger(body.size) ||
      (body.size as number) < 0 ||
      typeof body.overwrite !== 'boolean' ||
      ((body.composerAttachmentId !== undefined || body.mime !== undefined) &&
        (typeof body.composerAttachmentId !== 'string' ||
          !isUuid(body.composerAttachmentId) ||
          typeof body.mime !== 'string' ||
          body.mime.length === 0 ||
          body.mime.length > 120 ||
          body.directory !== undefined))
    )
      return sendError(reply, 400, 'UPLOAD_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, body.nodeId, 'workspace.files.upload.create', {
          workspaceId: request.params.workspaceId,
          ...(typeof body.directory === 'string' ? { directory: body.directory } : {}),
          name: body.name,
          size: body.size,
          overwrite: body.overwrite,
          ...(typeof body.composerAttachmentId === 'string'
            ? { composerAttachmentId: body.composerAttachmentId, mime: body.mime as string }
            : {})
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string; uploadId: string };
    Querystring: { nodeId?: string; offset?: string };
    Body: Buffer;
  }>('/api/workspaces/:workspaceId/uploads/:uploadId/chunks', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    const offset =
      request.query.offset === undefined
        ? undefined
        : parseBoundedInteger(request.query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (
      !isNonEmptyString(request.query.nodeId) ||
      offset === undefined ||
      !isNonEmptyString(request.params.uploadId) ||
      !Buffer.isBuffer(request.body) ||
      request.body.length === 0 ||
      request.body.length > WORKSPACE_UPLOAD_CHUNK_BYTES
    )
      return sendError(reply, 400, 'UPLOAD_CHUNK_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'workspace.files.upload.chunk',
          {
            workspaceId: request.params.workspaceId,
            uploadId: request.params.uploadId,
            offset,
            dataBase64: request.body.toString('base64')
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; uploadId: string };
    Querystring: { nodeId?: string };
  }>('/api/workspaces/:workspaceId/uploads/:uploadId', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId) || !isNonEmptyString(request.params.uploadId))
      return sendError(reply, 400, 'UPLOAD_NOT_FOUND');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'workspace.files.upload.status',
          {
            workspaceId: request.params.workspaceId,
            uploadId: request.params.uploadId
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  for (const route of ['complete', 'cancel'] as const) {
    app.post<{
      Params: { workspaceId: string; uploadId: string };
      Body: { nodeId?: unknown };
    }>(`/api/workspaces/:workspaceId/uploads/:uploadId/${route}`, async (request, reply) => {
      if (!isAllowedOrigin(request, publicOrigin))
        return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
      if (!isNonEmptyString(request.body.nodeId) || !isNonEmptyString(request.params.uploadId))
        return sendError(reply, 400, 'UPLOAD_NOT_FOUND');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.body.nodeId,
            `workspace.files.upload.${route}`,
            { workspaceId: request.params.workspaceId, uploadId: request.params.uploadId }
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    });
  }

  app.get<{ Params: { workspaceId: string }; Querystring: { nodeId?: string } }>(
    '/api/workspaces/:workspaceId/changes',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.changes.current',
            {
              workspaceId: request.params.workspaceId
            }
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      nodeId?: string;
      path?: string;
      repositoryPath?: string;
      worktreePath?: string;
    };
  }>('/api/workspaces/:workspaceId/changes/diff', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.query.path)) return sendError(reply, 400, 'GIT_DIFF_INVALID');
    if (
      request.query.repositoryPath !== undefined &&
      !isSafeResourceText(request.query.repositoryPath)
    )
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    if (request.query.worktreePath !== undefined && !isSafeResourceText(request.query.worktreePath))
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.query.nodeId, 'workspace.change.diff', {
          workspaceId: request.params.workspaceId,
          path: request.query.path,
          ...(request.query.repositoryPath === undefined
            ? {}
            : { repositoryPath: request.query.repositoryPath }),
          ...(request.query.worktreePath === undefined
            ? {}
            : { worktreePath: request.query.worktreePath })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  type GitHistoryQuery = {
    nodeId?: string;
    repositoryPath?: string;
    refs?: string | string[];
    cursor?: string;
    limit?: string;
    download?: string;
  };
  const gitCommitPattern = /^[0-9a-f]{40,64}$/;
  const historyRefs = (value: string | string[] | undefined): string[] | undefined =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value];
  const invalidHistoryQuery = (query: GitHistoryQuery): string | undefined => {
    if (query.repositoryPath !== undefined && !isSafeResourceText(query.repositoryPath))
      return 'GIT_REPOSITORY_INVALID';
    const refs = historyRefs(query.refs);
    if (refs !== undefined && (refs.length > 128 || refs.some((ref) => !isSafeResourceText(ref))))
      return 'GIT_HISTORY_REF_INVALID';
    if (query.cursor !== undefined && !isSafeResourceText(query.cursor))
      return 'GIT_HISTORY_CURSOR_INVALID';
    if (
      query.limit !== undefined &&
      (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 100)
    )
      return 'GIT_HISTORY_LIMIT_INVALID';
    if (query.download !== undefined && query.download !== '1') return 'FILE_RANGE_INVALID';
    return undefined;
  };
  const historyInput = (workspaceId: string, query: GitHistoryQuery) => ({
    workspaceId,
    ...(query.repositoryPath === undefined ? {} : { repositoryPath: query.repositoryPath }),
    ...(query.refs === undefined ? {} : { refs: historyRefs(query.refs) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) })
  });

  app.get<{ Params: { workspaceId: string }; Querystring: GitHistoryQuery }>(
    '/api/workspaces/:workspaceId/git/refs',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      const invalid = invalidHistoryQuery(request.query);
      if (invalid !== undefined) return sendError(reply, 400, invalid);
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.git.refs.list',
            historyInput(request.params.workspaceId, request.query)
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { workspaceId: string }; Querystring: GitHistoryQuery }>(
    '/api/workspaces/:workspaceId/git/history',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      const invalid = invalidHistoryQuery(request.query);
      if (invalid !== undefined) return sendError(reply, 400, invalid);
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.git.history.list',
            historyInput(request.params.workspaceId, request.query)
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { workspaceId: string; commit: string }; Querystring: GitHistoryQuery }>(
    '/api/workspaces/:workspaceId/git/commits/:commit/files',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      const invalid = invalidHistoryQuery(request.query);
      if (invalid !== undefined) return sendError(reply, 400, invalid);
      if (!gitCommitPattern.test(request.params.commit))
        return sendError(reply, 400, 'GIT_HISTORY_COMMIT_INVALID');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.git.commit.files',
            {
              ...historyInput(request.params.workspaceId, request.query),
              commit: request.params.commit
            }
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{
    Params: { workspaceId: string; commit: string };
    Querystring: GitHistoryQuery & { path?: string; previousPath?: string };
  }>('/api/workspaces/:workspaceId/git/commits/:commit/diff', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    const invalid = invalidHistoryQuery(request.query);
    if (invalid !== undefined) return sendError(reply, 400, invalid);
    if (!gitCommitPattern.test(request.params.commit))
      return sendError(reply, 400, 'GIT_HISTORY_COMMIT_INVALID');
    if (!isSafeResourceText(request.query.path)) return sendError(reply, 400, 'GIT_DIFF_INVALID');
    if (request.query.previousPath !== undefined && !isSafeResourceText(request.query.previousPath))
      return sendError(reply, 400, 'GIT_DIFF_INVALID');
    try {
      return reply.send(
        await requestUserNode(
          nodeControl,
          admin,
          request.query.nodeId,
          'workspace.git.commit.file.diff',
          {
            ...historyInput(request.params.workspaceId, request.query),
            commit: request.params.commit,
            path: request.query.path,
            ...(request.query.previousPath === undefined
              ? {}
              : { previousPath: request.query.previousPath })
          }
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; commit: string };
    Querystring: GitHistoryQuery & {
      path?: string;
      offset?: string;
      length?: string;
      size?: string;
      revision?: string;
    };
  }>('/api/workspaces/:workspaceId/git/commits/:commit/files/content', async (request, reply) => {
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    const invalid = invalidHistoryQuery(request.query);
    if (invalid !== undefined) return sendError(reply, 400, invalid);
    if (!gitCommitPattern.test(request.params.commit))
      return sendError(reply, 400, 'GIT_HISTORY_COMMIT_INVALID');
    if (!isSafeResourceText(request.query.path)) return sendError(reply, 400, 'FILE_RANGE_INVALID');
    const readChunk = (offset: number, limit: number) =>
      readHistoryFileContentChunk(
        nodeControl,
        admin,
        request.query.nodeId as string,
        historyInput(request.params.workspaceId, request.query),
        request.params.commit,
        request.query.path as string,
        offset,
        limit
      );
    try {
      const first = await readChunk(0, 1);
      const range = parseHttpByteRange(request.headers.range, first.size);
      if (range === null) return sendError(reply, 416, 'FILE_RANGE_INVALID');
      const start = range?.start ?? 0;
      const download = request.query.download === '1';
      const end =
        range === undefined ? first.size - 1 : Math.min(range.end, FILE_CONTENT_FULL_LIMIT - 1);
      const length = first.size === 0 ? 0 : end - start + 1;
      if (!download && range === undefined && length > FILE_CONTENT_FULL_LIMIT)
        return sendError(reply, 413, 'FILE_PREVIEW_TOO_LARGE');
      if (start >= FILE_CONTENT_FULL_LIMIT || end >= FILE_CONTENT_FULL_LIMIT)
        return sendError(reply, 416, 'FILE_RANGE_INVALID');
      const filename = request.query.path.split('/').at(-1) ?? 'file';
      const contentType = fileContentType(filename);
      reply
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'private, no-store')
        .header('content-type', contentType)
        .header(
          'content-disposition',
          `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`
        )
        .header('x-content-type-options', 'nosniff');
      if (contentType === 'image/svg+xml') reply.header('content-security-policy', 'sandbox');
      if (range !== undefined && first.size > 0)
        reply.code(206).header('content-range', `bytes ${start}-${end}/${first.size}`);
      if (request.method === 'HEAD') return sendFileContentHead(reply, length);
      return reply
        .header('content-length', String(length))
        .send(Readable.from(fileContentChunks(readChunk, start, end, FILE_CONTENT_CHUNK_BYTES)));
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; commit: string };
    Querystring: GitHistoryQuery & {
      path?: string;
      offset?: string;
      length?: string;
      size?: string;
      revision?: string;
    };
  }>(
    '/api/workspaces/:workspaceId/git/commits/:commit/files/direct-metadata',
    async (request, reply) => {
      const admin = protectedAdmin(database, request, reply);
      if (admin === undefined) return;
      if (!isNonEmptyString(request.query.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
      const invalid = invalidHistoryQuery(request.query);
      if (invalid !== undefined) return sendError(reply, 400, invalid);
      if (!gitCommitPattern.test(request.params.commit))
        return sendError(reply, 400, 'GIT_HISTORY_COMMIT_INVALID');
      if (!isSafeResourceText(request.query.path))
        return sendError(reply, 400, 'FILE_RANGE_INVALID');
      const directRange = parseDirectMetadataRange(request.query);
      if (directRange === null) return sendError(reply, 400, 'FILE_RANGE_INVALID');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            admin,
            request.query.nodeId,
            'workspace.git.commit.file.direct.metadata',
            {
              ...historyInput(request.params.workspaceId, request.query),
              commit: request.params.commit,
              path: request.query.path,
              ...(directRange === undefined ? {} : directRange)
            }
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: {
      nodeId?: unknown;
      path?: unknown;
      state?: unknown;
      repositoryPath?: unknown;
      worktreePath?: unknown;
    };
  }>('/api/workspaces/:workspaceId/changes/restore', async (request, reply) => {
    if (!isAllowedOrigin(request, publicOrigin)) return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    const admin = protectedAdmin(database, request, reply);
    if (admin === undefined) return;
    if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
    if (!isNonEmptyString(request.body.nodeId)) return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (!isSafeResourceText(request.body.path))
      return sendError(reply, 400, 'GIT_CHANGE_RESTORE_UNAVAILABLE');
    if (
      request.body.repositoryPath !== undefined &&
      !isSafeResourceText(request.body.repositoryPath)
    )
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    if (request.body.worktreePath !== undefined && !isSafeResourceText(request.body.worktreePath))
      return sendError(reply, 400, 'GIT_REPOSITORY_INVALID');
    if (
      request.body.state !== 'STAGED' &&
      request.body.state !== 'UNSTAGED' &&
      request.body.state !== 'UNTRACKED'
    )
      return sendError(reply, 400, 'GIT_CHANGE_RESTORE_UNAVAILABLE');
    try {
      return reply.send(
        await requestUserNode(nodeControl, admin, request.body.nodeId, 'workspace.change.restore', {
          workspaceId: request.params.workspaceId,
          path: request.body.path,
          state: request.body.state,
          ...(request.body.repositoryPath === undefined
            ? {}
            : { repositoryPath: request.body.repositoryPath }),
          ...(request.body.worktreePath === undefined
            ? {}
            : { worktreePath: request.body.worktreePath })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
}

async function readFileContentChunk(
  nodeControl: NodeControl,
  admin: CurrentUserSession,
  nodeId: string,
  workspaceId: string,
  path: string,
  worktreePath: string | undefined,
  offset: number,
  limit: number
): Promise<FileContentChunk> {
  const result = (await requestUserNode(nodeControl, admin, nodeId, 'workspace.file.content.read', {
    workspaceId,
    path,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    offset,
    limit
  })) as { readonly file?: unknown };
  const file = result.file;
  if (
    typeof file !== 'object' ||
    file === null ||
    !Number.isSafeInteger((file as FileContentChunk).size) ||
    !Number.isSafeInteger((file as FileContentChunk).offset) ||
    typeof (file as FileContentChunk).contentBase64 !== 'string'
  )
    throw new Error('NODE_RESPONSE_INVALID');
  return file as FileContentChunk;
}

function parseDirectMetadataRange(query: {
  readonly offset?: string;
  readonly length?: string;
  readonly size?: string;
  readonly revision?: string;
}):
  | {
      readonly offset: number;
      readonly length: number;
      readonly size: number;
      readonly revision: string;
    }
  | undefined
  | null {
  const values = [query.offset, query.length, query.size, query.revision];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) return null;
  const offset = Number(query.offset);
  const length = Number(query.length);
  const size = Number(query.size);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 512 * 1024 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    offset + length > size ||
    !/^[a-f0-9]{64}$/u.test(query.revision!)
  )
    return null;
  return { offset, length, size, revision: query.revision! };
}

async function readHistoryFileContentChunk(
  nodeControl: NodeControl,
  admin: CurrentUserSession,
  nodeId: string,
  history: Record<string, unknown>,
  commit: string,
  path: string,
  offset: number,
  limit: number
): Promise<FileContentChunk> {
  const result = (await requestUserNode(
    nodeControl,
    admin,
    nodeId,
    'workspace.git.commit.file.content.read',
    { ...history, commit, path, offset, limit }
  )) as { readonly file?: unknown };
  const file = result.file;
  if (
    typeof file !== 'object' ||
    file === null ||
    !Number.isSafeInteger((file as FileContentChunk).size) ||
    !Number.isSafeInteger((file as FileContentChunk).offset) ||
    typeof (file as FileContentChunk).contentBase64 !== 'string'
  )
    throw new Error('NODE_RESPONSE_INVALID');
  return file as FileContentChunk;
}
