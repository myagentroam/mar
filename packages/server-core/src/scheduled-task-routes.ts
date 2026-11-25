import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MANAGEMENT_DEFAULT_LIMIT,
  MANAGEMENT_MAX_LIMIT,
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
import { managementPageQuery, ManagementQueryError } from './management-pagination.js';

const id = z.string().min(1).max(512);
const address = z.object({ nodeId: id, workspaceId: id });
const mutation = address.extend({ expectedRevision: scheduledTaskRevisionSchema });
const scopeFilter = address.partial();
const filter = scopeFilter.extend({
  mine: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(4096).optional()
});
const taskFilter = filter.extend({
  sessionId: id.optional(),
  state: scheduledTaskStateSchema.optional()
});
const listCursor = address.extend({ taskId: id });
const pageSize = 20;
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
  total: time,
  items: z.array(occurrenceSummary).max(MANAGEMENT_MAX_LIMIT)
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
type Occurrence = z.infer<typeof occurrenceSummary> & Scope;
class HistoryChanged extends Error {}
type HistoryBatch = {
  scope: Scope;
  total: number;
  items: Occurrence[];
  offset: number;
  index: number;
};

/** Merge only bounded Node batches. Node remains the owner of counts and local ordering. */
async function mergeHistoryPage(
  batches: HistoryBatch[],
  offset: number,
  limit: number,
  read: (batch: HistoryBatch, offset: number) => Promise<Occurrence[]>
): Promise<Occurrence[]> {
  const [first] = batches;
  if (first && batches.length === 1 && offset > 0) return read(first, offset);
  const items: Occurrence[] = [];
  for (let rank = 0; items.length < limit; rank++) {
    let selected: HistoryBatch | undefined;
    for (const batch of batches) {
      const row = batch.items[batch.index];
      const best = selected?.items[selected.index];
      if (
        row &&
        (!best ||
          (best.dueAt - row.dueAt ||
            binary(row.nodeId, best.nodeId) ||
            binary(best.occurrenceId, row.occurrenceId)) < 0)
      )
        selected = batch;
    }
    if (!selected) break;
    const item = selected.items[selected.index++]!;
    if (rank >= offset) items.push(item);
    if (items.length === limit) break;
    if (
      selected.index === selected.items.length &&
      selected.offset + selected.index < selected.total
    ) {
      selected.offset += selected.index;
      selected.index = 0;
      selected.items = await read(selected, selected.offset);
    }
  }
  return items;
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
    const visibleNodes = await schedules.nodes(actor.userId);
    const nodes = visibleNodes.filter(
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
        if (comparison < 0 || !(await canUse(actor, scope))) return undefined;
        const tasks = await index.list(
          scope.nodeId,
          scope.workspaceId,
          { ...conditions, ...(mine ? { ownerUserId: actor.userId } : {}) },
          pageSize + 1
        );
        if (!(await canUse(actor, scope))) return undefined;
        return {
          scope,
          tasks: tasks.map((task) => ({
            ...task,
            ...scope,
            offline: true,
            mine: task.ownerUserId === actor.userId
          }))
        };
      };
      const [live, cached] = await Promise.all([
        Promise.all(
          scopes.map(async (scope) => {
            const { comparison, conditions } = context(scope);
            if (comparison < 0) return undefined;
            let result: z.infer<typeof taskPage>;
            try {
              result = taskPage.parse(
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
            } catch {
              unavailable.add(scope.nodeId);
              return undefined;
            }
            if (!(await canUse(actor, scope))) return undefined;
            return {
              scope,
              tasks: result.tasks.map((task) => ({
                ...task,
                ...scope,
                mine: task.ownerUserId === actor.userId
              }))
            };
          })
        ),
        Promise.all(
          nodes
            .filter((node) => !node.connected)
            .map(async (node) => {
              const ids = await index.workspaceIds(node.id);
              const scopes = await project(
                actor,
                node,
                ids.map((id) => ({ id })),
                'index',
                query.workspaceId
              );
              return Promise.all(scopes.map(offline));
            })
        )
      ]);
      const readable = [...live, ...cached.flat()].filter((slice) => slice !== undefined);
      const candidates = readable
        .flatMap(({ tasks }) => tasks)
        .sort(
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
        ...(query.nodeId === undefined &&
        query.workspaceId === undefined &&
        query.sessionId === undefined &&
        cursor === undefined
          ? { workspaces: readable.map(({ scope }) => scope) }
          : {}),
        unavailableNodeIds: [...unavailable].sort(binary),
        nextCursor:
          last !== undefined && candidates.length > pageSize
            ? encode({ nodeId: last.nodeId, workspaceId: last.workspaceId, taskId: last.id })
            : null
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
      const raw = z.record(z.unknown()).parse(request.query);
      if (raw.cursor !== undefined) return sendError(reply, 400, 'SCHEDULE_INVALID');
      const query = scopeFilter
        .extend({
          taskId: id.optional(),
          sessionId: id.optional(),
          mine: z.enum(['true', 'false']).optional()
        })
        .parse(raw);
      const { page, limit } = managementPageQuery(raw) ?? {
        page: 1,
        limit: MANAGEMENT_DEFAULT_LIMIT
      };
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
      const { scopes, unavailable } = await directory(actor, query);
      if (query.taskId !== undefined && scopes.length === 0 && unavailable.size === 0)
        return sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
      const read = async (scope: Scope, offset: number) => {
        const result = occurrencePage.safeParse(
          await call(actor, scope, 'schedule.occurrence.list', {
            mine: query.mine !== 'false',
            ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
            ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
            limit,
            offset
          })
        );
        if (
          !result.success ||
          result.data.items.length !== Math.min(limit, Math.max(0, result.data.total - offset)) ||
          (query.taskId !== undefined &&
            result.data.items.some((item) => item.taskId !== query.taskId))
        )
          throw new Error('NODE_RESPONSE_INVALID');
        if (!(await canUse(actor, scope))) throw new Error('SCHEDULE_NOT_FOUND');
        return {
          total: result.data.total,
          items: result.data.items.map((item) => ({ ...item, ...scope }))
        };
      };
      const readable = (
        await Promise.all(
          scopes.map(async (scope) => {
            try {
              return { scope, ...(await read(scope, 0)), offset: 0, index: 0 };
            } catch (error) {
              if (query.taskId !== undefined) throw error;
              unavailable.add(scope.nodeId);
              return undefined;
            }
          })
        )
      ).filter((batch) => batch !== undefined);
      const batches = readable.filter((batch) => batch.total > 0);
      const total = batches.reduce((sum, batch) => sum + batch.total, 0);
      const actualPage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
      const items = await mergeHistoryPage(
        batches,
        (actualPage - 1) * limit,
        limit,
        async (batch, offset) => {
          const result = await read(batch.scope, offset);
          if (result.total !== batch.total) throw new HistoryChanged();
          return result.items;
        }
      );
      if ((await Promise.all(batches.map(({ scope }) => canUse(actor, scope)))).includes(false))
        return sendError(reply, 404, 'SCHEDULE_NOT_FOUND');
      return reply.send({
        items,
        ...(query.nodeId === undefined && query.workspaceId === undefined
          ? { workspaces: readable.map(({ scope }) => scope) }
          : {}),
        unavailableNodeIds: [...unavailable].sort(binary),
        page: actualPage,
        pageSize: limit,
        total,
        hasMore: actualPage < Math.ceil(total / limit)
      });
    } catch (error) {
      if (error instanceof HistoryChanged)
        return sendError(reply, 409, 'SCHEDULE_HISTORY_CHANGED', {
          message: 'Execution history changed while this page was loading. Retry the page.'
        });
      return error instanceof z.ZodError || error instanceof ManagementQueryError
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
