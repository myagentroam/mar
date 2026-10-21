import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { runImageReadInputSchema } from '@myagentroam/protocol';
import type { SessionShares } from './session-shares.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import { effectiveSkills } from './skill-target-routes.js';
import { parseFileRange, parseResourcePage, isSafeResourceText } from './workspace-http-support.js';
import { sendWorkspaceFileContent, type FileContentChunk } from './file-content-stream.js';
import { sendError } from './http-errors.js';

type Request = FastifyRequest<{ Params: { shareId: string } }>;
type Resolved = Awaited<ReturnType<SessionShares['resolve']>>;

/** Only the fixed resource operations consumed by the shared conversation and readonly previews. */
export function registerSessionShareResourceRoutes(input: {
  app: FastifyInstance;
  nodeControl: SessionRunNodeControl;
  resolve: (request: Request) => Promise<Resolved>;
}) {
  const { nodeControl } = input;
  void input.app.register(async (app) => {
    if (!app.hasContentTypeParser('application/octet-stream'))
      app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: 512 * 1024 },
        (_request, body, done) => done(null, body)
      );
    const access = new WeakMap<FastifyRequest, Resolved>();
    app.addHook('preHandler', async (request) => {
      access.set(request, await input.resolve(request as Request));
    });
    function call(request: FastifyRequest, operation: string, data: Record<string, unknown> = {}) {
      const { context } = access.get(request)!;
      return nodeControl.requestNode(
        context.nodeId,
        operation,
        { ...data, workspaceId: context.workspaceId, sessionId: context.sessionId },
        { ...context.user, workspaceId: context.workspaceId }
      );
    }
    async function sessionQueue(request: FastifyRequest) {
      const result = (await call(request, 'workspace.queue.get')) as {
        queue?: { items?: readonly unknown[]; [key: string]: unknown };
        [key: string]: unknown;
      };
      const queue = result.queue;
      if (queue === undefined || !Array.isArray(queue.items))
        throw new Error('NODE_RESPONSE_INVALID');
      const { context } = access.get(request)!;
      const items = queue.items.filter((item): item is Record<string, unknown> => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
        const value = item as Record<string, unknown>;
        return value.sessionId === context.sessionId && value.workspaceId === context.workspaceId;
      });
      return { result, queue, items };
    }
    app.get<{
      Params: { shareId: string };
      Querystring: { path?: string; offset?: string; limit?: string };
    }>('/files/read', async (request, reply) => {
      const range = parseFileRange(request.query);
      if (!range || !isSafeResourceText(request.query.path))
        return sendError(reply, 400, 'FILE_RANGE_INVALID');
      return reply.send(
        await call(request, 'workspace.file.read', { path: request.query.path, ...range })
      );
    });
    app.get<{ Params: { shareId: string }; Querystring: { path?: string; download?: string } }>(
      '/files/content',
      async (request, reply) => {
        if (
          !isSafeResourceText(request.query.path) ||
          (request.query.download !== undefined && request.query.download !== '1')
        )
          return sendError(reply, 400, 'FILE_RANGE_INVALID');
        return sendWorkspaceFileContent({
          reply,
          method: request.method,
          range: request.headers.range,
          path: request.query.path,
          download: request.query.download === '1',
          read: async (offset, limit) => {
            access.set(request, await input.resolve(request));
            const result = (await call(request, 'workspace.file.content.read', {
              path: request.query.path,
              offset,
              limit
            })) as { file?: FileContentChunk };
            if (
              !Number.isSafeInteger(result.file?.size) ||
              !Number.isSafeInteger(result.file?.offset) ||
              typeof result.file?.contentBase64 !== 'string'
            )
              throw new Error('NODE_RESPONSE_INVALID');
            return result.file;
          }
        });
      }
    );
    app.get<{
      Querystring: {
        q?: string;
        cursor?: string;
        limit?: string;
        includeDirectories?: string;
        waitForIndex?: string;
      };
    }>('/files/search', async (request, reply) => {
      const page = parseResourcePage(request.query);
      if (!page || !isSafeResourceText(request.query.q))
        return sendError(reply, 400, 'FILE_SEARCH_LIMIT_EXCEEDED');
      return reply.send(
        await call(request, 'workspace.files.search', {
          query: request.query.q,
          ...page,
          ...(request.query.includeDirectories === 'true' ? { includeDirectories: true } : {}),
          ...(request.query.waitForIndex === 'false' ? { waitForIndex: false } : {})
        })
      );
    });
    app.get('/effective-skills', async (request, reply) => {
      const [nodeResult, workspaceResult] = await Promise.all([
        call(request, 'node.skills.inspect', { includeClaudeCompatibility: true }),
        call(request, 'workspace.skills.inspect')
      ]);
      return reply.send({ skills: effectiveSkills(nodeResult, workspaceResult) });
    });
    const uploadSchema = z
      .object({
        name: z.string().min(1).max(512),
        size: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        mime: z.string().min(1).max(120),
        overwrite: z.literal(false),
        composerAttachmentId: z.string().uuid()
      })
      .strict();
    app.post<{ Body: unknown }>('/uploads', async (request, reply) => {
      const value = uploadSchema.safeParse(request.body);
      if (!value.success) return sendError(reply, 400, 'UPLOAD_INVALID');
      return reply.send(await call(request, 'workspace.files.upload.create', value.data));
    });
    app.post<{
      Params: { shareId: string; uploadId: string };
      Querystring: { offset?: string };
      Body: Buffer;
    }>('/uploads/:uploadId/chunks', async (request, reply) => {
      const offset = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .safeParse(request.query.offset);
      if (
        !offset.success ||
        !Buffer.isBuffer(request.body) ||
        !request.body.length ||
        request.body.length > 512 * 1024
      )
        return sendError(reply, 400, 'UPLOAD_CHUNK_INVALID');
      return reply.send(
        await call(request, 'workspace.files.upload.chunk', {
          uploadId: request.params.uploadId,
          offset: offset.data,
          dataBase64: request.body.toString('base64')
        })
      );
    });
    for (const action of ['complete', 'cancel'] as const)
      app.post<{ Params: { shareId: string; uploadId: string } }>(
        `/uploads/:uploadId/${action}`,
        async (request, reply) =>
          reply.send(
            await call(request, `workspace.files.upload.${action}`, {
              uploadId: request.params.uploadId
            })
          )
      );
    app.get('/queue', async (request, reply) => {
      const { result, queue, items } = await sessionQueue(request);
      return reply.send({ ...result, queue: { ...queue, items } });
    });
    app.put<{ Body: unknown }>('/queue', async (request, reply) => {
      const value = z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          queueItemIds: z.array(z.string().min(1).max(128)).max(1000)
        })
        .strict()
        .safeParse(request.body);
      if (!value.success) return sendError(reply, 400, 'QUEUE_INVALID');
      const { items } = await sessionQueue(request);
      const sessionItemIds = new Set(
        items.flatMap((item) => (typeof item.queueItemId === 'string' ? [item.queueItemId] : []))
      );
      if (value.data.queueItemIds.some((id) => !sessionItemIds.has(id)))
        return sendError(reply, 409, 'QUEUE_VERSION_CONFLICT');
      return reply.send(await call(request, 'workspace.queue.reorder', value.data));
    });
    async function requireQueueItem(request: FastifyRequest, id: string): Promise<void> {
      const { items } = await sessionQueue(request);
      if (!items.some((item) => item.queueItemId === id)) throw new Error('QUEUE_ITEM_INVALID');
    }
    app.patch<{ Params: { shareId: string; itemId: string }; Body: unknown }>(
      '/queue/:itemId',
      async (request, reply) => {
        const value = z
          .object({ content: z.string().min(1).max(100_000) })
          .strict()
          .safeParse(request.body);
        if (!value.success) return sendError(reply, 400, 'QUEUE_INVALID');
        await requireQueueItem(request, request.params.itemId);
        return reply.send(
          await call(request, 'workspace.queue.message.update', {
            queueItemId: request.params.itemId,
            content: value.data.content
          })
        );
      }
    );
    app.delete<{ Params: { shareId: string; itemId: string } }>(
      '/queue/:itemId',
      async (request, reply) => {
        await requireQueueItem(request, request.params.itemId);
        return reply.send(
          await call(request, 'workspace.queue.message.delete', {
            queueItemId: request.params.itemId
          })
        );
      }
    );
    app.post<{ Params: { shareId: string; itemId: string } }>(
      '/queue/:itemId/execute',
      async (request, reply) => {
        await requireQueueItem(request, request.params.itemId);
        return reply.send(
          await call(request, 'workspace.queue.message.execute', {
            queueItemId: request.params.itemId
          })
        );
      }
    );
    async function requireRun(request: FastifyRequest, id: string): Promise<void> {
      const result = (await call(request, 'run.get', { runId: id })) as {
        run?: { sessionId?: string; workspaceId?: string };
      };
      const { context } = access.get(request)!;
      if (
        result.run?.sessionId !== context.sessionId ||
        result.run.workspaceId !== context.workspaceId
      )
        throw new Error('RUN_NOT_FOUND');
    }
    app.post<{ Params: { shareId: string; runId: string; requestId: string }; Body: unknown }>(
      '/runs/:runId/user-input/:requestId',
      async (request, reply) => {
        const value = z
          .object({ answers: z.record(z.unknown()) })
          .strict()
          .safeParse(request.body);
        if (!value.success) return sendError(reply, 400, 'USER_INPUT_INVALID');
        await requireRun(request, request.params.runId);
        return reply.send(
          await call(request, 'run.user-input.respond', {
            runId: request.params.runId,
            requestId: request.params.requestId,
            answers: value.data.answers
          })
        );
      }
    );
    app.post<{
      Params: { shareId: string; runId: string; approvalId: string };
      Body: { nodeId?: unknown; decision?: unknown };
    }>('/runs/:runId/approvals/:approvalId/decision', async (request, reply) => {
      const decision = request.body?.decision;
      if (decision !== 'APPROVED' && decision !== 'REJECTED')
        return sendError(reply, 400, 'APPROVAL_DECISION_INVALID');
      await requireRun(request, request.params.runId);
      return reply.send(
        await call(request, 'run.approval.decide', {
          runId: request.params.runId,
          approvalId: request.params.approvalId,
          decision
        })
      );
    });
    app.post<{ Params: { shareId: string; runId: string } }>(
      '/runs/:runId/interrupt',
      async (request, reply) => {
        await requireRun(request, request.params.runId);
        return reply
          .code(202)
          .send(await call(request, 'run.interrupt', { runId: request.params.runId }));
      }
    );
    app.get<{ Params: { shareId: string; runId: string; selector: string } }>(
      '/runs/:runId/images/:selector',
      async (request, reply) => {
        const { context } = access.get(request)!;
        const { runId, selector } = request.params;
        const native = runId.startsWith('native-history:');
        if (native && runId !== `native-history:${context.sessionId}`)
          return sendError(reply, 400, 'RUN_IMAGE_INVALID');
        const value = runImageReadInputSchema.safeParse({
          runId,
          ...(native ? { imageRef: selector } : { imageIndex: Number(selector) })
        });
        if (!value.success) return sendError(reply, 400, 'RUN_IMAGE_INVALID');
        if (!native) await requireRun(request, runId);
        const result = (await nodeControl.requestNode(
          context.nodeId,
          'run.image.read',
          value.data,
          {
            userId: context.user.userId,
            sessionHash: context.user.sessionHash,
            workspaceId: context.workspaceId
          }
        )) as { image?: { mime?: string; dataBase64?: string } };
        if (
          !result.image?.mime?.startsWith('image/') ||
          typeof result.image.dataBase64 !== 'string'
        )
          return sendError(reply, 502, 'RUN_IMAGE_INVALID');
        return reply.type(result.image.mime).send(Buffer.from(result.image.dataBase64, 'base64'));
      }
    );
  });
}
