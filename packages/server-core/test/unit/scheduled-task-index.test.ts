import { expect, it, vi } from 'vitest';
import {
  MysqlScheduledTaskIndex,
  ScheduledTaskIndex,
  ScheduledTaskIndexProjection
} from '../../src/scheduled-task-index.js';

const row = (id: string) => ({
  id,
  workspaceId: 'workspace',
  ownerUserId: 42,
  name: 'Task',
  runner: 'mar-agent' as const,
  sessionId: null,
  targetKind: 'newSession' as const,
  enabled: true,
  nextRunAt: 321,
  objective: 'do not persist',
  groups: []
});
const firstPage = {
  tasks: Array.from({ length: 100 }, (_, i) => row(String(i).padStart(3, '0'))),
  nextCursor: '099'
};

function fixture() {
  const store = { workspaceIds: vi.fn(), list: vi.fn(), replace: vi.fn() };
  const index = new ScheduledTaskIndex(store, () => 123);
  const onError = vi.fn();
  const input = { nodeId: 'node', workspaceId: 'workspace', current: () => true, onError };
  return { store, index, onError, input };
}

it('combines all pages and coalesces reads, projecting only the allowed card fields', async () => {
  const { store, index, onError, input } = fixture();
  const read = vi.fn(async (after?: string) =>
    after === undefined ? firstPage : { tasks: [row('100')], nextCursor: null }
  );
  const first = index.refresh({ ...input, read });
  expect(index.refresh({ ...input, read })).toBe(first);
  await first;
  expect(onError).not.toHaveBeenCalled();
  expect(read.mock.calls).toEqual([[undefined], ['099']]);
  expect(store.replace).toHaveBeenCalledTimes(1);
  const rows = store.replace.mock.calls[0]![2];
  expect(rows).toHaveLength(101);
  expect(rows.at(-1)).toEqual({
    id: '100',
    workspaceId: 'workspace',
    ownerUserId: 42,
    name: 'Task',
    runner: 'mar-agent',
    sessionId: null,
    targetKind: 'newSession',
    enabled: true,
    nextRunAt: 321
  });
});

it('does not erase the last complete index on a failed, incomplete or out-of-scope page', async () => {
  const { store, index, onError, input } = fixture();
  const rejectedPages = [
    async () => {
      throw new Error('NODE_OFFLINE');
    },
    async () => ({ tasks: [], nextCursor: 'missing page' }),
    async () => ({ tasks: [{ ...row('100'), targetKind: 'existing' }], nextCursor: null }),
    async () => ({ tasks: [{ ...row('100'), workspaceId: 'another' }], nextCursor: null }),
    async () => ({ tasks: [row('099')], nextCursor: null })
  ];
  for (const next of rejectedPages)
    await index.refresh({
      ...input,
      read: async (after) => (after === undefined ? firstPage : next())
    });
  await index.refresh({ ...input, read: async () => ({ ...firstPage, nextCursor: '098' }) });
  expect(onError).toHaveBeenCalledTimes(rejectedPages.length + 1);
  expect(store.replace).not.toHaveBeenCalled();
  await index.refresh({ ...input, read: async () => ({ tasks: [], nextCursor: null }) });
  expect(store.replace).toHaveBeenCalledExactlyOnceWith(
    'node',
    'workspace',
    [],
    123,
    expect.any(Function)
  );
});

it('discards an earlier connection reply and takes a fresh snapshot on the replacement', async () => {
  const { store, index, input } = fixture();
  const older = Promise.withResolvers<unknown>();
  let current = true;
  const first = index.refresh({ ...input, current: () => current, read: () => older.promise });
  await Promise.resolve();
  current = false;
  const next = index.refresh({
    ...input,
    read: async () => ({ tasks: [row('001')], nextCursor: null })
  });
  older.resolve({ tasks: [row('000')], nextCursor: null });
  await Promise.all([first, next]);
  expect(store.replace).toHaveBeenCalledTimes(1);
  expect(store.replace.mock.calls[0]![2]).toMatchObject([{ id: '001' }]);
});

it('refreshes on admitted connection and Workspace changes without any user request', async () => {
  const { index, store, onError } = fixture();
  let connected: object | undefined;
  const read = vi.fn(async (_nodeId: string, _connection: object, workspaceId: string) => ({
    tasks: [{ ...row('updated'), workspaceId }],
    nextCursor: null
  }));
  const workspaces = vi.fn(async () => ['workspace', 'another']);
  const projection = new ScheduledTaskIndexProjection(index, {
    connection: () => connected,
    workspaces,
    read,
    onError
  });
  projection.connectionChanged('node');
  projection.changed('node', 'workspace');
  expect(workspaces).not.toHaveBeenCalled();
  const socket = {};
  connected = socket;
  projection.connectionChanged('node');
  projection.connectionChanged('node');
  await projection.drain();
  expect(workspaces).toHaveBeenCalledExactlyOnceWith('node');
  expect(read.mock.calls).toEqual([
    ['node', socket, 'workspace', undefined],
    ['node', socket, 'another', undefined]
  ]);
  expect(store.replace).toHaveBeenCalledTimes(2);
  read.mockClear();
  projection.changed('node', 'another');
  projection.changed('node', 'another');
  await projection.drain();
  expect(read).toHaveBeenCalledExactlyOnceWith('node', socket, 'another', undefined);
  expect(store.replace).toHaveBeenCalledTimes(3);
  expect(onError).not.toHaveBeenCalled();
  projection.stop();
  projection.changed('node', 'workspace');
  await projection.drain();
  expect(store.replace).toHaveBeenCalledTimes(3);
});

it('coalesces Workspace invalidations into the next current snapshot without dropping the last commit', async () => {
  const { store, index, input } = fixture();
  const deferred = Promise.withResolvers<unknown>();
  const first = index.refresh({ ...input, read: () => deferred.promise });
  await Promise.resolve();
  index.invalidate(input.nodeId, input.workspaceId);
  const read = vi.fn(async () => ({ tasks: [row('009')], nextCursor: null }));
  const fresh = index.refresh({ ...input, read });
  index.invalidate(input.nodeId, input.workspaceId);
  expect(index.refresh({ ...input, read })).toBe(fresh);
  deferred.resolve({ tasks: [row('000')], nextCursor: null });
  await Promise.all([first, fresh]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.replace).toHaveBeenCalledTimes(1);
  expect(store.replace.mock.calls[0]![2]).toMatchObject([{ id: '009' }]);
});

it('rolls back rather than replacing rows if the connection no longer matches or a write fails', async () => {
  const execute = vi.fn(async (_sql: string): Promise<unknown> => [[{ id: 'parent' }]]);
  const connection = {
    execute,
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn()
  };
  const store = new MysqlScheduledTaskIndex({ getConnection: async () => connection } as never);
  const current = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  const { id, workspaceId, name, ownerUserId, runner, sessionId, enabled, nextRunAt } =
    row('task-one');
  const entries = [
    {
      id,
      workspaceId,
      name,
      ownerUserId,
      runner,
      sessionId,
      enabled,
      nextRunAt,
      targetKind: 'newSession' as const
    }
  ];
  await store.replace('node', workspaceId, entries, 123, current);
  expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining('FROM users WHERE id=? FOR SHARE'),
    expect.stringContaining('FOR SHARE'),
    expect.stringContaining('FOR UPDATE'),
    expect.stringContaining('DELETE FROM scheduled_task_index'),
    expect.stringContaining('INSERT INTO scheduled_task_index')
  ]);
  expect(connection.commit).not.toHaveBeenCalled();
  expect(connection.rollback).toHaveBeenCalledTimes(1);
  execute.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO')) throw new Error('TEST_WRITE_FAILURE');
    return [[{ id: 'parent' }]];
  });
  await expect(store.replace('node', workspaceId, entries, 123, () => true)).rejects.toThrow(
    'TEST_WRITE_FAILURE'
  );
  expect(connection.rollback).toHaveBeenCalledTimes(2);
  expect(connection.release).toHaveBeenCalledTimes(2);
});

it('bounds a prepared index read while binding the exact owner, session and cursor filters', async () => {
  const execute = vi.fn().mockResolvedValue([[]]);
  const store = new MysqlScheduledTaskIndex({ execute } as never);
  const filter = { ownerUserId: 42, sessionId: 'session', afterTaskId: 'task' };
  await expect(store.list('node', 'workspace', filter, 2.5)).rejects.toThrow(
    'SCHEDULE_INDEX_LIMIT_INVALID'
  );
  expect(execute).not.toHaveBeenCalled();
  await expect(store.list('node', 'workspace', filter, 21)).resolves.toEqual([]);
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(
      /AND owner_user_id=\?[\s\S]*AND session_id=\?[\s\S]*AND task_id>\? ORDER BY task_id LIMIT 21$/
    ),
    ['node', 'workspace', 42, 'session', 'task']
  );
});
