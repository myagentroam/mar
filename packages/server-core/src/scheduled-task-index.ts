import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  runnerNameSchema,
  scheduledTaskTargetKindSchema,
  type ScheduledTaskState
} from '@myagentroam/protocol';
import { z } from 'zod';

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();
export const scheduledTaskIndexEntry = z.object({
  id,
  workspaceId: id,
  ownerUserId: z.number().int().positive().safe(),
  name: z.string().min(1).max(160),
  runner: runnerNameSchema,
  sessionId: z.string().min(1).max(512).nullable(),
  enabled: z.boolean(),
  nextRunAt: timestamp.nullable()
});
const baselineLimit = 100;
export const scheduledTaskCardEntry = scheduledTaskIndexEntry.extend({
  targetKind: scheduledTaskTargetKindSchema
});
const baselinePage = z.object({
  tasks: z.array(scheduledTaskCardEntry).max(baselineLimit),
  nextCursor: id.nullable()
});
type Entry = z.infer<typeof scheduledTaskCardEntry>;
export type IndexedScheduledTask = Entry & { readonly syncedAt: number };
const taskStateSql = {
  scheduled: 'AND enabled=1 AND next_run_at IS NOT NULL',
  paused: "AND enabled=0 AND target_kind<>'unbound'",
  finished: 'AND enabled=1 AND next_run_at IS NULL',
  unbound: "AND target_kind='unbound'"
} satisfies Record<ScheduledTaskState, string>;

export interface ScheduledTaskIndexStore {
  workspaceIds(nodeId: string): Promise<readonly string[]>;
  list(
    nodeId: string,
    workspaceId: string,
    filter: {
      ownerUserId?: number;
      sessionId?: string;
      afterTaskId?: string;
      state?: ScheduledTaskState;
    },
    limit: number
  ): Promise<readonly IndexedScheduledTask[]>;
  replace(
    nodeId: string,
    workspaceId: string,
    entries: readonly Entry[],
    syncedAt: number,
    current: () => boolean
  ): Promise<void>;
}

interface IndexRefresh {
  invalidated: boolean;
  started: boolean;
  current: () => boolean;
  settled: Promise<void>;
}

/** Maintains one complete snapshot per Workspace, never a partial or user-filtered page. */
export class ScheduledTaskIndex {
  private readonly pending = new Map<string, IndexRefresh>();

  constructor(
    readonly store: ScheduledTaskIndexStore,
    private readonly now = Date.now
  ) {}

  invalidate(nodeId: string, workspaceId: string): void {
    const pending = this.pending.get(JSON.stringify([nodeId, workspaceId]));
    if (pending?.started) pending.invalidated = true;
  }

  refresh(input: {
    nodeId: string;
    workspaceId: string;
    current: () => boolean;
    read: (afterTaskId?: string) => Promise<unknown>;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const key = JSON.stringify([input.nodeId, input.workspaceId]);
    const pending = this.pending.get(key);
    if (pending && !pending.current()) pending.invalidated = true;
    if (pending && !pending.invalidated) return pending.settled;
    const current = () => !state.invalidated && input.current();
    const refresh = (pending?.settled ?? Promise.resolve())
      .then(async () => {
        state.started = true;
        if (!current()) return;
        const entries: Entry[] = [];
        let after: string | undefined;
        for (;;) {
          const page = baselinePage.parse(await input.read(after));
          if (!current()) return;
          for (const task of page.tasks) {
            if (
              task.workspaceId !== input.workspaceId ||
              (after !== undefined && task.id <= after) ||
              (task.targetKind === 'existing') !== (task.sessionId !== null)
            )
              throw new Error('SCHEDULE_BASELINE_INVALID');
            entries.push(task);
            after = task.id;
          }
          if (page.nextCursor === null) break;
          if (page.tasks.length !== baselineLimit || page.nextCursor !== after)
            throw new Error('SCHEDULE_BASELINE_INVALID');
        }
        await this.store.replace(input.nodeId, input.workspaceId, entries, this.now(), current);
      })
      .catch(input.onError)
      .finally(() => {
        if (this.pending.get(key) === state) this.pending.delete(key);
      });
    const state = { invalidated: false, started: false, current: input.current, settled: refresh };
    this.pending.set(key, state);
    return refresh;
  }
}

/** Drives the index from accepted business connections and Workspace events, not user traffic. */
export class ScheduledTaskIndexProjection {
  private readonly seen = new Map<string, object>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly index: ScheduledTaskIndex,
    private readonly source: {
      connection(nodeId: string): object | undefined;
      workspaces(nodeId: string): Promise<readonly string[]>;
      read(
        nodeId: string,
        connection: object,
        workspaceId: string,
        afterTaskId?: string
      ): Promise<unknown>;
      onError(nodeId: string, workspaceId?: string): void;
    }
  ) {}

  connectionChanged(nodeId: string): void {
    if (this.stopped) return;
    const connection = this.source.connection(nodeId);
    if (connection === undefined) {
      this.seen.delete(nodeId);
      return;
    }
    if (this.seen.get(nodeId) === connection) return;
    this.seen.set(nodeId, connection);
    this.track(
      this.source
        .workspaces(nodeId)
        .then(async (workspaces) => {
          for (const workspaceId of workspaces) {
            if (!this.current(nodeId, connection)) break;
            await this.refresh(nodeId, connection, workspaceId);
          }
        })
        .catch(() => this.source.onError(nodeId))
    );
  }

  changed(nodeId: string, workspaceId: string): void {
    if (this.stopped) return;
    const connection = this.source.connection(nodeId);
    if (connection === undefined) return;
    this.index.invalidate(nodeId, workspaceId);
    this.track(this.refresh(nodeId, connection, workspaceId));
  }

  stop(): void {
    this.stopped = true;
    this.seen.clear();
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }

  private current(nodeId: string, connection: object): boolean {
    return !this.stopped && this.source.connection(nodeId) === connection;
  }

  private refresh(nodeId: string, connection: object, workspaceId: string): Promise<void> {
    return this.index.refresh({
      nodeId,
      workspaceId,
      current: () => this.current(nodeId, connection),
      read: (afterTaskId) => this.source.read(nodeId, connection, workspaceId, afterTaskId),
      onError: () => this.source.onError(nodeId, workspaceId)
    });
  }

  private track(request: Promise<void>): void {
    this.pending.add(request);
    void request.then(
      () => this.pending.delete(request),
      () => this.pending.delete(request)
    );
  }
}

/** Public persistence adapter. Resource removal uses the same parent-row locks as replacement. */
export class MysqlScheduledTaskIndex implements ScheduledTaskIndexStore {
  constructor(private readonly pool: Pool) {}

  async registeredWorkspaceIds(nodeId: string): Promise<readonly string[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT workspace_id FROM workspaces WHERE node_id=? ORDER BY workspace_id',
      [nodeId]
    );
    return rows.map((row) => String(row.workspace_id));
  }

  async workspaceIds(nodeId: string): Promise<readonly string[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT DISTINCT workspace_id FROM scheduled_task_index WHERE node_id=?',
      [nodeId]
    );
    return rows.map((row) => String(row.workspace_id));
  }

  async list(
    nodeId: string,
    workspaceId: string,
    filter: Parameters<ScheduledTaskIndexStore['list']>[2],
    limit: number
  ): Promise<readonly IndexedScheduledTask[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('SCHEDULE_INDEX_LIMIT_INVALID');
    // mysql2 binds numbers as DOUBLE, which MySQL can reject for a prepared LIMIT.
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT task_id,owner_user_id,name,runner,session_id,target_kind,enabled,next_run_at,synced_at FROM scheduled_task_index
       WHERE node_id=? AND workspace_id=?
       ${filter.ownerUserId === undefined ? '' : 'AND owner_user_id=?'}
       ${filter.sessionId === undefined ? '' : 'AND session_id=?'}
       ${filter.state === undefined ? '' : taskStateSql[filter.state]}
       ${filter.afterTaskId === undefined ? '' : 'AND task_id>?'} ORDER BY task_id LIMIT ${limit}`,
      [
        nodeId,
        workspaceId,
        ...[filter.ownerUserId, filter.sessionId, filter.afterTaskId].filter(
          (part) => part !== undefined
        )
      ]
    );
    return rows.map((row) => ({
      ...scheduledTaskIndexEntry.parse({
        id: row.task_id,
        workspaceId,
        ownerUserId: Number(row.owner_user_id),
        name: row.name,
        runner: row.runner,
        sessionId: row.session_id,
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at)
      }),
      targetKind: scheduledTaskTargetKindSchema.parse(row.target_kind),
      syncedAt: Number(row.synced_at)
    }));
  }

  async replace(
    nodeId: string,
    workspaceId: string,
    entries: readonly Entry[],
    syncedAt: number,
    current: () => boolean
  ): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const owners = new Set<number>();
      // Take user locks before Node/Workspace locks, matching account removal.
      for (const owner of [...new Set(entries.map((task) => task.ownerUserId))].sort(
        (a, b) => a - b
      )) {
        const [users] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM users WHERE id=? FOR SHARE',
          [owner]
        );
        if (users.length === 1) owners.add(owner);
      }
      const [nodes] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM nodes WHERE id=? AND disabled=0 FOR SHARE',
        [nodeId]
      );
      const [workspaces] = await connection.execute<RowDataPacket[]>(
        'SELECT workspace_id FROM workspaces WHERE workspace_id=? AND node_id=? FOR UPDATE',
        [workspaceId, nodeId]
      );
      if (nodes.length !== 1 || workspaces.length !== 1 || !current()) {
        await connection.rollback();
        return;
      }
      await removeScheduledTaskIndex(connection, { nodeId, workspaceId });
      for (const task of entries) {
        // An account can be removed independently of its tasks on the Node.
        if (!owners.has(task.ownerUserId)) continue;
        await connection.execute(
          `INSERT INTO scheduled_task_index
          (node_id,workspace_id,task_id,owner_user_id,name,runner,session_id,target_kind,enabled,next_run_at,synced_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            nodeId,
            workspaceId,
            task.id,
            task.ownerUserId,
            task.name,
            task.runner,
            task.sessionId,
            task.targetKind,
            task.enabled ? 1 : 0,
            task.nextRunAt,
            syncedAt
          ]
        );
      }
      if (current()) await connection.commit();
      else await connection.rollback();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function removeScheduledTaskIndex(
  connection: Pick<PoolConnection, 'execute'>,
  scope: { nodeId: string; workspaceId?: string } | { ownerUserId: number }
): Promise<void> {
  if ('ownerUserId' in scope) {
    await connection.execute('DELETE FROM scheduled_task_index WHERE owner_user_id=?', [
      scope.ownerUserId
    ]);
  } else if (scope.workspaceId === undefined) {
    await connection.execute('DELETE FROM scheduled_task_index WHERE node_id=?', [scope.nodeId]);
  } else {
    await connection.execute(
      'DELETE FROM scheduled_task_index WHERE node_id=? AND workspace_id=?',
      [scope.nodeId, scope.workspaceId]
    );
  }
}
