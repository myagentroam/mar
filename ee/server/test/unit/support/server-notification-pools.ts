import { vi } from 'vitest';

const events: string[] = [];
const pools: ReturnType<typeof pool>[] = [];
function pool() {
  let closed = false;
  let notification: Record<string, unknown> | undefined;
  const connection = {
    execute: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (closed) throw new Error('POOL_CLOSED');
      if (sql.includes('SELECT id FROM users')) return [[{ id: 1 }], []];
      if (sql.includes('SELECT locale')) return [[{ locale: 'en-US' }], []];
      if (sql.includes('SELECT username')) return [[{ username: 'admin' }], []];
      if (sql.includes('INSERT INTO workbench_notifications')) {
        notification = {
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
          target_type: 'WORKSPACE_SESSION',
          read_at: null,
          deleted_at: null
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM workbench_notifications')) return [[notification], []];
      if (sql.includes('SELECT p.* FROM web_push_clients'))
        return [
          [
            {
              id: 'client-1',
              binding_version: 1,
              enabled: true,
              user_id: 1,
              session_hash: 'session',
              endpoint: 'https://push.example.test/client-1',
              p256dh: 'public',
              auth_secret: 'auth',
              expiration_time: null
            }
          ],
          []
        ];
      if (sql.includes('DELETE FROM web_push_clients')) {
        events.push('expire-sql');
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    }),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined)
  };
  return {
    ...connection,
    getConnection: vi.fn(async () => connection),
    end: vi.fn(async () => {
      closed = true;
      events.push('pool-close');
    })
  };
}
export const mysql = {
  events,
  pools,
  createMysqlPool: vi.fn(() => {
    const value = pool();
    pools.push(value);
    return value;
  }),
  prepareMysqlDatabase: vi.fn(async () => undefined)
};
