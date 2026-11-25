import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  scheduledTaskWriteSchema,
  scheduledTaskOwnerPatchSchema,
  scheduledTaskRevisionSchema,
  scheduledTaskStateSchema,
  scheduledTargetSchema,
  scheduledTimeGroupsSchema
} from '@myagentroam/protocol';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type CurrentUserSession } from './session.js';
import { sendError } from './http-errors.js';
import { requestUserNode } from './workspace-http-support.js';
import type { SessionRunNodeControl, SessionRunStore } from './session-run-contracts.js';
import {
  scheduledTaskCardEntry,
  scheduledTaskIndexEntry,
  type ScheduledTaskIndexStore
} from './scheduled-task-index.js';

const id = z.string().min(1).max(512);
const address = z.object({ nodeId: id, workspaceId: id });
const mutation = address.extend({ expectedRevision: scheduledTaskRevisionSchema });
const scopeFilter = address.partial();
const filter = scopeFilter.extend({
  mine: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(4096).optional()
});
const taskFilter = filter.extend({
  includeUpcoming: z.enum(['true', 'false']).optional(),
  sessionId: id.optional(),
  state: scheduledTaskStateSchema.optional()
});
const listCursor = address.extend({ taskId: id });
const historyCursor = z.object({
  nodeId: id,
  occurrenceId: id,
  dueAt: z.number().int().nonnegative().safe()
});
const pageSize = 20;
const historyPageSize = 10;
const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const time = z.number().int().nonnegative().safe();
const directoryWorkspace = z.object({
  id,
  path: z.string().optional(),
  displayName: z.string().optional()
});
const workspaceList = z.object({ workspaces: z.array(directoryWorkspace) });
const taskPage = z.object({
  tasks: z
    .array(
      scheduledTaskCardEntry.extend({
        sessionTitle: z.string().nullable().optional(),
        objectivePreview: z.string().max(180).optional()
      })
    )
    .max(pageSize + 1)
});
const upcomingPage = z.object({
  items: z.array(z.object({ taskId: id, dueAt: time, name: z.string() })).max(6)
});
const occurrenceSummary = z.object({
  occurrenceId: id,
  taskId: id,
  dueAt: time,
  state: z.string().min(1).max(128),
  reason: z.string().nullable(),
  name: z.string().nullable(),
  startedAt: time.nullable(),
  endedAt: time.nullable(),
  run: z.object({ runId: id, sessionId: id }).nullable()
});
const occurrencePage = z.object({
  items: z.array(occurrenceSummary).max(historyPageSize + 1)
});
const occurrenceDetail = occurrenceSummary.extend({ snapshot: z.record(z.unknown()).nullable() });
const taskDetail = z
  .object({ task: scheduledTaskIndexEntry.passthrough(), canResolveProposals: z.boolean() })
  .passthrough();

type Address = z.infer<typeof address>;
interface DirectoryNode {
  id: string;
  name: string;
  connected: boolean;
  supported: boolean;
  newSessionSupported: boolean;
}
interface DirectoryWorkspace {
  id: string;
  name: string;
}
interface Scope extends Address {
  nodeName: string;
  workspaceName: string;
}
export interface ScheduledTaskDirectory {
  nodes(userId: number): Promise<readonly DirectoryNode[]>;
  workspaces(
    userId: number,
    nodeId: string,
    entries: readonly z.infer<typeof directoryWorkspace>[],
    source: 'live' | 'index'
  ): Promise<readonly DirectoryWorkspace[]>;
  canUseWorkspace(userId: number, nodeId: string, workspaceId: string): Promise<boolean>;
}
interface Options {
  app: FastifyInstance;
  database: Pick<SessionRunStore, 'findCurrentUserSession' | 'userDisplayName'>;
  nodeControl: SessionRunNodeControl;
  publicOrigin: string | undefined;
  databaseError(reply: FastifyReply, error: unknown): FastifyReply;
  schedules: ScheduledTaskDirectory;
  index: Pick<ScheduledTaskIndexStore, 'list' | 'workspaceIds'>;
}

/** Authorizes and merges Node snapshots. No clock, task prompt or execution state is owned here. */
export function registerScheduledTaskRoutes({
  app,
  database,
  nodeControl,
  publicOrigin,
  databaseError,
  schedules,
  index
}: Options): void {
  const call = (actor: CurrentUserSession, source: Address, operation: string, data: object = {}) =>
    requestUserNode(nodeControl, actor, source.nodeId, operation, {
      ...data,
      workspaceId: source.workspaceId
    });
  const canUse = (actor: CurrentUserSession, scope: Address) =>
    schedules.canUseWorkspace(actor.userId, scope.nodeId, scope.workspaceId);
  const project = async (
    actor: CurrentUserSession,
    node: DirectoryNode,
    workspaces: Parameters<ScheduledTaskDirectory['workspaces']>[2],
    source: 'live' | 'index',
    workspaceId?: string
  ): Promise<Scope[]> => {
    // The live directory reconciles Workspace registration from the full Node list.
    const allowed = await schedules.workspaces(actor.userId, node.id, workspaces, source);
    return allowed
      .filter((item) => workspaceId === undefined || item.id === workspaceId)
      .map((item) => ({
        nodeId: node.id,
        workspaceId: item.id,
        nodeName: node.name,
        workspaceName: item.name
      }));
  };
  const directory = async (actor: CurrentUserSession, filters: z.infer<typeof scopeFilter>) => {
    const nodes = (await schedules.nodes(actor.userId)).filter(
      (node) => filters.nodeId === undefined || node.id === filters.nodeId
    );
    const unavailable = new Set<string>();
    const slices = await Promise.all(
      nodes.map(async (node) => {
        if (!node.connected || !node.supported) {
          unavailable.add(node.id);
          return [];
        }
        try {
          const { workspaces } = workspaceList.parse(
            await requestUserNode(nodeControl, actor, node.id, 'workspace.list', {})
          );
          return await project(actor, node, workspaces, 'live', filters.workspaceId);
        } catch {
          unavailable.add(node.id);
          return [];
        }
      })
    );
    return { nodes, unavailable, scopes: slices.flat() };
  };

  app.get('/api/scheduled-tasks', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    reply.header('cache-control', 'private, no-store');
    try {
      const query = taskFilter.parse(request.query);
      if (
        query.sessionId !== undefined &&
        (query.nodeId === undefined || query.workspaceId === undefined)
      )
        return sendError(reply, 400, 'SCHEDULE_INVALID');
      const cursor = decode(query.cursor, listCursor);
      const { nodes, scopes, unavailable } = await directory(actor, query);
      const mine = query.mine !== 'false';
      const asOf = Date.now();
      const context = (scope: Scope) => {
        const comparison =
          cursor === undefined
            ? 1
            : binary(scope.nodeId, cursor.nodeId) || binary(scope.workspaceId, cursor.workspaceId);
        const conditions = {
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
          ...(cursor !== undefined && comparison === 0 ? { afterTaskId: cursor.taskId } : {})
        };
        return { comparison, conditions };
      };
      const offline = async (scope: Scope) => {
        const { comparison, conditions } = context(scope);
        if (comparison < 0 || !(await canUse(actor, scope))) return [];
        const tasks = await index.list(
          scope.nodeId,
          scope.workspaceId,
          { ...conditions, ...(mine ? { ownerUserId: actor.userId } : {}) },
          pageSize + 1
        );
        if (!(await canUse(actor, scope))) return [];
        return tasks.map((task) => ({
          ...task,
          ...scope,
          offline: true,
          mine: task.ownerUserId === actor.userId
        }));
      };
      const offlineNodes = nodes.filter((node) => !node.connected);
      const [live, cached] = await Promise.all([
        Promise.all(
          scopes.map(async (scope) => {
            const { comparison, conditions } = context(scope);
            const partial = () => {
              unavailable.add(scope.nodeId);
            };
            const [tasks, upcoming] = await Promise.all([
              comparison < 0
                ? []
                : (async () => {
                    try {
                      const result = taskPage.parse(
                        await call(actor, scope, 'schedule.task.list', {
                          ...conditions,
                          mine,
                          limit: pageSize + 1
                        })
                      );
                      if (
                        result.tasks.some(
                          (task) =>
                            task.workspaceId !== scope.workspaceId ||
                            (mine && task.ownerUserId !== actor.userId)
                        )
                      )
                        throw new Error('NODE_RESPONSE_INVALID');
                      return result.tasks.map((task) => ({
                        ...task,
                        ...scope,
                        mine: task.ownerUserId === actor.userId
                      }));
                    } catch {
                      partial();
                      return [];
                    }
                  })(),
              query.includeUpcoming !== 'true' ||
              (query.state !== undefined && query.state !== 'scheduled')
                ? []
                : (async () => {
                    try {
                      const { items } = upcomingPage.parse(
                        await call(actor, scope, 'schedule.upcoming.list', {
                          mine,
                          asOf,
                          ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId })
                        })
                      );
                      if (items.some((item) => item.dueAt <= asOf))
                        throw new Error('NODE_RESPONSE_INVALID');
                      return items.map((item) => ({ ...item, ...scope }));
                    } catch {
                      partial();
                      return [];
                    }
                  })()
            ]);
            return (await canUse(actor, scope)) ? { tasks, upcoming } : { tasks: [], upcoming: [] };
          })
        ),
        Promise.all(
          offlineNodes.map(async (node) => {
            const ids = await index.workspaceIds(node.id);
            const visible = await project(
              actor,
              node,
              ids.map((id) => ({ id })),
              'index',
              query.workspaceId
            );
            return (await Promise.all(visible.map(offline))).flat();
          })
        )
      ]);
      const candidates = [...live.flatMap((batch) => batch.tasks), ...cached.flat()].sort(
        (a, b) =>
          binary(a.nodeId, b.nodeId) || binary(a.workspaceId, b.workspaceId) || binary(a.id, b.id)
      );
      const items = await Promise.all(
        candidates.slice(0, pageSize).map(async ({ ownerUserId, ...task }) => ({
          ...task,
          ownerName: (await database.userDisplayName(ownerUserId)) ?? null
        }))
      );
      const last = items.at(-1);
      return reply.send({
        items,
        nodes,
        unavailableNodeIds: [...unavailable].sort(binary),
        nextCursor:
          last !== undefined && candidates.length > pageSize
            ? encode({ nodeId: last.nodeId, workspaceId: last.workspaceId, taskId: last.id })
            : null,
        upcoming: live
          .flatMap((batch) => batch.upcoming)
          .sort(
            (a, b) => a.dueAt - b.dueAt || binary(a.nodeId, b.nodeId) || binary(a.taskId, b.taskId)
          )
          .slice(0, 6)
      });
    } catch (error) {
      return error instanceof z.ZodError
        ? sendError(reply, 400, 'SCHEDULE_INVALID')
        : databaseError(reply, error);
    }
  });

  app.get('/api/scheduled-occurrences', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    reply.header('cache-control', 'private, no-store');
    try {
      const query = filter
        .extend({ taskId: id.optional(), sessionId: id.optional() })
        .parse(request.query);
      if (
        (query.taskId !== undefined || query.sessionId !== undefined) &&
        (query.nodeId === undefined || query.workspaceId === undefined)
      )
        return sendError(reply, 400, 'SCHEDULE_INVALID');
      if (
        query.taskId !== undefined &&
        query.nodeId !== undefined &&
        query.workspaceId !== undefined &&
        !(await canUse(actor, { nodeId: query.nodeId, workspaceId: query.workspaceId }))
      )
        return sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
      const previous = decode(query.cursor, historyCursor);
      const { scopes, unavailable } = await directory(actor, query);
      if (query.taskId !== undefined && scopes.length === 0 && unavailable.size === 0)
        return sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
      const batches = await Promise.all(
        scopes.map(async (scope) => {
          try {
            const before =
              previous === undefined
                ? undefined
                : {
                    dueAt: previous.dueAt,
                    sameTime:
                      scope.nodeId < previous.nodeId
                        ? 'exclude'
                        : scope.nodeId > previous.nodeId
                          ? 'include'
                          : previous.occurrenceId
                  };
            const result = occurrencePage.parse(
              await call(actor, scope, 'schedule.occurrence.list', {
                mine: query.mine !== 'false',
                ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
                ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
                ...(before === undefined ? {} : { before })
              })
            );
            if (
              query.taskId !== undefined &&
              result.items.some((item) => item.taskId !== query.taskId)
            )
              throw new Error('NODE_RESPONSE_INVALID');
            return (await canUse(actor, scope))
              ? result.items.map((item) => ({ ...item, ...scope }))
              : [];
          } catch (error) {
            if (query.taskId !== undefined)
              throw error instanceof z.ZodError ? new Error('NODE_RESPONSE_INVALID') : error;
            unavailable.add(scope.nodeId);
            return [];
          }
        })
      );
      const candidates = batches
        .flat()
        .sort(
          (a, b) =>
            b.dueAt - a.dueAt ||
            binary(a.nodeId, b.nodeId) ||
            binary(b.occurrenceId, a.occurrenceId)
        );
      const items = candidates.slice(0, historyPageSize);
      const last = items.at(-1);
      return reply.send({
        items,
        unavailableNodeIds: [...unavailable].sort(binary),
        nextCursor:
          last !== undefined && candidates.length > historyPageSize
            ? encode({ nodeId: last.nodeId, dueAt: last.dueAt, occurrenceId: last.occurrenceId })
            : null
      });
    } catch (error) {
      return error instanceof z.ZodError
        ? sendError(reply, 400, 'SCHEDULE_INVALID')
        : databaseError(reply, error);
    }
  });

  app.get<{ Params: { taskId: string } }>(
    '/api/scheduled-tasks/:taskId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      reply.header('cache-control', 'private, no-store');
      const scope = address.safeParse(request.query);
      const taskId = id.safeParse(request.params.taskId);
      if (!scope.success || !taskId.success) return sendError(reply, 400, 'SCHEDULE_INVALID');
      try {
        const result = taskDetail.safeParse(
          await call(actor, scope.data, 'schedule.task.get', { taskId: taskId.data })
        );
        if (
          !result.success ||
          result.data.task.id !== taskId.data ||
          result.data.task.workspaceId !== scope.data.workspaceId
        )
          return sendError(reply, 502, 'NODE_RESPONSE_INVALID');
        if (!(await canUse(actor, scope.data))) return sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
        const { ownerUserId } = result.data.task;
        return reply.send({
          ...result.data,
          mine: ownerUserId === actor.userId,
          ownerName: (await database.userDisplayName(ownerUserId)) ?? null
        });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { occurrenceId: string } }>(
    '/api/scheduled-occurrences/:occurrenceId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      reply.header('cache-control', 'private, no-store');
      const scope = address.safeParse(request.query);
      const occurrenceId = id.safeParse(request.params.occurrenceId);
      if (!scope.success || !occurrenceId.success) return sendError(reply, 400, 'SCHEDULE_INVALID');
      try {
        const result = occurrenceDetail.safeParse(
          await call(actor, scope.data, 'schedule.occurrence.get', {
            occurrenceId: occurrenceId.data
          })
        );
        if (!result.success || result.data.occurrenceId !== occurrenceId.data)
          return sendError(reply, 502, 'NODE_RESPONSE_INVALID');
        return (await canUse(actor, scope.data))
          ? reply.send(result.data)
          : sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  for (const [method, url, operation, schema] of [
    [
      'POST',
      '/api/scheduled-tasks',
      'schedule.task.create',
      address.extend({ ...scheduledTaskWriteSchema.shape, target: scheduledTargetSchema })
    ],
    [
      'PUT',
      '/api/scheduled-tasks/:taskId',
      'schedule.task.update',
      mutation.extend({ patch: scheduledTaskOwnerPatchSchema })
    ],
    ['DELETE', '/api/scheduled-tasks/:taskId', 'schedule.task.remove', mutation],
    [
      'POST',
      '/api/scheduled-tasks/:taskId/proposals/:proposalId/resolve',
      'schedule.task.resolveProposal',
      address.extend({ accept: z.boolean() })
    ],
    [
      'POST',
      '/api/scheduled-tasks/preview',
      'schedule.preview',
      address.extend({ groups: scheduledTimeGroupsSchema, taskId: id.optional() })
    ]
  ] as const)
    app.route<{ Params: { taskId?: string; proposalId?: string } }>({
      method,
      url,
      async handler(request, reply) {
        if (!isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const actor = protectedAdmin(database, request, reply);
        if (actor === undefined) return;
        if (!validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
        const parsed = schema.strict().safeParse(request.body);
        const params = z
          .object({ taskId: id.optional(), proposalId: id.optional() })
          .safeParse(request.params);
        if (!parsed.success || !params.success) return sendError(reply, 400, 'SCHEDULE_INVALID');
        const { nodeId, workspaceId, ...fields } = parsed.data;
        try {
          const scope = { nodeId, workspaceId };
          const result = await call(actor, scope, operation, { ...fields, ...params.data });
          return reply.send(result);
        } catch (error) {
          return databaseError(reply, error);
        }
      }
    });
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decode<T>(value: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (value === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return schema.parse(null);
  }
}
