import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { NodeAgentSession } from './contracts.js';
import type { NodeDatabase } from '../database.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { NativeSessionProjectionService } from './native-session-projection-service.js';
import {
  assertScheduleTimezone,
  parseScheduledCron
} from '../service/scheduled-session-recurrence.js';
import {
  ScheduledSessionStore,
  type ScheduledSessionTask
} from '../service/scheduled-session-store.js';

interface SessionScheduleServiceOptions {
  readonly database: () => NodeDatabase;
  readonly runtime: NodeRuntimeState;
  readonly projection: NativeSessionProjectionService;
  readonly present: (session: NodeAgentSession) => unknown;
  readonly emitSession: (session: NodeAgentSession) => void;
  readonly changed?: () => void;
  readonly proposed?: (sessionId: string, proposalId: string) => void;
  readonly awaitNativeSessionId: (sessionId: string) => Promise<string>;
}

export class SessionScheduleService {
  constructor(private readonly options: SessionScheduleServiceOptions) {}

  async createFromMcp(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly actorUserId: number;
    readonly objective: string;
    readonly cron: string;
  }): Promise<ScheduledSessionTask> {
    const session = this.options.runtime.getAgentSession(input.sessionId);
    if (session?.externalSessionId === null) await this.options.awaitNativeSessionId(session.id);
    const result = (await this.save({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      __requestUserId: input.actorUserId,
      objective: input.objective,
      cron: input.cron
    })) as { task: ScheduledSessionTask };
    return result.task;
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.schedule.get': (data) => this.get(record(data)),
      'session.schedule.list': (data) => this.list(record(data)),
      'session.schedule.agent.save': (data) => this.saveFromAgent(record(data)),
      'session.schedule.save': (data) => this.save(record(data)),
      'session.schedule.remove': (data) => this.remove(record(data)),
      'session.schedule.proposal.resolve': (data) => this.resolveProposal(record(data))
    };
  }

  private list(input: Record<string, unknown>): unknown {
    if (
      typeof input.workspaceId !== 'string' ||
      this.options.database().getWorkspace(input.workspaceId) === undefined
    )
      throw new Error('WORKSPACE_NOT_FOUND');
    if (
      (input.cursor !== undefined && typeof input.cursor !== 'string') ||
      (input.limit !== undefined && typeof input.limit !== 'number')
    )
      throw new Error('SCHEDULE_INVALID');
    const page = this.store().list(
      input.workspaceId,
      input.cursor as string | undefined,
      input.limit as number | undefined
    );
    return {
      ...page,
      tasks: page.tasks.map((task) => {
        const session = this.options.runtime.getAgentSession(task.sessionId);
        return {
          ...task,
          sessionTitle: session?.customTitle ?? session?.runnerTitle ?? task.sessionTitle
        };
      })
    };
  }

  private async saveFromAgent(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(input, input.mode === 'create');
    const actor = input.__requestUserId;
    if (!Number.isSafeInteger(actor) || (actor as number) < 1)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const sessionId = session.externalSessionId ?? session.id;
    if (input.mode === 'create') {
      if (this.store().get(sessionId) !== undefined) throw new Error('SCHEDULE_ALREADY_EXISTS');
      if (typeof input.objective !== 'string' || typeof input.cron !== 'string')
        throw new Error('SCHEDULE_INVALID');
      return {
        task: await this.createFromMcp({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          actorUserId: actor as number,
          objective: input.objective,
          cron: input.cron
        })
      };
    }
    if (input.mode !== 'update') throw new Error('SCHEDULE_INVALID');
    const result = this.store().updateFromAgent(
      sessionId,
      input.expectedRevision as number,
      actor as number,
      input
    );
    if ('proposalId' in result) {
      this.options.proposed?.(sessionId, result.proposalId);
      return result;
    }
    this.options.emitSession(this.options.runtime.getAgentSession(session.id) ?? session);
    this.options.changed?.();
    return { task: result };
  }

  private async get(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(input);
    const store = this.store();
    const task = store.get(session.externalSessionId ?? session.id);
    const page = input.occurrencePage === undefined ? 1 : input.occurrencePage;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)
      throw new Error('SCHEDULE_INVALID');
    return {
      task: task ?? null,
      nodeTimezone: nodeTimezone(),
      canResolveProposals: task !== undefined && input.__requestUserId === task.ownerUserId,
      ...(task === undefined
        ? { occurrences: [], occurrenceTotal: 0, occurrencePage: 1 }
        : store.recentPage(task.id, page)),
      proposals: task === undefined ? [] : store.pendingProposals(task.id)
    };
  }

  private async save(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(input);
    const actor = input.__requestUserId;
    if (!Number.isSafeInteger(actor) || (actor as number) < 1)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const sessionId = session.externalSessionId ?? session.id;
    const store = this.store();
    const current = store.get(sessionId);
    const objective = input.objective;
    const cron = input.cron;
    const notifyOnTerminal = input.notifyOnTerminal;
    const timezone = current === undefined ? nodeTimezone() : undefined;
    if (
      (objective !== undefined &&
        (typeof objective !== 'string' ||
          objective.trim().length < 1 ||
          objective.trim().length > 20_000)) ||
      (cron !== undefined && typeof cron !== 'string') ||
      (notifyOnTerminal !== undefined && typeof notifyOnTerminal !== 'boolean') ||
      input.timezone !== undefined ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    )
      throw new Error('SCHEDULE_INVALID');
    if (typeof cron === 'string') parseScheduledCron(cron);
    if (timezone !== undefined) assertScheduleTimezone(timezone);
    if (
      current === undefined &&
      (typeof objective !== 'string' || typeof cron !== 'string' || typeof timezone !== 'string')
    )
      throw new Error('SCHEDULE_INVALID');
    if (
      current !== undefined &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision)
    )
      throw new Error('SCHEDULE_REVISION_CONFLICT');
    const enabled = input.enabled !== false;
    if ((current === undefined || input.enabled === true) && enabled) await this.pin(session);
    else if (current === undefined)
      this.options.database().saveNativeSessionMetadata({
        runner: session.runner,
        externalSessionId: sessionId,
        workspaceId: session.workspaceId
      });
    const task =
      current === undefined
        ? store.create({
            sessionId,
            workspaceId: session.workspaceId,
            runner: session.runner,
            ownerUserId: actor as number,
            ...(notifyOnTerminal === undefined ? {} : { notifyOnTerminal }),
            objective: objective as string,
            cron: cron as string,
            timezone: timezone as string,
            enabled
          })
        : store.update(sessionId, current.revision, {
            ...(objective === undefined ? {} : { objective: objective as string }),
            ...(cron === undefined ? {} : { cron: cron as string }),
            ...(timezone === undefined ? {} : { timezone: timezone as string }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
            ownerUserId: actor as number,
            ...(notifyOnTerminal === undefined ? {} : { notifyOnTerminal })
          });
    const updated = this.options.runtime.getAgentSession(session.id) ?? session;
    this.options.emitSession(updated);
    this.options.changed?.();
    return { task, session: this.options.present(updated) };
  }

  private async remove(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(input);
    if (!Number.isSafeInteger(input.expectedRevision))
      throw new Error('SCHEDULE_REVISION_CONFLICT');
    this.store().remove(session.externalSessionId ?? session.id, input.expectedRevision as number);
    this.options.emitSession(session);
    this.options.changed?.();
    return { removed: true, session: this.options.present(session) };
  }

  private async resolveProposal(input: Record<string, unknown>): Promise<unknown> {
    const session = await this.requireSession(input);
    if (
      typeof input.proposalId !== 'string' ||
      typeof input.accept !== 'boolean' ||
      !Number.isSafeInteger(input.__requestUserId)
    )
      throw new Error('SCHEDULE_PROPOSAL_INVALID');
    const task = this.store().resolveProposal(
      session.externalSessionId ?? session.id,
      input.proposalId,
      input.__requestUserId as number,
      input.accept
    );
    this.options.emitSession(session);
    this.options.changed?.();
    return { task, proposals: this.store().pendingProposals(task.id) };
  }

  private async requireSession(
    input: Record<string, unknown>,
    allowPendingNative = false
  ): Promise<NodeAgentSession> {
    if (typeof input.sessionId !== 'string' || typeof input.workspaceId !== 'string')
      throw new Error('SCHEDULE_INVALID');
    const session =
      this.options.runtime.getAgentSession(input.sessionId) ??
      (await this.options.projection.createMetadataProjection(input.sessionId));
    if (
      session === undefined ||
      session.workspaceId !== input.workspaceId ||
      (session.externalSessionId === null && !allowPendingNative)
    )
      throw new Error('SESSION_NOT_FOUND');
    return session;
  }

  private async pin(session: NodeAgentSession): Promise<void> {
    const sessionId = session.externalSessionId ?? session.id;
    const existing = this.options
      .database()
      .getNativeSessionMetadata(session.runner, sessionId, session.workspaceId);
    if (existing?.pinOrder !== null && existing?.pinOrder !== undefined) return;
    await this.options.projection.rename(session, { pinned: true });
    this.options.runtime.updateSessionMetadata({ sessionId: session.id, pinned: true });
  }

  private store(): ScheduledSessionStore {
    return new ScheduledSessionStore(this.options.database().raw);
  }
}

function nodeTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
