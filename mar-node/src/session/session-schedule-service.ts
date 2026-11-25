import { z } from 'zod';
import {
  scheduleToolInputs,
  scheduledTimeGroupsSchema,
  scheduledTaskOwnerPatchSchema,
  scheduledTaskWriteSchema,
  scheduledTaskIdSchema,
  scheduledTaskPatchSchema,
  scheduledTaskRevisionSchema,
  scheduledTaskStateSchema,
  MANAGEMENT_DEFAULT_LIMIT,
  MANAGEMENT_MAX_LIMIT
} from '@myagentroam/protocol';
import {
  scheduledTargetSchema,
  type ScheduledTarget,
  type ScheduledTimeGroup
} from '@myagentroam/protocol';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeAgentSession } from './contracts.js';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import { scheduledTimesAfter } from '../service/scheduled-session-recurrence.js';
import {
  occurrenceState,
  occurrenceSummary,
  ScheduledSessionStore,
  type ScheduledSessionTask
} from '../service/scheduled-session-store.js';
import { NODE_MCP } from '../mcp/naming.js';

interface SessionScheduleServiceOptions {
  readonly database: () => NodeDatabase;
  readonly runtime: NodeRuntimeState;
  readonly projection: NativeSessionProjectionService;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly changed?: (workspaceId: string) => void;
  readonly proposed?: (taskId: string, proposalId: string) => void;
}

type Scope = {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly actorUserId: number;
};
const pageSchema = z.object({
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional()
});
interface CreateFields {
  readonly name: string;
  readonly objective: string;
  readonly groups: readonly ScheduledTimeGroup[];
  readonly enabled?: boolean | undefined;
  readonly notifyOnTerminal?: boolean | undefined;
  readonly graceMinutes?: number | undefined;
}

/** Owns task use cases and scope checks. The store owns revisions and execution records;
 * callers supply trusted resource/actor scope, never a model-supplied identity. */
export class SessionScheduleService {
  constructor(private readonly options: SessionScheduleServiceOptions) {}

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'schedule.task.get': (data) => this.get(record(data)),
      'schedule.task.list': (data) => this.list(record(data)),
      'schedule.index.list': (data) => this.listIndex(record(data)),
      'schedule.task.create': (data) => this.createCommand(record(data), actorId(record(data))),
      'schedule.task.propose': (data) => this.saveFromAgent(record(data)),
      'schedule.task.update': (data) => this.save(record(data)),
      'schedule.task.remove': (data) => this.remove(record(data)),
      'schedule.task.resolveProposal': (data) => this.resolveProposal(record(data)),
      'schedule.preview': (data) => this.preview(record(data)),
      'schedule.occurrence.list': (data) => this.history(record(data)),
      'schedule.occurrence.get': (data) => this.historyDetail(record(data))
    };
  }

  async invokeMcp(scope: Scope, tool: string, payload: unknown): Promise<unknown> {
    const tools = NODE_MCP.schedule.tools;
    switch (tool) {
      case tools.list: {
        const args = parse(scheduleToolInputs.list, payload);
        const after =
          args.cursor === undefined ? undefined : parse(scheduledTaskIdSchema, args.cursor);
        const page = this.store().list(
          scope.workspaceId,
          undefined,
          args.limit,
          scope.sessionId,
          undefined,
          after
        );
        // A task ID is already public here; the Workspace list cursor encodes internal scope IDs.
        return {
          items: page.tasks.map(summary),
          ...(page.nextCursor === null ? {} : { nextCursor: page.tasks.at(-1)!.id })
        };
      }
      case tools.get: {
        const { taskId } = parse(scheduleToolInputs.get, payload);
        const task = this.task(scope, taskId);
        return modelDetail(task);
      }
      case tools.create: {
        const input = parse(scheduleToolInputs.create, payload);
        const session = this.options.runtime.getAgentSession(scope.sessionId);
        if (
          session?.workspaceId !== scope.workspaceId ||
          session.externalSessionId !== scope.sessionId
        )
          throw new Error('SCHEDULE_CAPABILITY_STALE');
        const task = this.create(
          { ...session, externalSessionId: scope.sessionId },
          scope.actorUserId,
          input
        );
        await this.publish(task, session);
        return { ...receipt(task), timezone: task.timezone };
      }
      case tools.update: {
        const { taskId, expectedRevision, patch } = parse(scheduleToolInputs.update, payload);
        const task = this.task(scope, taskId);
        const result = this.store().updateFromAgent(
          taskId,
          expectedRevision,
          scope.actorUserId,
          patch
        );
        if ('proposalId' in result) {
          this.options.changed?.(task.workspaceId);
          this.options.proposed?.(taskId, result.proposalId);
          return { proposalId: result.proposalId, baseRevision: result.baseRevision };
        }
        await this.publish(result);
        return receipt(result);
      }
      case tools.runs: {
        const { taskId, before, limit = 10 } = parse(scheduleToolInputs.runs, payload);
        this.task(scope, taskId);
        const rows = this.store().listSessionRuns(
          taskId,
          scope.sessionId,
          before ?? Number.MAX_SAFE_INTEGER,
          limit + 1
        );
        return {
          items: rows.slice(0, limit).map((row) => ({
            dueAt: row.due_at,
            state: occurrenceState(row.status, row.code, row.actual_started_at),
            ...(row.actual_started_at === null ? {} : { startedAt: row.actual_started_at }),
            ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
            ...(row.code === null ? {} : { reason: row.code }),
            ...(row.run_id === null ? {} : { runId: row.run_id })
          })),
          ...(rows.length <= limit ? {} : { nextBefore: rows[limit - 1]!.due_at })
        };
      }
      default:
        throw new Error('SCHEDULE_TOOL_INVALID');
    }
  }

  private list(input: Record<string, unknown>): unknown {
    const workspaceId = this.workspace(input);
    const sessionId = optionalId(input.sessionId);
    if (input.offset !== undefined) {
      if (input.cursor !== undefined || input.afterTaskId !== undefined || input.view === 'marctl')
        throw new Error('SCHEDULE_INVALID');
      const { offset, limit } = parse(
        z.object({
          offset: z.number().int().nonnegative().safe(),
          limit: z.number().int().min(0).max(MANAGEMENT_MAX_LIMIT)
        }),
        input
      );
      const result = this.store().listPage(
        workspaceId,
        {
          sessionId,
          ownerUserId: input.mine === true ? actorId(input) : undefined,
          state: parse(scheduledTaskStateSchema.optional(), input.state)
        },
        offset,
        limit
      );
      return { total: result.total, tasks: result.tasks.map(taskCard) };
    }
    const page = parse(pageSchema, input);
    if (input.view === 'marctl') {
      if (sessionId !== undefined) this.requireRegisteredSession(workspaceId, sessionId);
      const after = optionalId(page.cursor);
      const result = this.store().list(
        workspaceId,
        undefined,
        page.limit,
        sessionId,
        undefined,
        after
      );
      return marctl({
        tasks: result.tasks.map(summary),
        nextCursor: result.nextCursor === null ? null : result.tasks.at(-1)!.id
      });
    }
    const after =
      input.afterTaskId === undefined ? undefined : parse(scheduledTaskIdSchema, input.afterTaskId);
    const result = this.store().list(
      workspaceId,
      page.cursor,
      page.limit,
      sessionId,
      input.mine === true ? actorId(input) : undefined,
      after,
      parse(scheduledTaskStateSchema.optional(), input.state)
    );
    return {
      tasks: result.tasks.map(taskCard),
      nextCursor: result.nextCursor
    };
  }

  private listIndex(input: Record<string, unknown>): unknown {
    if (input.__requestUserId !== 0 || input.__workspaceWatchSessionHash !== 'scheduled-task-index')
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    return this.store().listIndex(this.workspace(input), optionalId(input.afterTaskId));
  }

  private async saveFromAgent(input: Record<string, unknown>): Promise<unknown> {
    const actor = actorId(input);
    const task = this.taskCommand(input);
    const result = this.store().updateFromAgent(
      task.id,
      revision(input),
      actor,
      parse(scheduledTaskPatchSchema, input.patch)
    );
    if ('proposalId' in result) {
      this.options.changed?.(task.workspaceId);
      this.options.proposed?.(task.id, result.proposalId);
      return input.view === 'marctl'
        ? marctl({ proposalId: result.proposalId, baseRevision: result.baseRevision })
        : result;
    }
    await this.publish(result);
    return input.view === 'marctl' ? marctl(receipt(result)) : { task: result };
  }

  private get(input: Record<string, unknown>): unknown {
    const task = this.taskCommand(input);
    if (input.view === 'marctl') return marctl({ task: modelDetail(task) });
    const store = this.store();
    const canResolveProposals = input.__requestUserId === task.ownerUserId;
    return {
      task,
      canResolveProposals,
      proposals: canResolveProposals ? proposals(store, task.id) : []
    };
  }

  private history(input: Record<string, unknown>): unknown {
    const workspaceId = this.workspace(input);
    const sessionId = optionalId(input.sessionId);
    const taskId =
      input.taskId === undefined
        ? undefined
        : this.task({ workspaceId }, parse(scheduledTaskIdSchema, input.taskId)).id;
    const page =
      input.view === 'marctl' && input.occurrencePage === undefined ? 1 : input.occurrencePage;
    if (page !== undefined) {
      if (taskId === undefined || typeof page !== 'number') throw new Error('SCHEDULE_INVALID');
      const { occurrences, ...paging } = this.store().recentPage(taskId, page, sessionId);
      if (input.view === 'marctl')
        return marctl({
          ...paging,
          occurrences: occurrences.map((row) => {
            const item = occurrenceSummary(row);
            return modelOccurrence(item);
          })
        });
      return { ...paging, occurrences: occurrences.map(occurrenceSummary) };
    }
    const { offset, limit } = parse(
      z.object({
        offset: z.number().int().nonnegative().safe().default(0),
        limit: z.number().int().min(1).max(MANAGEMENT_MAX_LIMIT).default(MANAGEMENT_DEFAULT_LIMIT)
      }),
      input
    );
    return this.store().history(
      workspaceId,
      {
        taskId,
        sessionId,
        ownerUserId: input.mine === true ? actorId(input) : undefined
      },
      offset,
      limit
    );
  }

  private historyDetail(input: Record<string, unknown>): unknown {
    const result = this.store().historyDetail(
      this.workspace(input),
      parse(scheduledTaskIdSchema, input.occurrenceId),
      optionalId(input.sessionId)
    );
    if (result === undefined) throw new Error('SCHEDULE_NOT_FOUND');
    return result;
  }

  private async save(input: Record<string, unknown>): Promise<unknown> {
    const actor = actorId(input);
    const current = this.taskCommand(input);
    requireOwner(current, actor);
    const expectedRevision = revision(input);
    if (current.revision !== expectedRevision) throw new Error('SCHEDULE_REVISION_CONFLICT');
    const { target, ...patch } = parse(scheduledTaskOwnerPatchSchema, input.patch);
    const binding =
      target === undefined ? undefined : await this.resolveTarget(current.workspaceId, target);
    const updated = this.store().update(current.id, expectedRevision, {
      ...patch,
      ...(binding === undefined ? {} : { binding })
    });
    await this.publish(updated);
    if (current.sessionId !== null && current.sessionId !== updated.sessionId)
      await this.publish({ ...current, nextRunAt: null });
    return { task: updated };
  }

  private async createCommand(input: Record<string, unknown>, actor: number): Promise<unknown> {
    const workspaceId = this.workspace(input);
    const target = parse(scheduledTargetSchema, input.target);
    const fields = parse(scheduledTaskWriteSchema, input);
    if (
      typeof input.sessionId === 'string' &&
      (target.kind !== 'existing' || target.sessionId !== input.sessionId)
    )
      throw new Error('SCHEDULE_SESSION_MISMATCH');
    if (input.view === 'marctl' && target.kind === 'existing')
      this.requireRegisteredSession(workspaceId, target.sessionId);
    const binding = await this.resolveTarget(workspaceId, target);
    const task = this.store().create({
      ...fields,
      ...binding,
      workspaceId,
      ownerUserId: actor,
      timezone: nodeTimezone()
    });
    await this.publish(task);
    return input.view === 'marctl'
      ? marctl({ ...receipt(task), timezone: task.timezone })
      : { task };
  }

  private async resolveTarget(workspaceId: string, target: ScheduledTarget) {
    if (target.kind === 'newSession') {
      const { kind: _kind, ...newSession } = target;
      return { sessionId: null, runner: target.runner, newSession };
    }
    const session = await this.requireSession({ workspaceId, sessionId: target.sessionId });
    this.registerSession(session);
    return { sessionId: session.externalSessionId, runner: session.runner, newSession: null };
  }

  private async remove(input: Record<string, unknown>): Promise<unknown> {
    const task = this.taskCommand(input);
    requireOwner(task, actorId(input));
    this.store().remove(task.id, revision(input));
    await this.publish({ ...task, nextRunAt: null });
    return { removed: true };
  }

  private async resolveProposal(input: Record<string, unknown>): Promise<unknown> {
    const task = this.taskCommand(input);
    const proposalId = parse(scheduledTaskIdSchema, input.proposalId);
    if (typeof input.accept !== 'boolean') throw new Error('SCHEDULE_PROPOSAL_INVALID');
    const store = this.store();
    const updated = store.resolveProposal(task.id, proposalId, actorId(input), input.accept);
    await this.publish(updated);
    return { task: updated, proposals: proposals(store, task.id) };
  }

  private preview(input: Record<string, unknown>): unknown {
    this.workspace(input);
    const timezone = input.taskId === undefined ? nodeTimezone() : this.taskCommand(input).timezone;
    const groups = parse(scheduledTimeGroupsSchema, input.groups);
    return { timezone, times: scheduledTimesAfter(groups, timezone, Date.now(), 5) };
  }

  private taskCommand(input: Record<string, unknown>): ScheduledSessionTask {
    return this.task(
      {
        workspaceId: this.workspace(input),
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: parse(scheduledTaskIdSchema, input.sessionId) })
      },
      parse(scheduledTaskIdSchema, input.taskId)
    );
  }

  private task(
    scope: { workspaceId: string; sessionId?: string },
    taskId: string
  ): ScheduledSessionTask {
    const task = this.store().getById(taskId);
    if (
      task?.workspaceId !== scope.workspaceId ||
      (scope.sessionId !== undefined && task.sessionId !== scope.sessionId)
    )
      throw new Error('SCHEDULE_NOT_FOUND');
    return task;
  }

  private workspace(input: Record<string, unknown>): string {
    if (
      typeof input.workspaceId !== 'string' ||
      this.options.database().getWorkspace(input.workspaceId) === undefined
    )
      throw new Error('WORKSPACE_NOT_FOUND');
    return input.workspaceId;
  }

  private async requireSession(
    input: Record<string, unknown>
  ): Promise<NodeAgentSession & { externalSessionId: string }> {
    const workspaceId = this.workspace(input);
    const sessionId = parse(scheduledTaskIdSchema, input.sessionId);
    const session =
      this.options.runtime.getAgentSession(sessionId) ??
      (await this.options.projection.createMetadataProjection(sessionId));
    if (
      session === undefined ||
      session.workspaceId !== workspaceId ||
      session.externalSessionId === null
    )
      throw new Error('SESSION_NOT_FOUND');
    return { ...session, externalSessionId: session.externalSessionId };
  }

  private requireRegisteredSession(workspaceId: string, sessionId: string): void {
    if (this.options.database().getSessionRecord(sessionId)?.workspaceId !== workspaceId)
      throw new Error('SESSION_NOT_FOUND');
  }

  private create(
    session: NodeAgentSession & { externalSessionId: string },
    ownerUserId: number,
    fields: CreateFields
  ) {
    this.registerSession(session);
    const { enabled, notifyOnTerminal, graceMinutes, ...task } = fields;
    return this.store().create({
      ...task,
      sessionId: session.externalSessionId,
      workspaceId: session.workspaceId,
      runner: session.runner,
      ownerUserId,
      timezone: nodeTimezone(),
      ...(enabled === undefined ? {} : { enabled }),
      ...(notifyOnTerminal === undefined ? {} : { notifyOnTerminal }),
      ...(graceMinutes === undefined ? {} : { graceMinutes })
    });
  }

  private registerSession(session: NodeAgentSession & { externalSessionId: string }): void {
    this.options.database().saveNativeSessionMetadata({
      runner: session.runner,
      externalSessionId: session.externalSessionId,
      workspaceId: session.workspaceId
    });
  }

  private async publish(task: ScheduledSessionTask, resolved?: NodeAgentSession): Promise<void> {
    this.options.changed?.(task.workspaceId);
    if (task.sessionId === null) return;
    const session =
      resolved ??
      this.options.runtime.getAgentSession(task.sessionId) ??
      (await this.options.projection.createMetadataProjection(task.sessionId));
    if (session === undefined) return;
    if (
      task.nextRunAt !== null &&
      this.options
        .database()
        .getNativeSessionMetadata(session.runner, task.sessionId, session.workspaceId)?.pinOrder ==
        null
    ) {
      await this.options.projection.rename(session, { pinned: true });
      this.options.runtime.updateSessionMetadata({ sessionId: session.id, pinned: true });
    }
    this.options.emitSession(this.options.runtime.getAgentSession(session.id) ?? session);
  }

  private store(): ScheduledSessionStore {
    return new ScheduledSessionStore(this.options.database().raw);
  }
}

function receipt(task: ScheduledSessionTask) {
  return { taskId: task.id, revision: task.revision, nextRunAt: task.nextRunAt };
}
function taskCard(task: ScheduledSessionTask & { sessionTitle: string | null }) {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    ownerUserId: task.ownerUserId,
    name: task.name,
    runner: task.runner,
    sessionId: task.sessionId,
    sessionTitle: task.sessionTitle,
    targetKind: task.sessionId !== null ? 'existing' : task.newSession ? 'newSession' : 'unbound',
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    objectivePreview: task.objective.slice(0, 180)
  };
}

function summary(task: ScheduledSessionTask) {
  return {
    ...receipt(task),
    name: task.name,
    state: !task.enabled ? 'PAUSED' : task.nextRunAt === null ? 'COMPLETE' : 'SCHEDULED'
  };
}
function modelDetail(task: ScheduledSessionTask) {
  return {
    ...summary(task),
    objective: task.objective,
    groups: task.groups,
    timezone: task.timezone
  };
}
function modelOccurrence(item: ReturnType<typeof occurrenceSummary>) {
  return {
    dueAt: item.dueAt,
    state: item.state,
    ...(item.startedAt === null ? {} : { startedAt: item.startedAt }),
    ...(item.endedAt === null ? {} : { endedAt: item.endedAt }),
    ...(item.reason === null ? {} : { reason: item.reason }),
    ...(item.run === null ? {} : { runId: item.run.runId })
  };
}
function marctl<T extends object>(data: T) {
  return { view: 'marctl' as const, ...data };
}
function optionalId(value: unknown): string | undefined {
  return value === undefined ? undefined : parse(scheduledTaskIdSchema, value);
}
function proposals(store: ScheduledSessionStore, taskId: string) {
  return store.pendingProposals(taskId).map((row) => ({
    id: row.id,
    baseRevision: row.base_revision,
    name: row.name,
    objective: row.objective,
    groups: row.time_groups === null ? null : JSON.parse(String(row.time_groups))
  }));
}
function nodeTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function parse<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  value: unknown
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('SCHEDULE_INVALID');
  return parsed.data;
}
function actorId(input: Record<string, unknown>): number {
  const actor = input.__requestUserId;
  if (typeof actor !== 'number' || !Number.isSafeInteger(actor) || actor < 1)
    throw new Error('USER_AUTHORIZATION_REQUIRED');
  return actor;
}
function revision(input: Record<string, unknown>): number {
  return parse(scheduledTaskRevisionSchema, input.expectedRevision);
}
function requireOwner(task: ScheduledSessionTask, actor: number): void {
  if (task.ownerUserId !== actor) throw new Error('SCHEDULE_OWNER_REQUIRED');
}
