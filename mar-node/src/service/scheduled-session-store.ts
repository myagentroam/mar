import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MANAGEMENT_DEFAULT_LIMIT,
  MANAGEMENT_MAX_LIMIT,
  scheduledTriggersSchema,
  type RunnerName,
  type ScheduledNewSession,
  type ScheduledTaskState,
  type ScheduledTrigger
} from '@myagentroam/protocol';
import {
  assertScheduleTimezone,
  scheduledRulesKey,
  scheduledTimesAfter
} from './scheduled-session-recurrence.js';

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

const occurrenceSession = `COALESCE(json_extract(o.task_snapshot,'$.sessionId'),
  CASE WHEN o.task_snapshot IS NULL AND EXISTS (SELECT 1 FROM agent_sessions s
    WHERE s.id=o.execution_session_id AND s.workspace_id=t.workspace_id) THEN o.execution_session_id END)`;
const taskStateSql = {
  scheduled: 'AND t.enabled=1 AND t.next_run_at IS NOT NULL',
  paused: 'AND t.enabled=0 AND (t.session_id IS NOT NULL OR t.new_session IS NOT NULL)',
  finished: 'AND t.enabled=1 AND t.next_run_at IS NULL',
  unbound: 'AND t.session_id IS NULL AND t.new_session IS NULL'
} satisfies Record<ScheduledTaskState, string>;

type TaskListFilter = {
  sessionId?: string | undefined;
  ownerUserId?: number | undefined;
  state?: ScheduledTaskState | undefined;
};
const taskListFrom = 'FROM scheduled_session_tasks t';
const taskListSelect = `SELECT t.*, COALESCE(json_extract(s.metadata,'$.customTitle'),
  json_extract(s.metadata,'$.runnerTitle'),s.id) AS session_title
  ${taskListFrom} LEFT JOIN agent_sessions s ON s.id=t.session_id`;

function taskListScope(workspaceId: string, { sessionId, ownerUserId, state }: TaskListFilter) {
  return {
    where: `WHERE t.workspace_id=? ${sessionId === undefined ? '' : 'AND t.session_id=?'}
      ${ownerUserId === undefined ? '' : 'AND t.owner_user_id=?'} ${state === undefined ? '' : taskStateSql[state]}`,
    params: [
      workspaceId,
      ...(sessionId === undefined ? [] : [sessionId]),
      ...(ownerUserId === undefined ? [] : [ownerUserId])
    ]
  };
}

function taskWithSessionTitle(row: SqlRow) {
  return { ...taskFromRow(row), sessionTitle: row['session_title'] as string | null };
}

export interface ScheduledSessionTask {
  readonly id: string;
  readonly sessionId: string | null;
  readonly newSession: ScheduledNewSession | null;
  readonly workspaceId: string;
  readonly runner: RunnerName;
  readonly ownerUserId: number;
  readonly notifyOnTerminal: boolean;
  readonly graceMinutes: number;
  readonly name: string;
  readonly objective: string;
  readonly triggers: readonly ScheduledTrigger[];
  readonly timezone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly nextRunAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ScheduledOccurrenceStatus =
  | 'CLAIMED'
  | 'WAITING'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'SUCCEEDED'
  | 'SKIPPED'
  | 'FAILED'
  | 'CANCELLED';

export const SCHEDULE_RESTART_OUTCOME_UNKNOWN = 'SCHEDULE_RESTART_OUTCOME_UNKNOWN';
export const SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN = 'SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN';

export function occurrenceState(
  status: string,
  reason: string | null,
  startedAt: number | null
): string {
  if (reason === SCHEDULE_RESTART_OUTCOME_UNKNOWN || reason === SCHEDULE_SUBMISSION_OUTCOME_UNKNOWN)
    return 'UNKNOWN';
  if (status === 'SKIPPED' && reason === 'SCHEDULE_EXPIRED') return 'EXPIRED';
  return (status === 'SUBMITTING' || status === 'SUBMITTED') && startedAt !== null
    ? 'RUNNING'
    : status;
}

/** Owns durable task revisions and the atomic handoff from a planned minute to an occurrence. */
export class ScheduledSessionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  nextForSession(sessionId: string): number | null {
    const row = this.database
      .prepare(
        `SELECT MIN(next_run_at) AS value FROM scheduled_session_tasks
      WHERE session_id=? AND enabled=1`
      )
      .get(sessionId);
    return (row?.['value'] as number | null) ?? null;
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
    limit = 20,
    sessionId?: string,
    ownerUserId?: number,
    afterTaskId?: string,
    state?: ScheduledTaskState
  ): {
    tasks: readonly (ScheduledSessionTask & { sessionTitle: string | null })[];
    nextCursor: string | null;
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('SCHEDULE_INVALID');
    let after = afterTaskId ?? '';
    if (cursor !== undefined) {
      try {
        if (cursor.length > 4096 || afterTaskId !== undefined) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          workspaceId?: unknown;
          sessionId?: unknown;
          ownerUserId?: unknown;
          state?: unknown;
          after?: unknown;
        };
        if (
          decoded.workspaceId !== workspaceId ||
          decoded.sessionId !== sessionId ||
          decoded.ownerUserId !== ownerUserId ||
          decoded.state !== state ||
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
    const { where, params } = taskListScope(workspaceId, { sessionId, ownerUserId, state });
    const rows = this.database
      .prepare(`${taskListSelect} ${where} AND t.id>? ORDER BY t.id LIMIT ?`)
      .all(...params, after, limit + 1) as SqlRow[];
    const tasks = rows.slice(0, limit).map(taskWithSessionTitle);
    return {
      tasks,
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                workspaceId,
                sessionId,
                ownerUserId,
                state,
                after: tasks.at(-1)!.id
              })
            ).toString('base64url')
          : null
    };
  }

  listPage(workspaceId: string, filter: TaskListFilter, offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > MANAGEMENT_MAX_LIMIT
    )
      throw new Error('SCHEDULE_INVALID');
    const { where, params } = taskListScope(workspaceId, filter);
    this.database.exec('BEGIN');
    try {
      const { total } = this.database
        .prepare(`SELECT COUNT(*) AS total ${taskListFrom} ${where}`)
        .get(...params) as { total: number };
      const tasks =
        limit === 0 || offset >= total
          ? []
          : (
              this.database
                .prepare(`${taskListSelect} ${where} ORDER BY t.id LIMIT ? OFFSET ?`)
                .all(...params, limit, offset) as SqlRow[]
            ).map(taskWithSessionTitle);
      this.database.exec('COMMIT');
      return { total, tasks };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listIndex(workspaceId: string, afterTaskId?: string) {
    const limit = 100;
    const rows = this.database
      .prepare(
        `SELECT id,workspace_id,owner_user_id,name,runner,session_id,enabled,next_run_at,
         CASE WHEN session_id IS NOT NULL THEN 'existing'
              WHEN new_session IS NOT NULL THEN 'newSession' ELSE 'unbound' END AS target_kind
       FROM scheduled_session_tasks WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?`
      )
      .all(workspaceId, afterTaskId ?? '', limit + 1) as SqlRow[];
    const tasks = rows.slice(0, limit).map((row) => ({
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      ownerUserId: Number(row.owner_user_id),
      name: row.name as string,
      runner: row.runner as RunnerName,
      sessionId: row.session_id as string | null,
      targetKind: row.target_kind as 'existing' | 'newSession' | 'unbound',
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at)
    }));
    return { tasks, nextCursor: rows.length > limit ? tasks.at(-1)!.id : null };
  }

  updateFromAgent(
    taskId: string,
    expectedRevision: number,
    actorUserId: number,
    patch: AgentTaskPatch
  ): ScheduledSessionTask | { proposalId: string; baseRevision: number; status: 'PENDING' } {
    if (!Number.isSafeInteger(actorUserId) || actorUserId < 1)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const task = this.getById(taskId);
    if (task === undefined) throw new Error('SCHEDULE_NOT_FOUND');
    if (task.revision !== expectedRevision) throw new Error('SCHEDULE_REVISION_CONFLICT');
    if (patch.name === undefined && patch.objective === undefined && patch.triggers === undefined)
      throw new Error('SCHEDULE_UPDATE_INVALID');
    if (actorUserId === task.ownerUserId) return this.update(taskId, expectedRevision, patch);
    return {
      proposalId: this.propose(task, actorUserId, patch),
      baseRevision: task.revision,
      status: 'PENDING'
    };
  }

  nextDueAt(): number | null {
    const row = this.database
      .prepare('SELECT MIN(next_run_at) AS value FROM scheduled_session_tasks WHERE enabled=1')
      .get() as SqlRow;
    return typeof row['value'] === 'number' ? row['value'] : null;
  }

  create(input: {
    readonly sessionId: string | null;
    readonly newSession?: ScheduledNewSession | null;
    readonly workspaceId: string;
    readonly runner: RunnerName;
    readonly ownerUserId: number;
    readonly notifyOnTerminal?: boolean | undefined;
    readonly graceMinutes?: number | undefined;
    readonly objective: string;
    readonly name: string;
    readonly triggers: readonly ScheduledTrigger[];
    readonly timezone: string;
    readonly enabled?: boolean | undefined;
  }): ScheduledSessionTask {
    const triggers = normalizeTriggers(input.triggers);
    validate(input.objective, input.timezone);
    if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1)
      throw new Error('SCHEDULE_OWNER_INVALID');
    const now = this.now();
    const task: ScheduledSessionTask = {
      sessionId: input.sessionId,
      newSession: input.newSession ?? null,
      workspaceId: input.workspaceId,
      runner: input.runner,
      ownerUserId: input.ownerUserId,
      notifyOnTerminal: input.notifyOnTerminal ?? false,
      graceMinutes: input.graceMinutes ?? 0,
      name: normalizeName(input.name),
      triggers,
      timezone: input.timezone,
      objective: input.objective.trim(),
      id: randomUUID(),
      enabled: input.enabled !== false,
      revision: 1,
      nextRunAt: input.enabled === false ? null : requireNext(triggers, input.timezone, now),
      createdAt: now,
      updatedAt: now
    };
    return this.write(() => {
      this.checkTarget(task.workspaceId, task.sessionId, task.runner, task.newSession);
      if (
        this.database.prepare('SELECT 1 FROM workspaces WHERE id=?').get(task.workspaceId) ===
        undefined
      )
        throw new Error('WORKSPACE_NOT_FOUND');
      this.database
        .prepare(
          `INSERT INTO scheduled_session_tasks
        (id,session_id,new_session,workspace_id,runner,owner_user_id,notify_on_terminal,grace_minutes,name,objective,triggers,timezone,enabled,revision,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          task.id,
          task.sessionId,
          task.newSession === null ? null : JSON.stringify(task.newSession),
          task.workspaceId,
          task.runner,
          task.ownerUserId,
          task.notifyOnTerminal ? 1 : 0,
          task.graceMinutes,
          task.name,
          task.objective,
          JSON.stringify(task.triggers),
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

  private checkTarget(
    workspaceId: string,
    sessionId: string | null,
    runner: RunnerName,
    newSession: ScheduledNewSession | null
  ): void {
    if (sessionId === null) {
      if (newSession !== null && newSession.runner === runner) return;
      throw new Error('SCHEDULE_TARGET_REQUIRED');
    }
    const session = this.database
      .prepare('SELECT workspace_id,runner FROM agent_sessions WHERE id=?')
      .get(sessionId);
    if (session === undefined) throw new Error('SESSION_NOT_FOUND');
    if (session['workspace_id'] !== workspaceId || session['runner'] !== runner)
      throw new Error('SCHEDULE_SESSION_MISMATCH');
  }

  update(taskId: string, expectedRevision: number, patch: TaskPatch): ScheduledSessionTask {
    return this.write(() => {
      const current = this.getById(taskId);
      if (current === undefined) throw new Error('SCHEDULE_NOT_FOUND');
      if (current.revision !== expectedRevision) throw new Error('SCHEDULE_REVISION_CONFLICT');
      const objective = patch.objective ?? current.objective;
      const name = patch.name === undefined ? current.name : normalizeName(patch.name);
      const triggers =
        patch.triggers === undefined ? current.triggers : normalizeTriggers(patch.triggers);
      const timezone = patch.timezone ?? current.timezone;
      validate(objective, timezone);
      const enabled = patch.enabled ?? current.enabled;
      const { sessionId, runner, newSession } = patch.binding ?? current;
      if (patch.binding !== undefined || enabled)
        this.checkTarget(current.workspaceId, sessionId, runner, newSession);
      const now = this.now();
      const nextRunAt = enabled
        ? !current.enabled ||
          (triggers !== current.triggers &&
            scheduledRulesKey(triggers) !== scheduledRulesKey(current.triggers)) ||
          timezone !== current.timezone
          ? requireNext(triggers, timezone, now)
          : current.nextRunAt
        : null;
      const result = this.database
        .prepare(
          `UPDATE scheduled_session_tasks SET session_id=?,new_session=?,runner=?,name=?,objective=?,triggers=?,timezone=?,enabled=?,notify_on_terminal=?,grace_minutes=?,revision=?,next_run_at=?,updated_at=?
        WHERE id=? AND revision=?`
        )
        .run(
          sessionId,
          newSession === null ? null : JSON.stringify(newSession),
          runner,
          name,
          objective.trim(),
          JSON.stringify(triggers),
          timezone,
          enabled ? 1 : 0,
          (patch.notifyOnTerminal ?? current.notifyOnTerminal) ? 1 : 0,
          patch.graceMinutes ?? current.graceMinutes,
          expectedRevision + 1,
          nextRunAt,
          now,
          taskId,
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
      return this.getById(taskId)!;
    });
  }

  remove(taskId: string, expectedRevision: number): void {
    this.write(() => {
      const task = this.getById(taskId);
      if (task === undefined || task.revision !== expectedRevision)
        throw new Error('SCHEDULE_REVISION_CONFLICT');
      if (
        this.database
          .prepare(
            `SELECT 1 FROM scheduled_session_occurrences WHERE task_id=?
        AND status IN ('CLAIMED','WAITING','SUBMITTING','SUBMITTED') LIMIT 1`
          )
          .get(taskId) !== undefined
      )
        throw new Error('SCHEDULE_IN_PROGRESS');
      this.deleteTasks('id', task.id);
    });
  }

  unbindSession(sessionId: string): boolean {
    const now = this.now();
    this.database
      .prepare(
        `UPDATE scheduled_session_proposals SET status='STALE',resolved_at=?
      WHERE status='PENDING' AND task_id IN (SELECT id FROM scheduled_session_tasks WHERE session_id=?)`
      )
      .run(now, sessionId);
    return (
      this.database
        .prepare(
          `UPDATE scheduled_session_tasks SET session_id=NULL, enabled=0,
      next_run_at=NULL, revision=revision+1, updated_at=? WHERE session_id=?`
        )
        .run(now, sessionId).changes > 0
    );
  }

  removeForWorkspace(workspaceId: string): void {
    this.write(() => this.deleteTasks('workspace_id', workspaceId));
  }

  private deleteTasks(column: 'id' | 'workspace_id', value: string): void {
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

  claim(taskId: string, dueAt: number, expectedRevision: number): string | undefined {
    const current = this.getById(taskId);
    if (
      current === undefined ||
      !current.enabled ||
      current.revision !== expectedRevision ||
      current.nextRunAt !== dueAt
    )
      return undefined;
    const now = this.now();
    const recurring = current.triggers.filter((trigger) => trigger.kind !== 'once');
    const finite = current.triggers.filter((trigger) => trigger.kind === 'once');
    const nextRecurring = scheduledTimesAfter(
      recurring,
      current.timezone,
      Math.max(now, dueAt),
      1
    )[0]?.dueAt;
    const nextFinite = scheduledTimesAfter(finite, current.timezone, dueAt, 1)[0]?.dueAt;
    const next =
      nextRecurring === undefined
        ? (nextFinite ?? null)
        : Math.min(nextRecurring, nextFinite ?? Infinity);
    const match = scheduledTimesAfter(
      current.triggers,
      current.timezone,
      Math.max(0, dueAt - 1),
      1
    )[0];
    const matchedTriggers = match?.dueAt === dueAt ? match.matchedTriggers : [];
    const isFinite = matchedTriggers.some((index) => current.triggers[index]?.kind === 'once');
    const expiresAt = isFinite ? dueAt + current.graceMinutes * 60_000 : null;
    const snapshot = JSON.stringify({
      name: current.name,
      objective: current.objective,
      revision: current.revision,
      sessionId: current.sessionId,
      ownerUserId: current.ownerUserId,
      timezone: current.timezone,
      matchedTriggers,
      target: current.newSession
    });
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
      const inserted = this.database
        .prepare(
          `INSERT INTO scheduled_session_occurrences
          (id,task_id,due_at,status,created_at,updated_at,task_snapshot,expires_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(task_id,due_at) DO NOTHING`
        )
        .run(
          id,
          current.id,
          dueAt,
          isFinite && current.graceMinutes > 0 ? 'WAITING' : 'CLAIMED',
          now,
          now,
          snapshot,
          expiresAt
        );
      this.database.exec('COMMIT');
      return inserted.changes === 1 ? id : undefined;
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
          WHERE status IN ('CLAIMED','SUBMITTING','SUBMITTED')
          RETURNING id,task_id,COALESCE(execution_session_id,json_extract(task_snapshot,'$.sessionId')) AS session_id`
        )
        .all(SCHEDULE_RESTART_OUTCOME_UNKNOWN, this.now()) as {
        id: string;
        task_id: string;
        session_id: string | null;
      }[];
      const tasks = new Map<string, ScheduledSessionTask>();
      for (const row of rows) {
        if (tasks.has(row.task_id)) continue;
        const task = this.getById(row.task_id);
        if (task === undefined) throw new Error('SCHEDULE_TASK_NOT_FOUND');
        tasks.set(task.id, task);
        this.pruneTerminal(row.id);
      }
      return rows.map((row) => ({
        task: { ...tasks.get(row.task_id)!, sessionId: row.session_id },
        occurrenceId: row.id
      }));
    });
  }

  finish(
    occurrenceId: string,
    status: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED',
    code?: string,
    runId?: string,
    endedAt?: number
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE scheduled_session_occurrences SET status=?,code=?,run_id=COALESCE(?,run_id),updated_at=?,ended_at=?
        WHERE id=? AND status IN ('CLAIMED','WAITING','SUBMITTING','SUBMITTED')
          AND (run_id IS NULL OR ? IS NULL OR run_id=?)`
      )
      .run(
        status,
        code ?? null,
        runId ?? null,
        this.now(),
        endedAt ?? null,
        occurrenceId,
        runId ?? null,
        runId ?? null
      );
    if (result.changes !== 1) return false;
    if (status !== 'SUBMITTED') this.pruneTerminal(occurrenceId);
    return true;
  }

  occurrence(occurrenceId: string) {
    return this.database
      .prepare(
        `SELECT task_id,due_at,expires_at,status,run_id,
      COALESCE(execution_session_id,json_extract(task_snapshot,'$.sessionId')) AS execution_session_id,
      json_extract(task_snapshot,'$.revision') AS revision FROM scheduled_session_occurrences WHERE id=?`
      )
      .get(occurrenceId) as
      | {
          task_id: string;
          due_at: number;
          expires_at: number | null;
          status: ScheduledOccurrenceStatus;
          run_id: string | null;
          revision: number | null;
          execution_session_id: string | null;
        }
      | undefined;
  }

  waiting() {
    return this.database
      .prepare(
        `SELECT id,task_id,due_at,expires_at,
      json_extract(task_snapshot,'$.revision') AS revision FROM scheduled_session_occurrences WHERE status='WAITING'
      ORDER BY due_at,task_id`
      )
      .all() as {
      id: string;
      task_id: string;
      due_at: number;
      expires_at: number;
      revision: number;
    }[];
  }

  nextWaitingDeadline(): number | null {
    const row = this.database
      .prepare(
        `SELECT MIN(expires_at) AS value FROM scheduled_session_occurrences WHERE status='WAITING'`
      )
      .get();
    return (row?.['value'] as number | null) ?? null;
  }

  waitForAvailability(occurrenceId: string, reason: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE scheduled_session_occurrences SET status='WAITING',code=?,updated_at=?
      WHERE id=? AND status IN ('CLAIMED','WAITING') AND (status<>'WAITING' OR code IS NOT ?)`
        )
        .run(reason, this.now(), occurrenceId, reason).changes === 1
    );
  }

  beginSubmission(occurrenceId: string, sessionId: string | null): boolean {
    return (
      this.database
        .prepare(
          `UPDATE scheduled_session_occurrences SET status='SUBMITTING',code=NULL,
      updated_at=?,execution_session_id=? WHERE id=? AND status IN ('CLAIMED','WAITING')`
        )
        .run(this.now(), sessionId, occurrenceId).changes === 1
    );
  }

  started(occurrenceId: string, runId: string, sessionId: string | null, at: number): boolean {
    return (
      this.database
        .prepare(
          `UPDATE scheduled_session_occurrences SET run_id=COALESCE(run_id,?),
      execution_session_id=COALESCE(execution_session_id,?),actual_started_at=COALESCE(actual_started_at,?)
      WHERE id=? AND status IN ('SUBMITTING','SUBMITTED') AND (run_id IS NULL OR run_id=?)
        AND (actual_started_at IS NULL OR (? IS NOT NULL AND execution_session_id IS NULL))`
        )
        .run(runId, sessionId, at, occurrenceId, runId, sessionId).changes === 1
    );
  }

  bindExecutionSession(occurrenceId: string, sessionId: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE scheduled_session_occurrences SET execution_session_id=?
          WHERE id=? AND execution_session_id IS NULL`
        )
        .run(sessionId, occurrenceId).changes === 1
    );
  }

  history(
    workspaceId: string,
    input: {
      taskId?: string | undefined;
      ownerUserId?: number | undefined;
      sessionId?: string | undefined;
    },
    offset = 0,
    limit = MANAGEMENT_DEFAULT_LIMIT
  ) {
    const { taskId, ownerUserId, sessionId } = input;
    const scope = `FROM scheduled_session_occurrences o JOIN scheduled_session_tasks t ON t.id=o.task_id
      WHERE t.workspace_id=? AND (? IS NULL OR t.id=?) AND (? IS NULL OR t.owner_user_id=?)
      AND (? IS NULL OR ${occurrenceSession}=?)`;
    const parameters = [
      workspaceId,
      taskId ?? null,
      taskId ?? null,
      ownerUserId ?? null,
      ownerUserId ?? null,
      sessionId ?? null,
      sessionId ?? null
    ];
    this.database.exec('BEGIN');
    let total: number;
    let rows: SqlRow[];
    try {
      ({ total } = this.database
        .prepare(`SELECT COUNT(*) AS total ${scope}`)
        .get(...parameters) as {
        total: number;
      });
      rows =
        total <= offset
          ? []
          : (this.database
              .prepare(
                `SELECT o.id,o.task_id,o.due_at,o.status,o.code,o.run_id,o.actual_started_at,o.ended_at,
        o.execution_session_id,json_extract(o.task_snapshot,'$.name') AS name ${scope}
        ORDER BY o.due_at DESC,o.id DESC LIMIT ? OFFSET ?`
              )
              .all(...parameters, limit, offset) as SqlRow[]);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return { total, items: rows.map(occurrenceSummary) };
  }

  historyDetail(workspaceId: string, id: string, sessionId?: string) {
    const row = this.database
      .prepare(
        `SELECT o.*,json_extract(o.task_snapshot,'$.name') AS name
      FROM scheduled_session_occurrences o JOIN scheduled_session_tasks t ON o.task_id=t.id
      WHERE t.workspace_id=? AND o.id=? AND (? IS NULL OR ${occurrenceSession}=?)`
      )
      .get(workspaceId, id, sessionId ?? null, sessionId ?? null) as SqlRow | undefined;
    return row === undefined
      ? undefined
      : {
          ...occurrenceSummary(row),
          snapshot: row.task_snapshot === null ? null : JSON.parse(String(row.task_snapshot))
        };
  }

  private pruneTerminal(occurrenceId: string): void {
    this.database
      .prepare(
        `DELETE FROM scheduled_session_occurrences
      WHERE task_id=(SELECT task_id FROM scheduled_session_occurrences WHERE id=?)
        AND status NOT IN ('CLAIMED','WAITING','SUBMITTING','SUBMITTED')
        AND id NOT IN (SELECT id FROM scheduled_session_occurrences
          WHERE task_id=(SELECT task_id FROM scheduled_session_occurrences WHERE id=?)
            AND status NOT IN ('CLAIMED','WAITING','SUBMITTING','SUBMITTED') ORDER BY due_at DESC LIMIT 100)`
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

  listSessionRuns(taskId: string, sessionId: string, before: number, limit: number) {
    return this.database
      .prepare(
        `SELECT o.due_at,o.status,o.code,o.run_id,o.actual_started_at,o.ended_at
      FROM scheduled_session_occurrences o JOIN scheduled_session_tasks t ON o.task_id=t.id
      WHERE o.task_id=? AND ${occurrenceSession}=? AND o.due_at<?
      ORDER BY o.due_at DESC LIMIT ?`
      )
      .all(taskId, sessionId, before, limit) as {
      due_at: number;
      status: ScheduledOccurrenceStatus;
      code: string | null;
      run_id: string | null;
      actual_started_at: number | null;
      ended_at: number | null;
    }[];
  }

  recentPage(
    taskId: string,
    page = 1,
    sessionId?: string
  ): {
    readonly occurrences: readonly SqlRow[];
    readonly occurrenceTotal: number;
    readonly occurrencePage: number;
  } {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('SCHEDULE_INVALID');
    const total = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM scheduled_session_occurrences o
          JOIN scheduled_session_tasks t ON o.task_id=t.id WHERE o.task_id=? AND (? IS NULL OR ${occurrenceSession}=?)`
        )
        .get(taskId, sessionId ?? null, sessionId ?? null) as { count: number }
    ).count;
    const actualPage = Math.min(page, Math.max(1, Math.ceil(total / 10)));
    const occurrences = this.database
      .prepare(
        `SELECT o.*,json_extract(o.task_snapshot,'$.name') AS name FROM scheduled_session_occurrences o
         JOIN scheduled_session_tasks t ON o.task_id=t.id WHERE o.task_id=? AND (? IS NULL OR ${occurrenceSession}=?)
         ORDER BY o.due_at DESC, o.id DESC LIMIT 10 OFFSET ?`
      )
      .all(taskId, sessionId ?? null, sessionId ?? null, (actualPage - 1) * 10) as SqlRow[];
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

  propose(task: ScheduledSessionTask, actorUserId: number, patch: AgentTaskPatch): string {
    if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId === task.ownerUserId)
      throw new Error('SCHEDULE_PROPOSAL_INVALID');
    if (patch.name === undefined && patch.objective === undefined && patch.triggers === undefined)
      throw new Error('SCHEDULE_PROPOSAL_INVALID');
    validate(patch.objective ?? task.objective, task.timezone);
    const name = patch.name === undefined ? null : normalizeName(patch.name);
    const triggers =
      patch.triggers === undefined ? null : JSON.stringify(normalizeTriggers(patch.triggers));
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
      (id,task_id,proposed_by_user_id,base_revision,name,objective,triggers,status,created_at)
      VALUES (?,?,?,?,?,?,?,'PENDING',?)`
        )
        .run(
          id,
          task.id,
          actorUserId,
          task.revision,
          name,
          patch.objective ?? null,
          triggers,
          this.now()
        );
      return id;
    });
  }

  resolveProposal(
    taskId: string,
    proposalId: string,
    ownerUserId: number,
    accept: boolean
  ): ScheduledSessionTask {
    const task = this.getById(taskId);
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
        ? this.update(taskId, task.revision, {
            ...(proposal['name'] === null ? {} : { name: proposal['name'] as string }),
            ...(proposal['objective'] === null
              ? {}
              : { objective: proposal['objective'] as string }),
            ...(proposal['triggers'] === null
              ? {}
              : { triggers: JSON.parse(proposal['triggers'] as string) as ScheduledTrigger[] }),
            ...(proposal['timezone'] === null ? {} : { timezone: proposal['timezone'] as string })
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

export interface AgentTaskPatch {
  readonly name?: string | undefined;
  readonly objective?: string | undefined;
  readonly triggers?: readonly ScheduledTrigger[] | undefined;
}

interface TaskPatch extends AgentTaskPatch {
  readonly binding?: Pick<ScheduledSessionTask, 'sessionId' | 'runner' | 'newSession'>;
  readonly timezone?: string;
  readonly enabled?: boolean | undefined;
  readonly notifyOnTerminal?: boolean | undefined;
  readonly graceMinutes?: number | undefined;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 160) throw new Error('SCHEDULE_NAME_INVALID');
  return name;
}

function normalizeTriggers(triggers: readonly ScheduledTrigger[]): readonly ScheduledTrigger[] {
  const parsed = scheduledTriggersSchema.safeParse(triggers);
  if (!parsed.success) throw new Error('SCHEDULE_INVALID');
  return parsed.data;
}

function requireNext(
  triggers: readonly ScheduledTrigger[],
  timezone: string,
  after: number
): number {
  const next = scheduledTimesAfter(triggers, timezone, after, 1)[0];
  if (next === undefined) throw new Error('SCHEDULE_NEXT_TIME_UNAVAILABLE');
  return next.dueAt;
}

function validate(objective: string, timezone: string): void {
  if (objective.trim().length < 1 || objective.trim().length > 20_000)
    throw new Error('SCHEDULE_OBJECTIVE_INVALID');
  assertScheduleTimezone(timezone);
}

function taskFromRow(row: SqlRow): ScheduledSessionTask {
  return {
    id: row['id'] as string,
    sessionId: row['session_id'] as string | null,
    newSession:
      row['new_session'] === null
        ? null
        : (JSON.parse(row['new_session'] as string) as ScheduledNewSession),
    workspaceId: row['workspace_id'] as string,
    runner: row['runner'] as RunnerName,
    ownerUserId: Number(row['owner_user_id']),
    notifyOnTerminal: row['notify_on_terminal'] === 1,
    graceMinutes: Number(row['grace_minutes']),
    name: row['name'] as string,
    objective: row['objective'] as string,
    triggers: JSON.parse(row['triggers'] as string) as ScheduledTrigger[],
    timezone: row['timezone'] as string,
    enabled: row['enabled'] === 1,
    revision: Number(row['revision']),
    nextRunAt: row['next_run_at'] === null ? null : Number(row['next_run_at']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  };
}

export function occurrenceSummary(row: SqlRow) {
  const runId = row.run_id as string | null;
  const sessionId = row.execution_session_id as string | null;
  return {
    occurrenceId: row.id as string,
    taskId: row.task_id as string,
    dueAt: Number(row.due_at),
    state: occurrenceState(
      String(row.status),
      row.code as string | null,
      row.actual_started_at as number | null
    ),
    reason: row.code as string | null,
    name: row.name as string | null,
    startedAt: row.actual_started_at as number | null,
    endedAt: row.ended_at as number | null,
    run: runId === null || sessionId === null ? null : { runId, sessionId }
  };
}
