import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { ScheduledTaskState } from '@myagentroam/protocol';
import { SESSION_COOKIE_NAME } from '../../src/auth.js';
import { databaseError } from '../../src/domain-errors.js';
import type {
  IndexedScheduledTask,
  ScheduledTaskIndexStore
} from '../../src/scheduled-task-index.js';
import {
  registerScheduledTaskRoutes,
  type ScheduledTaskDirectory
} from '../../src/scheduled-task-routes.js';
import { hashOpaque } from '../../src/session-token.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=session`,
  origin: 'https://mar.test',
  'x-csrf-token': 'csrf'
};
const groups = [{ days: { kind: 'anyDay' }, times: { kind: 'times', times: ['12:00'] } }];
const future = 4_000_000_000_000;
function matchesState(
  task: { enabled: boolean; nextRunAt: number | null; targetKind: string },
  state?: ScheduledTaskState
): boolean {
  return (
    state === undefined ||
    state ===
      (task.targetKind === 'unbound'
        ? 'unbound'
        : !task.enabled
          ? 'paused'
          : task.nextRunAt === null
            ? 'finished'
            : 'scheduled')
  );
}
function task(id: string, workspaceId: string, ownerUserId = 1, nextRunAt: number | null = future) {
  return {
    id,
    workspaceId,
    ownerUserId,
    name: `Task ${id}`,
    runner: 'mar-agent' as const,
    sessionId: 'session-one',
    targetKind: 'existing' as const,
    newSession: null,
    enabled: true,
    nextRunAt,
    sessionTitle: 'Session title',
    objectivePreview: 'Online instructions',
    objective: 'Sensitive full instructions',
    groups
  };
}

function fixture() {
  const app = Fastify();
  apps.push(app);
  const connections = new Map([
    ['a', {}],
    ['b', {}]
  ]);
  const visible = new Set(['a:a1', 'b:b1']);
  const capable = new Set(['a', 'b']);
  const localTasks = new Map<string, ReturnType<typeof task>[]>([
    ['a:a1', [task('a-task', 'a1')]],
    ['b:b1', [task('b-task', 'b1', 7)]]
  ]);
  const persisted = new Map<string, readonly IndexedScheduledTask[]>([
    [
      'b:b1',
      [
        {
          id: 'b-task',
          workspaceId: 'b1',
          ownerUserId: 7,
          name: 'Task b-task',
          runner: 'mar-agent',
          sessionId: 'session-one',
          targetKind: 'existing',
          enabled: true,
          nextRunAt: future,
          syncedAt: 123
        }
      ]
    ]
  ]);
  const store: Pick<ScheduledTaskIndexStore, 'list' | 'workspaceIds'> = {
    workspaceIds: async (nodeId) =>
      [...persisted.keys()]
        .filter((key) => key.startsWith(`${nodeId}:`))
        .map((key) => key.split(':')[1]!),
    list: vi.fn(async (nodeId, workspaceId, filter, limit) =>
      (persisted.get(`${nodeId}:${workspaceId}`) ?? [])
        .filter(
          (item) => filter.ownerUserId === undefined || filter.ownerUserId === item.ownerUserId
        )
        .filter((item) => filter.sessionId === undefined || filter.sessionId === item.sessionId)
        .filter((item) => filter.afterTaskId === undefined || item.id > filter.afterTaskId)
        .filter((item) => matchesState(item, filter.state))
        .slice(0, limit)
    )
  };
  const history = new Map<string, { occurrenceId: string; dueAt: number }[]>();
  const requestNode = vi.fn(
    async (
      nodeId: string,
      operation: string,
      data: unknown,
      _authorization: unknown,
      _timeout?: number
    ): Promise<unknown> => {
      const input = data as {
        workspaceId: string;
        taskId?: string;
        mine?: boolean;
        afterTaskId?: string;
        limit?: number;
        sessionId?: string;
        state?: ScheduledTaskState;
        before?: { dueAt: number; sameTime: string };
      };
      if (!connections.has(nodeId)) throw new Error('NODE_OFFLINE');
      if (operation === 'workspace.list')
        return { workspaces: [{ id: `${nodeId}1` }, { id: 'unauthorized' }] };
      const scope = `${nodeId}:${input.workspaceId}`;
      if (!visible.has(scope)) throw new Error('NODE_ACCESS_DENIED');
      const tasks = localTasks.get(scope) ?? [];
      if (operation === 'schedule.task.list') {
        const filtered = tasks.filter(
          (item) =>
            (!input.mine || item.ownerUserId === 1) &&
            matchesState(item, input.state) &&
            (input.afterTaskId === undefined || item.id > input.afterTaskId) &&
            (input.sessionId === undefined || item.sessionId === input.sessionId)
        );
        return {
          tasks: filtered.slice(0, input.limit),
          nextCursor: filtered.length > input.limit! ? 'cursor' : null
        };
      }
      if (operation === 'schedule.upcoming.list')
        return {
          items: tasks
            .filter((item) => matchesState(item, 'scheduled'))
            .slice(0, 6)
            .map(({ id, name }) => ({ taskId: id, name, dueAt: future }))
        };
      if (operation === 'schedule.occurrence.list')
        return {
          items: (history.get(scope) ?? [])
            .filter((item) => {
              const before = input.before;
              return (
                before === undefined ||
                item.dueAt < before.dueAt ||
                (item.dueAt === before.dueAt &&
                  (before.sameTime === 'include' ||
                    (before.sameTime !== 'exclude' && item.occurrenceId < before.sameTime)))
              );
            })
            .slice(0, 11)
            .map((item) => ({
              taskId: 'task',
              name: null,
              state: 'SKIPPED',
              reason: null,
              startedAt: null,
              endedAt: null,
              run: null,
              snapshot: { objective: 'not a list field' },
              ...item
            }))
        };
      if (operation === 'schedule.task.get') {
        const task = tasks.find((item) => item.id === input.taskId);
        if (!task) throw new Error('SCHEDULE_NOT_FOUND');
        return { task, proposals: [], canResolveProposals: task.ownerUserId === 1 };
      }
      if (operation === 'schedule.occurrence.get') {
        const { occurrenceId } = input as { occurrenceId?: string };
        const found = history.get(scope)?.find((item) => item.occurrenceId === occurrenceId);
        if (!found) throw new Error('SCHEDULE_NOT_FOUND');
        return {
          ...found,
          taskId: 'task',
          name: 'Task',
          state: 'SUCCEEDED',
          reason: null,
          startedAt: 110,
          endedAt: 120,
          run: { sessionId: 'executed-session', runId: 'run-one' },
          snapshot: { objective: 'detail only' }
        };
      }
      if (operation === 'schedule.task.update') return { task: tasks[0] };
      return { times: [{ dueAt: future }], timezone: 'UTC' };
    }
  );
  const database = {
    findCurrentUserSession: (token: string) =>
      token !== 'session'
        ? undefined
        : {
            userId: 1,
            username: 'member',
            isAdmin: false,
            sessionHash: 'fingerprint',
            mustChangePassword: false,
            csrfTokenHash: hashOpaque('csrf')
          },
    userDisplayName: vi.fn(async (id: number) => (id === 1 ? 'Member nickname' : 'Owner nickname'))
  };
  const workspaces = vi.fn<ScheduledTaskDirectory['workspaces']>(async (_userId, nodeId, items) =>
    items
      .filter(({ id }) => visible.has(`${nodeId}:${id}`))
      .map(({ id }) => ({ id, name: `Workspace ${id}` }))
  );
  registerScheduledTaskRoutes({
    app,
    database,
    databaseError,
    publicOrigin: 'https://mar.test',
    nodeControl: { requestNode, ownsWorkbenchConnection: () => false },
    index: store,
    schedules: {
      nodes: async () =>
        ['a', 'b'].map((id) => ({
          id,
          name: `Node ${id}`,
          connected: connections.has(id),
          supported: capable.has(id),
          newSessionSupported: capable.has(id)
        })),
      workspaces,
      canUseWorkspace: async (_userId, nodeId, workspaceId) =>
        visible.has(`${nodeId}:${workspaceId}`)
    }
  });
  return {
    app,
    database,
    connections,
    capable,
    visible,
    requestNode,
    store,
    localTasks,
    history,
    workspaces
  };
}

it('reconciles the complete live Workspace list before filtering a schedule read', async () => {
  const { app, visible, requestNode, workspaces } = fixture();
  visible.add('a:unauthorized');
  const result = await app.inject({ url: '/api/scheduled-tasks?nodeId=a&workspaceId=a1', headers });
  expect(result.statusCode).toBe(200);
  expect(workspaces).toHaveBeenCalledExactlyOnceWith(
    1,
    'a',
    [{ id: 'a1' }, { id: 'unauthorized' }],
    'live'
  );
  expect(
    requestNode.mock.calls
      .filter(([, operation]) => operation === 'schedule.task.list')
      .map(([, , data]) => data)
  ).toEqual([expect.objectContaining({ workspaceId: 'a1' })]);
});

it('merges live and offline cards, retaining only the authorized offline index projection', async () => {
  const { app, connections, visible, store, database, requestNode } = fixture();
  const first = await app.inject({ url: '/api/scheduled-tasks?mine=false', headers });
  expect(first.statusCode).toBe(200);
  expect(first.json().items).toMatchObject([
    {
      id: 'a-task',
      mine: true,
      ownerName: 'Member nickname',
      objectivePreview: 'Online instructions'
    },
    { id: 'b-task', mine: false, ownerName: 'Owner nickname' }
  ]);
  expect(first.json().items[0]).not.toHaveProperty('objective');
  expect(first.json().items[0]).not.toHaveProperty('newSession');
  expect(store.list).not.toHaveBeenCalled();
  expect(
    requestNode.mock.calls.every(
      (call) => (call[2] as { workspaceId?: string }).workspaceId !== 'unauthorized'
    )
  ).toBe(true);

  connections.delete('b');
  const offline = (
    await app.inject({ url: '/api/scheduled-tasks?mine=false&includeUpcoming=true', headers })
  ).json();
  expect(offline.unavailableNodeIds).toEqual(['b']);
  expect(offline.upcoming).toMatchObject([{ nodeId: 'a', taskId: 'a-task' }]);
  expect(offline.items[1]).toMatchObject({
    id: 'b-task',
    offline: true,
    syncedAt: 123,
    ownerName: 'Owner nickname'
  });
  expect(offline.items[1]).not.toHaveProperty('objectivePreview');
  expect(offline.items[1]).not.toHaveProperty('groups');
  expect(
    (await app.inject({ url: '/api/scheduled-tasks?nodeId=b', headers })).json().items
  ).toEqual([]);
  visible.delete('b:b1');
  vi.mocked(store.list).mockClear();
  database.userDisplayName.mockClear();
  expect(
    (await app.inject({ url: '/api/scheduled-tasks?nodeId=b&mine=false', headers })).json().items
  ).toEqual([]);
  expect(store.list).not.toHaveBeenCalled();
  expect(database.userDisplayName).not.toHaveBeenCalled();
});

it('reports an online unsupported Node without issuing schedule reads or returning its offline snapshot', async () => {
  const { app, capable, requestNode, store } = fixture();
  const url = '/api/scheduled-tasks?nodeId=b&mine=false';
  expect((await app.inject({ url, headers })).json().items).toHaveLength(1);
  requestNode.mockClear();
  capable.delete('b');
  expect((await app.inject({ url, headers })).json()).toMatchObject({
    nodes: [{ id: 'b', connected: true, supported: false, newSessionSupported: false }],
    items: [],
    unavailableNodeIds: ['b']
  });
  expect(store.list).not.toHaveBeenCalled();
  expect(requestNode).not.toHaveBeenCalled();
});

it('applies the same task state filter to authorized online and offline cards before paging', async () => {
  const { app, connections, localTasks, requestNode, store } = fixture();
  connections.delete('b');
  localTasks.get('a:a1')!.push({ ...task('paused', 'a1', 1, null), enabled: false });
  const paused = await app.inject({
    url: '/api/scheduled-tasks?mine=false&state=paused&includeUpcoming=true',
    headers
  });
  expect(paused.statusCode).toBe(200);
  expect(paused.json().items).toMatchObject([{ id: 'paused' }]);
  expect(paused.json().upcoming).toEqual([]);
  expect(store.list).toHaveBeenCalledWith('b', 'b1', { state: 'paused' }, 21);
  expect(
    requestNode.mock.calls.some(([, operation]) => operation === 'schedule.upcoming.list')
  ).toBe(false);
  const scheduled = await app.inject({
    url: '/api/scheduled-tasks?mine=false&state=scheduled&includeUpcoming=true',
    headers
  });
  expect(scheduled.json().items).toMatchObject([{ id: 'a-task' }, { id: 'b-task', offline: true }]);
  expect(scheduled.json().upcoming).toMatchObject([{ taskId: 'a-task' }]);
  expect(
    (await app.inject({ url: '/api/scheduled-tasks?state=RUNNING', headers })).statusCode
  ).toBe(400);
});

it('uses one time reference and does not narrow upcoming to the current card page', async () => {
  const { app, localTasks, requestNode } = fixture();
  localTasks.set(
    'a:a1',
    Array.from({ length: 21 }, (_, i) => task(`a${String(i).padStart(2, '0')}`, 'a1'))
  );
  const url = '/api/scheduled-tasks?mine=false&includeUpcoming=true';
  const first = (await app.inject({ url, headers })).json();
  expect(first.items).toHaveLength(20);
  expect(first.upcoming.map((entry: { taskId: string }) => entry.taskId)).toEqual([
    'a00',
    'a01',
    'a02',
    'a03',
    'a04',
    'a05'
  ]);
  const requests = requestNode.mock.calls.filter((call) => call[1] === 'schedule.upcoming.list');
  expect(requests).toHaveLength(2);
  expect((requests[0]![2] as { asOf: number }).asOf).toBe(
    (requests[1]![2] as { asOf: number }).asOf
  );
  const next = (await app.inject({ url: `${url}&cursor=${first.nextCursor}`, headers })).json();
  expect(next.items.map((item: { id: string }) => item.id)).toEqual(['a20', 'b-task']);
  expect(next.nextCursor).toBeNull();
  expect(next.upcoming).toEqual(first.upcoming);
});

it('pages history across same-time Nodes using scope-specific boundaries, and validates task scope', async () => {
  const { app, history, requestNode, visible } = fixture();
  history.set(
    'a:a1',
    Array.from({ length: 12 }, (_, index) => ({
      occurrenceId: `a${String(12 - index).padStart(2, '0')}`,
      dueAt: 100
    }))
  );
  history.set('b:b1', [
    ...Array.from({ length: 12 }, (_, index) => ({
      occurrenceId: `b${String(12 - index).padStart(2, '0')}`,
      dueAt: 100
    })),
    { occurrenceId: 'b00', dueAt: 90 }
  ]);
  const url = '/api/scheduled-occurrences?mine=false';
  expect((await app.inject({ url })).statusCode).toBe(401);
  for (const bad of ['0', '1.5', 'abc', '', 'first&cursor=second'])
    expect((await app.inject({ url: `${url}&cursor=${bad}`, headers })).statusCode).toBe(400);
  expect(requestNode).not.toHaveBeenCalled();
  const first = (await app.inject({ url, headers })).json();
  expect(first.items).toHaveLength(10);
  expect(first.items.at(-1).occurrenceId).toBe('a03');
  expect(first.items[0]).not.toHaveProperty('snapshot');
  const next = (await app.inject({ url: `${url}&cursor=${first.nextCursor}`, headers })).json();
  expect(next.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    'a02',
    'a01',
    'b12',
    'b11',
    'b10',
    'b09',
    'b08',
    'b07',
    'b06',
    'b05'
  ]);
  const last = (await app.inject({ url: `${url}&cursor=${next.nextCursor}`, headers })).json();
  expect(last.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    'b04',
    'b03',
    'b02',
    'b01',
    'b00'
  ]);
  expect(last.nextCursor).toBeNull();
  expect(requestNode).toHaveBeenCalledWith(
    'a',
    'schedule.occurrence.list',
    { workspaceId: 'a1', mine: false, before: { dueAt: 100, sameTime: 'exclude' } },
    expect.objectContaining({ workspaceId: 'a1' }),
    undefined
  );
  const detail = await app.inject({
    url: '/api/scheduled-occurrences/a03?nodeId=a&workspaceId=a1',
    headers
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({
    run: { sessionId: 'executed-session', runId: 'run-one' },
    snapshot: { objective: 'detail only' }
  });
  expect(
    (await app.inject({ url: '/api/scheduled-occurrences/a03?nodeId=b&workspaceId=b1', headers }))
      .statusCode
  ).toBe(404);
  expect(requestNode).toHaveBeenCalledWith(
    'b',
    'schedule.occurrence.list',
    { workspaceId: 'b1', mine: false, before: { dueAt: 100, sameTime: 'include' } },
    expect.objectContaining({ workspaceId: 'b1', userId: 1 }),
    undefined
  );
  expect((await app.inject({ url: `${url}&taskId=a-task&nodeId=a`, headers })).statusCode).toBe(
    400
  );
  expect(
    (await app.inject({ url: `${url}&sessionId=s&nodeId=a&workspaceId=a1`, headers })).statusCode
  ).toBe(200);
  expect(requestNode).toHaveBeenCalledWith(
    'a',
    'schedule.occurrence.list',
    expect.objectContaining({ sessionId: 's', workspaceId: 'a1' }),
    expect.objectContaining({ workspaceId: 'a1' }),
    undefined
  );
  visible.delete('a:a1');
  requestNode.mockClear();
  expect(
    (await app.inject({ url: `${url}&taskId=a-task&nodeId=a&workspaceId=a1`, headers })).statusCode
  ).toBe(404);
  expect(requestNode).not.toHaveBeenCalled();
});

it('binds detail, writes and preview to the authenticated Workspace and rejects invalid writes before dispatch', async () => {
  const { app, requestNode, database } = fixture();
  const address = { nodeId: 'a', workspaceId: 'a1' };
  const path = '/api/scheduled-tasks/a-task';
  const read = `${path}?nodeId=a&workspaceId=a1`;
  expect((await app.inject({ url: read })).statusCode).toBe(401);
  expect(database.userDisplayName).not.toHaveBeenCalled();
  expect((await app.inject({ url: read, headers })).json()).toMatchObject({
    mine: true,
    ownerName: 'Member nickname',
    task: { id: 'a-task', objective: 'Sensitive full instructions' }
  });
  expect(
    (
      await app.inject({ url: '/api/scheduled-tasks/b-task?nodeId=b&workspaceId=b1', headers })
    ).json()
  ).toMatchObject({ mine: false, ownerName: 'Owner nickname' });
  expect(
    (await app.inject({ url: '/api/scheduled-tasks/b-task?nodeId=a&workspaceId=a1', headers }))
      .statusCode
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: '/api/agent-sessions/session-one/schedule?nodeId=a&workspaceId=a1',
        headers
      })
    ).statusCode
  ).toBe(404);
  expect(requestNode).toHaveBeenCalledWith(
    'a',
    'schedule.task.get',
    { taskId: 'a-task', workspaceId: 'a1' },
    { userId: 1, sessionHash: 'fingerprint', workspaceId: 'a1' },
    undefined
  );
  requestNode.mockClear();
  const payload = { ...address, expectedRevision: 2, patch: { notifyOnTerminal: true } };
  const update = (value: object, overrides = headers) =>
    app.inject({ method: 'PUT', url: path, headers: overrides, payload: value });
  expect((await update(payload, { ...headers, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
  expect((await update(payload, { ...headers, origin: 'https://other.test' })).statusCode).toBe(
    403
  );
  expect((await update({ ...payload, expectedRevision: 0 })).statusCode).toBe(400);
  expect((await update({ ...payload, timezone: 'UTC' })).statusCode).toBe(400);
  expect((await update({ ...payload, ownerUserId: 7 })).statusCode).toBe(400);
  expect(requestNode).not.toHaveBeenCalled();
  expect((await update(payload)).statusCode).toBe(200);
  expect(requestNode).toHaveBeenCalledWith(
    'a',
    'schedule.task.update',
    { expectedRevision: 2, patch: { notifyOnTerminal: true }, taskId: 'a-task', workspaceId: 'a1' },
    { userId: 1, sessionHash: 'fingerprint', workspaceId: 'a1' },
    undefined
  );
  requestNode.mockClear();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/scheduled-tasks/preview',
        headers,
        payload: { ...address, groups }
      })
    ).statusCode
  ).toBe(200);
  expect(requestNode).toHaveBeenCalledExactlyOnceWith(
    'a',
    'schedule.preview',
    { workspaceId: 'a1', groups },
    { userId: 1, sessionHash: 'fingerprint', workspaceId: 'a1' },
    undefined
  );
});
