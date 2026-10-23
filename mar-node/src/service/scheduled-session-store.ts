import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RunnerName } from '@myagentroam/protocol';
import {
  assertScheduleTimezone,
  nextScheduledAt,
  parseScheduledCron
} from './scheduled-session-recurrence.js';

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

export interface ScheduledSessionTask {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly ownerUserId: number;
  readonly notifyOnTerminal: boolean;
  readonly objective: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly nextRunAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ScheduledOccurrenceStatus =
  'CLAIMED' | 'SUBMITTED' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED';

export const SCHEDULE_RESTART_OUTCOME_UNKNOWN = 'SCHEDULE_RESTART_OUTCOME_UNKNOWN';

export class ScheduledSessionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  get(sessionId: string): ScheduledSessionTask | undefined {
    const row = this.database
      .prepare('SELECT * FROM scheduled_session_tasks WHERE session_id=?')
      .get(sessionId) as SqlRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  getById(taskId: string): ScheduledSessionTask | undefined {
    const row = this.database
      .prepare('SELECT * FROM scheduled_session_tasks WHERE id=?')
      .get(taskId) as SqlRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  listDue(at = this.now()): readonly ScheduledSessionTask[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM scheduled_session_tasks WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id'
        )
        .all(at) as SqlRow[]
    ).map(taskFromRow);
  }

  list(
    workspaceId: string,
    cursor?: string,
    limit = 20
  ): {
    tasks: readonly (ScheduledSessionTask & { sessionTitle: string })[];
    nextCursor: string | null;
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('SCHEDULE_INVALID');
    let after = '';
    if (cursor !== undefined) {
      try {
        if (cursor.length > 4096) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          workspaceId?: unknown;
          after?: unknown;
        };
        if (
          decoded.workspaceId !== workspaceId ||
          typeof decoded.after !== 'string' ||
          decoded.after.length < 1 ||
          decoded.after.length > 512
        )
          throw new Error();
        after = decoded.after;
      } catch {
        throw new Error('SCHEDULE_INVALID');
      }
    }
    const rows = this.database
      .prepare(
        `SELECT t.*, COALESCE(json_extract(s.metadata,'$.customTitle'),
         json_extract(s.metadata,'$.runnerTitle'),s.id) AS session_title
       FROM scheduled_session_tasks t JOIN agent_sessions s ON s.id=t.session_id
       WHERE t.workspace_id=? AND t.id>? ORDER BY t.id LIMIT ?`
      )
      .all(workspaceId, after, limit + 1) as SqlRow[];
    const tasks = rows
      .slice(0, limit)
      .map((row) => ({ ...taskFromRow(row), sessionTitle: row['session_title'] as string }));
    return {
      tasks,
      nextCursor:
        rows.length > limit
          ? Buffer.from(JSON.stringify({ workspaceId, after: tasks.at(-1)!.id })).toString(
              'base64url'
            )
          : null
    };
  }

  updateFromAgent(
    sessionId: string,
    expectedRevision: number,
    actorUserId: number,
    input: { readonly objective?: unknown; readonly cron?: unknown }
  ): ScheduledSessionTask | { proposalId: string; status: 'PENDING' } {
    if (!Number.isSafeInteger(actorUserId) || actorUserId < 1)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const task = this.get(sessionId);
    if (task === undefined) throw new Error('SCHEDULE_NOT_FOUND');
    if (task.revision !== expectedRevision) throw new Error('SCHEDULE_REVISION_CONFLICT');
    if (
      (input.objective !== undefined && typeof input.objective !== 'string') ||
      (input.cron !== undefined && typeof input.cron !== 'string') ||
      (input.objective === undefined && input.cron === undefined)
    )
      throw new Error('SCHEDULE_UPDATE_INVALID');
    const patch = {
      ...(input.objective === undefined ? {} : { objective: input.objective as string }),
      ...(input.cron === undefined ? {} : { cron: input.cron as string })
    };
    if (actorUserId === task.ownerUserId) return this.update(sessionId, expectedRevision, patch);
    return { proposalId: this.propose(task, actorUserId, patch), status: 'PENDING' };
  }

  nextDueAt(): number | null {
    const row = this.database
      .prepare('SELECT MIN(next_run_at) AS value FROM scheduled_session_tasks WHERE enabled=1')
      .get() as SqlRow;
    return typeof row['value'] === 'number' ? row['value'] : null;
  }

  create(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly runner: RunnerName;
    readonly ownerUserId: number;
    readonly notifyOnTerminal?: boolean;
    readonly objective: string;
    readonly cron: string;
    readonly timezone: string;
    readonly enabled?: boolean;
  }): ScheduledSessionTask {
    validate(input.objective, input.cron, input.timezone);
    if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1)
      throw new Error('SCHEDULE_OWNER_INVALID');
    const now = this.now();
    const task: ScheduledSessionTask = {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      runner: input.runner,
      ownerUserId: input.ownerUserId,
      notifyOnTerminal: input.notifyOnTerminal ?? false,
      cron: input.cron,
      timezone: input.timezone,
      objective: input.objective.trim(),
      id: randomUUID(),
      enabled: input.enabled !== false,
      revision: 1,
      nextRunAt: input.enabled === false ? null : nextScheduledAt(input.cron, input.timezone, now),
      createdAt: now,
      updatedAt: now
    };
    return this.write(() => {
      const session = this.database
        .prepare('SELECT workspace_id,runner FROM agent_sessions WHERE id=?')
        .get(task.sessionId);
      if (session === undefined) throw new Error('SESSION_NOT_FOUND');
      if (session['workspace_id'] !== task.workspaceId || session['runner'] !== task.runner)
        throw Object.assign(new Error('SCHEDULE_SESSION_MISMATCH'), {
          publicMessage: "The scheduled task must use its session's Workspace and Runner."
        });
      if (
        this.database.prepare('SELECT 1 FROM workspaces WHERE id=?').get(task.workspaceId) ===
        undefined
      )
        throw new Error('WORKSPACE_NOT_FOUND');
      this.database
        .prepare(
          `INSERT INTO scheduled_session_tasks
        (id,session_id,workspace_id,runner,owner_user_id,notify_on_terminal,objective,cron,timezone,enabled,revision,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          task.id,
          task.sessionId,
          task.workspaceId,
          task.runner,
          task.ownerUserId,
          task.notifyOnTerminal ? 1 : 0,
          task.objective,
          task.cron,
          task.timezone,
          task.enabled ? 1 : 0,
          1,
          task.nextRunAt,
          now,
          now
        );
      return task;
    });
  }

  update(
    sessionId: string,
    expectedRevision: number,
    patch: {
      readonly objective?: string;
      readonly cron?: string;
      readonly timezone?: string;
      readonly enabled?: boolean;
      readonly ownerUserId?: number;
      readonly notifyOnTerminal?: boolean;
    }
  ): ScheduledSessionTask {
    return this.write(() => {
      const current = this.get(sessionId);
      if (current === undefined) throw new Error('SCHEDULE_NOT_FOUND');
      if (current.revision !== expectedRevision) throw new Error('SCHEDULE_REVISION_CONFLICT');
      if (
        patch.ownerUserId !== undefined &&
        (!Number.isSafeInteger(patch.ownerUserId) || patch.ownerUserId < 1)
      )
        throw new Error('SCHEDULE_OWNER_INVALID');
      const objective = patch.objective ?? current.objective;
      const cron = patch.cron ?? current.cron;
      const timezone = patch.timezone ?? current.timezone;
      validate(objective, cron, timezone);
      const enabled = patch.enabled ?? current.enabled;
      const ownerUserId = patch.ownerUserId ?? current.ownerUserId;
      const nextRunAt = enabled
        ? patch.enabled === true || patch.cron !== undefined || patch.timezone !== undefined
          ? nextScheduledAt(cron, timezone, this.now())
          : current.nextRunAt
        : null;
      const now = this.now();
      const result = this.database
        .prepare(
          `UPDATE scheduled_session_tasks SET objective=?,cron=?,timezone=?,enabled=?,owner_user_id=?,notify_on_terminal=?,revision=?,next_run_at=?,updated_at=?
        WHERE session_id=? AND revision=?`
        )
        .run(
          objective.trim(),
          cron,
          timezone,
          enabled ? 1 : 0,
          ownerUserId,
          (patch.notifyOnTerminal ?? current.notifyOnTerminal) ? 1 : 0,
          expectedRevision + 1,
          nextRunAt,
          now,
          sessionId,
          expectedRevision
        );
      if (result.changes !== 1) throw new Error('SCHEDULE_REVISION_CONFLICT');
      this.database
        .prepare(
          `UPDATE scheduled_session_proposals SET status='STALE',resolved_at=?
      WHERE task_id=? AND status='PENDING' AND base_revision<?`
        )
        .run(now, current.id, expectedRevision + 1);
      this.database
        .prepare("DELETE FROM scheduled_session_proposals WHERE task_id=? AND status='STALE'")
        .run(current.id);
      return this.get(sessionId) as ScheduledSessionTask;
    });
  }

  remove(sessionId: string, expectedRevision: number): void {
    this.write(() => {
      const task = this.get(sessionId);
      if (task === undefined || task.revision !== expectedRevision)
        throw new Error('SCHEDULE_REVISION_CONFLICT');
      this.deleteTasks('id', task.id);
    });
  }

  removeForSession(sessionId: string): void {
    this.write(() => this.deleteTasks('session_id', sessionId));
  }

  removeForWorkspace(workspaceId: string): void {
    this.write(() => this.deleteTasks('workspace_id', workspaceId));
  }

  private deleteTasks(column: 'id' | 'session_id' | 'workspace_id', value: string): void {
    for (const table of ['scheduled_session_occurrences', 'scheduled_session_proposals']) {
      this.database
        .prepare(
          `DELETE FROM ${table} WHERE task_id IN
        (SELECT id FROM scheduled_session_tasks WHERE ${column}=?)`
        )
        .run(value);
    }
    this.database.prepare(`DELETE FROM scheduled_session_tasks WHERE ${column}=?`).run(value);
  }

  private write<T>(action: () => T): T {
    // A savepoint keeps this operation atomic both alone and inside a parent deletion.
    this.database.exec('SAVEPOINT scheduled_session_write');
    try {
      const result = action();
      this.database.exec('RELEASE scheduled_session_write');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK TO scheduled_session_write; RELEASE scheduled_session_write');
      throw error;
    }
  }

  claim(sessionId: string, dueAt: number, expectedRevision: number): string | undefined {
    const current = this.get(sessionId);
    if (
      current === undefined ||
      !current.enabled ||
      current.revision !== expectedRevision ||
      current.nextRunAt !== dueAt
    )
      return undefined;
    const next = nextScheduledAt(current.cron, current.timezone, Math.max(this.now(), dueAt));
    const id = `${current.id}:${dueAt}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          'UPDATE scheduled_session_tasks SET next_run_at=?,updated_at=? WHERE id=? AND revision=? AND next_run_at=?'
        )
        .run(next, this.now(), current.id, expectedRevision, dueAt);
      if (result.changes !== 1) {
        this.database.exec('ROLLBACK');
        return undefined;
      }
      this.database
        .prepare(
          `INSERT INTO scheduled_session_occurrences
          (id,task_id,due_at,status,created_at,updated_at) VALUES (?,?,?,'CLAIMED',?,?)`
        )
        .run(id, current.id, dueAt, this.now(), this.now());
      this.database.exec('COMMIT');
      return id;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recoverInterrupted(): readonly { task: ScheduledSessionTask; occurrenceId: string }[] {
    return this.write(() => {
      // FAILED closes scheduling bookkeeping, not the unknown execution or its side effects.
      const rows = this.database
        .prepare(
          `UPDATE scheduled_session_occurrences SET status='FAILED',code=?,updated_at=?
          WHERE status IN ('CLAIMED','SUBMITTED') RETURNING id,task_id`
        )
        .all(SCHEDULE_RESTART_OUTCOME_UNKNOWN, this.now()) as { id: string; task_id: string }[];
      const tasks = new Map<string, ScheduledSessionTask>();
      for (const row of rows) {
        if (tasks.has(row.task_id)) continue;
        const task = this.getById(row.task_id);
        if (task === undefined) throw new Error('SCHEDULE_TASK_NOT_FOUND');
        tasks.set(task.id, task);
        this.pruneTerminal(row.id);
      }
      return rows.map((row) => ({ task: tasks.get(row.task_id)!, occurrenceId: row.id }));
    });
  }

  finish(
    occurrenceId: string,
    status: Exclude<ScheduledOccurrenceStatus, 'CLAIMED'>,
    code?: string,
    runId?: string
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE scheduled_session_occurrences SET status=?,code=?,run_id=?,updated_at=?
        WHERE id=? AND status IN ('CLAIMED','SUBMITTED')`
      )
      .run(status, code ?? null, runId ?? null, this.now(), occurrenceId);
    if (result.changes !== 1) return false;
    if (status !== 'SUBMITTED') this.pruneTerminal(occurrenceId);
    return true;
  }

  private pruneTerminal(occurrenceId: string): void {
    this.database
      .prepare(
        `DELETE FROM scheduled_session_occurrences
      WHERE task_id=(SELECT task_id FROM scheduled_session_occurrences WHERE id=?)
        AND status NOT IN ('CLAIMED','SUBMITTED')
        AND id NOT IN (SELECT id FROM scheduled_session_occurrences
          WHERE task_id=(SELECT task_id FROM scheduled_session_occurrences WHERE id=?)
            AND status NOT IN ('CLAIMED','SUBMITTED') ORDER BY due_at DESC LIMIT 100)`
      )
      .run(occurrenceId, occurrenceId);
  }

  recent(taskId: string, limit = 20): readonly SqlRow[] {
    return this.database
      .prepare(
        'SELECT * FROM scheduled_session_occurrences WHERE task_id=? ORDER BY due_at DESC LIMIT ?'
      )
      .all(taskId, Math.max(1, Math.min(limit, 100))) as SqlRow[];
  }

  recentPage(
    taskId: string,
    page = 1
  ): {
    readonly occurrences: readonly SqlRow[];
    readonly occurrenceTotal: number;
    readonly occurrencePage: number;
  } {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('SCHEDULE_INVALID');
    const total = (
      this.database
        .prepare('SELECT COUNT(*) AS count FROM scheduled_session_occurrences WHERE task_id=?')
        .get(taskId) as { count: number }
    ).count;
    const actualPage = Math.min(page, Math.max(1, Math.ceil(total / 10)));
    const occurrences = this.database
      .prepare(
        'SELECT * FROM scheduled_session_occurrences WHERE task_id=? ORDER BY due_at DESC, id DESC LIMIT 10 OFFSET ?'
      )
      .all(taskId, (actualPage - 1) * 10) as SqlRow[];
    return { occurrences, occurrenceTotal: total, occurrencePage: actualPage };
  }

  pendingProposals(taskId: string): readonly SqlRow[] {
    return this.database
      .prepare(
        `SELECT * FROM scheduled_session_proposals
      WHERE task_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 50`
      )
      .all(taskId) as SqlRow[];
  }

  propose(
    task: ScheduledSessionTask,
    actorUserId: number,
    patch: {
      readonly objective?: string;
      readonly cron?: string;
      readonly timezone?: string;
    }
  ): string {
    if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId === task.ownerUserId)
      throw new Error('SCHEDULE_PROPOSAL_INVALID');
    if (patch.objective === undefined && patch.cron === undefined && patch.timezone === undefined)
      throw new Error('SCHEDULE_PROPOSAL_INVALID');
    validate(
      patch.objective ?? task.objective,
      patch.cron ?? task.cron,
      patch.timezone ?? task.timezone
    );
    return this.write(() => {
      const current = this.getById(task.id);
      if (current === undefined) throw new Error('SCHEDULE_NOT_FOUND');
      if (current.revision !== task.revision || current.ownerUserId !== task.ownerUserId)
        throw new Error('SCHEDULE_REVISION_CONFLICT');
      const pending = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM scheduled_session_proposals WHERE task_id=? AND status='PENDING'"
        )
        .get(task.id) as { count: number };
      if (pending.count >= 50) throw new Error('SCHEDULE_PROPOSAL_LIMIT');
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO scheduled_session_proposals
      (id,task_id,proposed_by_user_id,base_revision,objective,cron,timezone,status,created_at)
      VALUES (?,?,?,?,?,?,?,'PENDING',?)`
        )
        .run(
          id,
          task.id,
          actorUserId,
          task.revision,
          patch.objective ?? null,
          patch.cron ?? null,
          patch.timezone ?? null,
          this.now()
        );
      return id;
    });
  }

  resolveProposal(
    sessionId: string,
    proposalId: string,
    ownerUserId: number,
    accept: boolean
  ): ScheduledSessionTask {
    const task = this.get(sessionId);
    if (task === undefined) throw new Error('SCHEDULE_NOT_FOUND');
    if (task.ownerUserId !== ownerUserId) throw new Error('SCHEDULE_OWNER_REQUIRED');
    const proposal = this.database
      .prepare('SELECT * FROM scheduled_session_proposals WHERE id=? AND task_id=?')
      .get(proposalId, task.id) as SqlRow | undefined;
    if (proposal === undefined || proposal['status'] !== 'PENDING')
      throw new Error('SCHEDULE_PROPOSAL_NOT_FOUND');
    if (proposal['base_revision'] !== task.revision) throw new Error('SCHEDULE_REVISION_CONFLICT');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = accept
        ? this.update(sessionId, task.revision, {
            ...(proposal['objective'] === null
              ? {}
              : { objective: proposal['objective'] as string }),
            ...(proposal['cron'] === null ? {} : { cron: proposal['cron'] as string }),
            ...(proposal['timezone'] === null ? {} : { timezone: proposal['timezone'] as string }),
            ownerUserId
          })
        : task;
      this.database
        .prepare('UPDATE scheduled_session_proposals SET status=?,resolved_at=? WHERE id=?')
        .run(accept ? 'ACCEPTED' : 'REJECTED', this.now(), proposalId);
      this.database.prepare('DELETE FROM scheduled_session_proposals WHERE id=?').run(proposalId);
      this.database.exec('COMMIT');
      return updated;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function validate(objective: string, cron: string, timezone: string): void {
  if (objective.trim().length < 1 || objective.trim().length > 20_000)
    throw new Error('SCHEDULE_OBJECTIVE_INVALID');
  parseScheduledCron(cron);
  assertScheduleTimezone(timezone);
}

function taskFromRow(row: SqlRow): ScheduledSessionTask {
  return {
    id: row['id'] as string,
    sessionId: row['session_id'] as string,
    workspaceId: row['workspace_id'] as string,
    runner: row['runner'] as RunnerName,
    ownerUserId: Number(row['owner_user_id']),
    notifyOnTerminal: row['notify_on_terminal'] === 1,
    objective: row['objective'] as string,
    cron: row['cron'] as string,
    timezone: row['timezone'] as string,
    enabled: row['enabled'] === 1,
    revision: Number(row['revision']),
    nextRunAt: row['next_run_at'] === null ? null : Number(row['next_run_at']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  };
}
