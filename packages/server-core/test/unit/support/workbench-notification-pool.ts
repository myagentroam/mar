import type { NotificationStore } from '../../../src/notification-contracts.js';

const capacity = 2;

/** Models competing pool leases, transactional writes, and committed-only pool reads. */
export function createWorkbenchNotificationPool(workspaceNames: ReadonlyMap<string, string>) {
  const bothUsersLocked = Promise.withResolvers<void>();
  const bothConsumesAtBoundary = Promise.withResolvers<void>();
  const waiters: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const commitGates = new Map<number, PromiseWithResolvers<void>>();
  const lockedUsers: number[] = [];
  const poolTitleReads: unknown[][] = [];
  const queuedTitleReads: unknown[][] = [];
  const transactionTitleReads: { userId: number; values: unknown[] }[] = [];
  const committed: Record<string, unknown>[] = [];
  let leased = 0;
  let stopped = false;

  function observeBoundary() {
    if (queuedTitleReads.length + commitGates.size === capacity) bothConsumesAtBoundary.resolve();
  }

  async function acquire() {
    if (stopped) throw new Error('Fake pool stopped');
    if (leased === capacity) {
      const waiter = Promise.withResolvers<void>();
      waiters.push(waiter);
      await waiter.promise;
    } else {
      leased++;
    }
  }

  function release() {
    const waiter = waiters.shift();
    if (waiter === undefined) leased--;
    else waiter.resolve();
  }

  function titleResult([workspaceId, nodeId]: unknown[]) {
    const name = workspaceNames.get(`${nodeId}/${workspaceId}`);
    return [name === undefined ? [] : [{ display_name: name }], []];
  }

  const raw = {
    async execute(sql: string, values: unknown[] = []) {
      const readsTitle = sql.startsWith('SELECT display_name FROM workspaces');
      if (readsTitle) {
        poolTitleReads.push(values);
        if (leased === capacity) {
          queuedTitleReads.push(values);
          observeBoundary();
        }
      }
      await acquire();
      try {
        if (readsTitle) return titleResult(values);
        if (sql.startsWith('DELETE FROM workbench_notifications')) return [{ affectedRows: 0 }, []];
        if (sql.startsWith('SELECT locale FROM users')) return [[{ locale: 'en-US' }], []];
        if (sql.startsWith('SELECT * FROM workbench_notifications WHERE id=')) {
          return [committed.filter((row) => row.id === values[0] && row.user_id === values[1]), []];
        }
        throw new Error(`Unexpected pool SQL: ${sql}`);
      } finally {
        release();
      }
    },
    async getConnection() {
      await acquire();
      let inTransaction = false;
      let userId: number | undefined;
      let pending: Record<string, unknown> | undefined;
      return {
        async beginTransaction() {
          inTransaction = true;
        },
        async execute(sql: string, values: unknown[] = []) {
          if (!inTransaction) throw new Error('Expected an active transaction');
          if (
            sql.startsWith('SELECT id FROM users') &&
            sql.endsWith('FOR SHARE') &&
            typeof values[0] === 'number'
          ) {
            userId = values[0];
            lockedUsers.push(userId);
            if (lockedUsers.length === capacity) bothUsersLocked.resolve();
            // Neither consume can attempt its title read until both connections are leased.
            await bothUsersLocked.promise;
            return [[{ id: userId }], []];
          }
          if (userId === undefined)
            throw new Error('Expected a user lock before reading or writing');
          if (sql.startsWith('SELECT display_name FROM workspaces')) {
            transactionTitleReads.push({ userId, values });
            return titleResult(values);
          }
          if (sql.startsWith('INSERT INTO workbench_notifications') && values[1] === userId) {
            pending = {
              id: values[0],
              user_id: values[1],
              source_id: values[2],
              kind: values[4],
              title: values[5],
              message: values[6],
              node_id: values[7],
              workspace_id: values[8],
              session_id: values[9],
              session_title: values[10],
              run_id: values[11],
              created_at: values[12],
              expires_at: values[13],
              session_group: values[14]
            };
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`Unexpected transaction SQL: ${sql}`);
        },
        async commit() {
          if (userId === undefined || pending === undefined)
            throw new Error('Expected a notification write before commit');
          const gate = Promise.withResolvers<void>();
          commitGates.set(userId, gate);
          observeBoundary();
          await gate.promise;
          commitGates.delete(userId);
          if (stopped) throw new Error('Fake pool stopped');
          committed.push(pending);
          inTransaction = false;
        },
        async rollback() {
          pending = undefined;
          inTransaction = false;
        },
        release
      };
    }
  };

  return {
    database: { raw } as unknown as NotificationStore,
    boundary: bothConsumesAtBoundary.promise,
    lockedUsers,
    poolTitleReads,
    queuedTitleReads,
    transactionTitleReads,
    committed,
    leased: () => leased,
    pendingCommits: () => commitGates.size,
    finishCommit(userId: number) {
      const gate = commitGates.get(userId);
      if (gate === undefined) throw new Error(`No pending commit for user ${userId}`);
      gate.resolve();
    },
    stop() {
      stopped = true;
      bothUsersLocked.resolve();
      for (const gate of commitGates.values()) gate.resolve();
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('Fake pool stopped'));
    }
  };
}
