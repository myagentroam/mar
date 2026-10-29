import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import { publicNode } from './node-projection.js';
import { requestUserNode } from './workspace-http-support.js';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { NodeUpgradeService } from './node-upgrade-service.js';
import type { NodeUpgradeProgress } from './node-upgrade-progress.js';
import { z } from 'zod';
import { definiteNodeRejection } from './node-request-error.js';
import type { NodeCapabilities } from '@myagentroam/protocol';

const reportSchema = z
  .object({
    attemptId: z.string().uuid(),
    step: z.enum(['CLOSING_NODE', 'INSTALLING', 'WAITING_FOR_ONLINE']),
    result: z.enum(['INSTALLED', 'FAILED']).optional(),
    failure: z
      .object({
        code: z
          .string()
          .min(1)
          .max(96)
          .regex(/^[A-Z0-9_]+$/u),
        message: z.string().min(1).max(256),
        details: z.string().min(1).max(512).optional(),
        requestId: z.string().min(1).max(128).optional(),
        step: z.enum(['CLOSING_NODE', 'INSTALLING', 'WAITING_FOR_ONLINE']),
        kind: z.enum(['INSTALL', 'START'])
      })
      .strict()
      .optional(),
    operationEnded: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) =>
      (value.result === 'FAILED') === (value.failure !== undefined) &&
      (value.failure === undefined || value.failure.step === value.step) &&
      (value.failure?.kind !== 'START' || value.step === 'WAITING_FOR_ONLINE') &&
      (value.result !== 'INSTALLED' || value.step === 'WAITING_FOR_ONLINE') &&
      (value.operationEnded !== true || value.result === 'FAILED')
  );
export function registerNodeUpgradeRoutes(input: {
  app: FastifyInstance;
  database: SessionLookup;
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'> & {
    isNodeUpgradeOnly(nodeId: string): boolean;
    upgradeCapabilities?(nodeId: string): NodeCapabilities | undefined;
    listNodes():
      | readonly Parameters<typeof publicNode>[0][]
      | Promise<readonly Parameters<typeof publicNode>[0][]>;
  };
  nodeUpgrades: Pick<NodeUpgradeService, 'availability'>;
  progress?: NodeUpgradeProgress;
  publicOrigin: string | undefined;
  authorize(userId: number, nodeId: string): Promise<void>;
  databaseError(reply: FastifyReply, error: unknown): FastifyReply;
}): void {
  const { app, database, nodeControl, nodeUpgrades, publicOrigin, authorize, databaseError } =
    input;
  if (input.progress !== undefined) {
    const progress = input.progress;
    app.post<{ Params: { nodeId: string } }>(
      '/api/nodes/:nodeId/upgrade/report',
      { bodyLimit: 4096 },
      async (request, reply) => {
        const authorization = request.headers.authorization;
        const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
        if (token === undefined) return sendError(reply, 401, 'NODE_UPGRADE_REPORT_UNAUTHORIZED');
        const parsed = reportSchema.safeParse(request.body);
        if (!parsed.success) return sendError(reply, 400, 'NODE_UPGRADE_REPORT_INVALID');
        try {
          const { attemptId, step, result, failure, operationEnded } = parsed.data;
          return reply.send(
            await progress.report(request.params.nodeId, token, {
              attemptId,
              step,
              ...(result === undefined ? {} : { result }),
              ...(failure === undefined
                ? {}
                : {
                    failure: {
                      code: failure.code,
                      message: failure.message,
                      kind: failure.kind,
                      step: failure.step,
                      ...(failure.details === undefined ? {} : { details: failure.details }),
                      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId })
                    }
                  }),
              ...(operationEnded === undefined ? {} : { operationEnded })
            })
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message === 'NODE_UPGRADE_REPORT_UNAUTHORIZED' ||
              error.message === 'NODE_NOT_FOUND')
          )
            return sendError(reply, 401, 'NODE_UPGRADE_REPORT_UNAUTHORIZED');
          return databaseError(reply, error);
        }
      }
    );
  }
  for (const action of ['upgrade', 'upgrade/cancel'] as const) {
    app.post<{ Params: { nodeId: string } }>(
      `/api/nodes/:nodeId/${action}`,
      async (request, reply) => {
        if (!isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const admin = protectedAdmin(database, request, reply);
        if (admin === undefined) return;
        if (!validCsrf(request, admin)) return sendError(reply, 403, 'CSRF_INVALID');
        try {
          await authorize(admin.userId, request.params.nodeId);
          const node = (await nodeControl.listNodes()).find(
            (item) => item.id === request.params.nodeId
          );
          if (node === undefined) return sendError(reply, 404, 'NODE_NOT_FOUND');
          if (!node.connected || node.disabled) return sendError(reply, 409, 'NODE_OFFLINE');
          if (action === 'upgrade/cancel') {
            const current = await input.progress?.snapshot(node.id);
            const result = await requestUserNode(
              nodeControl,
              admin,
              node.id,
              'node.upgrade.cancel',
              {}
            );
            if (current) await input.progress?.cancel(node.id, current.attemptId);
            return reply.send(result);
          }
          const projection = publicNode(node) as {
            readonly nodeAppVersion: string;
            readonly metadata?: { readonly supervisedUpgrade?: boolean };
          };
          const availability = await nodeUpgrades.availability(
            projection.nodeAppVersion,
            projection.metadata?.supervisedUpgrade === true,
            nodeControl.isNodeUpgradeOnly(node.id)
          );
          if (availability.state !== 'AVAILABLE')
            return sendError(reply, 409, `NODE_UPGRADE_${availability.state}`);
          const pending = await input.progress?.snapshot(node.id);
          if (pending?.state === 'WAITING_FOR_RUNS' || pending?.state === 'UPGRADING') {
            if (pending.targetVersion !== availability.targetVersion)
              return sendError(reply, 409, 'NODE_UPGRADE_ALREADY_IN_PROGRESS');
            return reply.code(202).send({
              status: pending.requestAccepted ? 'ALREADY_PENDING' : 'PENDING_CONFIRMATION',
              targetVersion: pending.targetVersion,
              attemptId: pending.attemptId
            });
          }
          const supportsProgress =
            nodeControl.upgradeCapabilities?.(node.id)?.metadata?.upgradeProgress?.apiVersion === 1;
          const attempt = supportsProgress
            ? await input.progress?.begin(node.id, availability.targetVersion, {
                userId: admin.userId,
                sessionHash: admin.sessionHash
              })
            : undefined;
          if (attempt?.existing)
            return reply.code(202).send({
              status: (await input.progress!.snapshot(node.id))?.requestAccepted
                ? 'ALREADY_PENDING'
                : 'PENDING_CONFIRMATION',
              targetVersion: availability.targetVersion,
              attemptId: attempt.attemptId
            });
          let result: unknown;
          try {
            result = await requestUserNode(nodeControl, admin, node.id, 'node.upgrade.request', {
              targetVersion: availability.targetVersion,
              ...(attempt === undefined ? {} : { attemptId: attempt.attemptId })
            });
          } catch (error) {
            const code = definiteNodeRejection(error);
            if (attempt !== undefined && code !== undefined)
              await input.progress!.failBeforeHandoff(node.id, attempt.attemptId, code);
            throw error;
          }
          if (attempt !== undefined) await input.progress!.markAccepted(node.id, attempt.attemptId);
          return reply.code(202).send(result);
        } catch (error) {
          return databaseError(reply, error);
        }
      }
    );
  }
}
