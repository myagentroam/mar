import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuickStartServerApp,
  createServerApp,
  type ServerApplication
} from '../../src/app.js';
import { MysqlServerDatabase } from '../../src/mysql/server-database.js';
import { MysqlEnvironmentSecretService } from '../../src/mysql/environment-secret-service.js';
import { ResourceAccessService } from '../../src/rbac/resource-access-service.js';
import { NodeControl } from '../../src/node-control.js';
import * as controlFactory from '../../src/composition/node-control-factory.js';
import * as marctlRoutes from '@myagentroam/server-core/marctl-routes';
import { hashOpaque } from '../../src/database.js';
import { createLocalApplicationOptions } from '../../../../mar-server/src/quick-start/application.js';
import { createQuickStartConfig } from '../../../../mar-server/src/quick-start/config.js';
import { mysql } from './support/server-notification-pools.js';

// Retain production composition, URL resolution, route handlers and signed credentials.
// Only persistence, resource-policy facts and the outbound Node transport are controlled.
vi.mock('../../src/mysql/connection.js', async () => {
  const { mysql } = await import('./support/server-notification-pools.js');
  return mysql;
});

const PUBLIC = 'https://public.invalid';
const LOCAL = 'http://127.0.0.1:5190';
const WORKSPACE = 'workspace-1';
const NOW = 10_000;
const apps: ServerApplication[] = [];
const directories: string[] = [];
const entries = [
  'execution',
  'schedule',
  'start',
  'send',
  'network.start',
  'network.send',
  'terminal'
] as const;
type Entry = (typeof entries)[number] | 'web.start' | 'web.terminal';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mysql.pools.length = 0;
  mysql.events.length = 0;
  mysql.createMysqlPool.mockClear();
  vi.spyOn(MysqlServerDatabase.prototype, 'initialize').mockResolvedValue(undefined);
  vi.spyOn(MysqlServerDatabase.prototype, 'findCurrentUserSession').mockReturnValue({
    userId: 1,
    username: 'admin',
    isAdmin: true,
    sessionHash: hashOpaque('fixture-session'),
    mustChangePassword: false,
    csrfTokenHash: hashOpaque('fixture-csrf')
  });
  vi.spyOn(MysqlEnvironmentSecretService.prototype, 'resolve').mockResolvedValue({});
});

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  }
});

async function fixture(mode: 'managed' | 'remote' | 'ordinary', registered = true) {
  const root = await mkdtemp(join(tmpdir(), 'mar-quick-start-url-wiring-'));
  directories.push(root);
  const registerIdentity = async () => {
    await mkdir(join(root, 'node-data'), { recursive: true });
    await writeFile(
      join(root, 'node-data/node.json'),
      JSON.stringify({
        nodeId: 'local-node',
        credential: 'fixture-node-credential'
      })
    );
  };
  if (registered) await registerIdentity();
  const nodeId = mode === 'remote' ? 'remote-node' : 'local-node';
  const allow = vi.spyOn(ResourceAccessService.prototype, 'canUseNode').mockResolvedValue(true);
  const authorize = vi.spyOn(ResourceAccessService.prototype, 'canRelay').mockResolvedValue(true);
  vi.spyOn(NodeControl.prototype, 'listNodes').mockResolvedValue(
    ['local-node', 'remote-node'].map((id) => ({
      id,
      ownerUserId: 1,
      displayName: null,
      registeredAddress: 'fixture',
      metadata: '{}',
      disabled: false,
      lastHeartbeatAt: null,
      connected: true
    }))
  );
  const requestNode = vi
    .spyOn(NodeControl.prototype, 'requestNode')
    .mockImplementation(async (_nodeId, operation, data) => {
      if (operation === 'session.cli.context')
        return { workspace: { id: WORKSPACE, path: '/fixture' } };
      if (operation === 'session.get')
        return { session: { id: 'session-1', workspaceId: WORKSPACE, runner: 'codex' } };
      if (operation === 'runner.profiles.list') return { profiles: [], defaults: [] };
      if (operation === 'session.start')
        return {
          session: { id: 'created-session' },
          run: { id: 'run-1' },
          auditReceipt: { sessionId: 'created-session', inputMode: 'NEW_SESSION' }
        };
      if (operation === 'terminal.open') return { terminal: { id: 'terminal-1' } };
      if (operation === 'agent.network')
        return {
          accepted: true,
          auditReceipt: {
            sessionId: 'session-1',
            inputMode: (data as { action: string }).action === 'start' ? 'NEW_SESSION' : 'SEND'
          }
        };
      if (operation === 'session.message')
        return { accepted: true, auditReceipt: { sessionId: 'session-1', inputMode: 'SEND' } };
      throw new Error(`UNEXPECTED_FIXTURE_OPERATION: ${operation}`);
    });
  const control = vi.spyOn(controlFactory, 'createNodeControl');
  const routes = vi.spyOn(marctlRoutes, 'registerMarctlRoutes');
  const { webRoot: _webRoot, ...options } = createLocalApplicationOptions(
    root,
    createQuickStartConfig({ serverPort: 5190, mysqlPort: 5191, node: true, search: 'disabled' }),
    () => false,
    { MAR_PUBLIC_ORIGIN: PUBLIC, MAR_SERVER_HOST: '0.0.0.0' }
  );
  const { app } = await (mode === 'ordinary' ? createServerApp : createQuickStartServerApp)({
    ...options,
    now: () => NOW,
    productUuid: null,
    logger: false
  });
  apps.push(app);
  // Extend the existing SQL transport Fake only for real credential reauthentication.
  for (const pool of mysql.pools) {
    const execute = pool.execute.getMockImplementation()!;
    pool.execute.mockImplementation(async (sql, values) =>
      sql.includes('SELECT u.id') ? [[{ id: 1 }], []] : execute(sql, values)
    );
  }
  await app.ready();
  const consumers = control.mock.calls[0]?.[2];
  const credentials = routes.mock.calls[0]?.[0].userCredentials;
  if (!consumers?.executionPreparer || !credentials) throw new Error('PRODUCTION_WIRING_MISSING');
  const token = credentials.issue(
    { userId: 1 },
    { nodeId, workspaceId: WORKSPACE },
    { type: 'terminal' },
    NOW + 60_000
  );
  return {
    app,
    nodeId,
    requestNode,
    consumers,
    credentials,
    token,
    registerIdentity,
    allow,
    authorize
  };
}

async function invoke(context: Awaited<ReturnType<typeof fixture>>, entry: Entry) {
  const { app, nodeId, consumers, requestNode, token } = context;
  requestNode.mockClear();
  if (entry === 'execution' || entry === 'schedule') {
    const request = {
      workspaceId: WORKSPACE,
      sessionId: 'session-1',
      runner: 'codex' as const,
      modelId: null
    };
    const prepared =
      entry === 'execution'
        ? await consumers.executionPreparer!(nodeId, {
            ...request,
            userId: 1
          })
        : await consumers.scheduleAuthorizer(nodeId, {
            ...request,
            ownerUserId: 1,
            taskId: 'task-1',
            revision: 1,
            occurrenceId: 'occurrence-1'
          });
    return prepared.secretEnvironment;
  }
  const browser = entry.startsWith('web.');
  const terminal = entry === 'terminal' || entry === 'web.terminal';
  const network = entry.startsWith('network.');
  const action = entry === 'send' || entry === 'network.send' ? 'send' : 'start';
  const response = await app.inject({
    method: 'POST',
    url: browser
      ? terminal
        ? '/api/terminals'
        : '/api/agent-sessions/start'
      : terminal
        ? '/api/marctl/terminals'
        : '/api/marctl/sessions',
    headers: browser
      ? {
          origin: PUBLIC,
          cookie: 'mar_user_session=fixture-session',
          'x-csrf-token': 'fixture-csrf'
        }
      : { authorization: `Bearer ${token}` },
    payload: terminal
      ? { nodeId, rows: 24, cols: 80, ...(browser ? { workspaceId: WORKSPACE } : {}) }
      : browser
        ? {
            nodeId,
            workspaceId: WORKSPACE,
            runner: 'codex',
            cwd: '/fixture',
            content: 'fixture input',
            clientMessageId: 'message-1'
          }
        : network
          ? {
              action: 'network',
              command: {
                operation: action,
                input: {
                  content: 'fixture input',
                  clientMessageId: 'message-1',
                  ...(action === 'start' ? { runner: 'codex' } : { agentId: 'session-1' })
                }
              }
            }
          : {
              action,
              content: 'fixture input',
              clientMessageId: 'message-1',
              ...(action === 'start'
                ? { runner: 'codex' }
                : { sessionId: 'session-1', deliveryIntent: 'SEND' })
            }
  });
  expect(response.statusCode).toBe(browser || terminal ? 201 : 200);
  const operation = terminal
    ? 'terminal.open'
    : network
      ? 'agent.network'
      : action === 'start'
        ? 'session.start'
        : 'session.message';
  const call = requestNode.mock.calls.find(([, name]) => name === operation);
  if (!call) throw new Error('EXPECTED_NODE_OPERATION_MISSING');
  expect(call[0]).toBe(nodeId);
  const data = call[2] as { secretEnvironment?: Record<string, string> };
  return data.secretEnvironment;
}

async function assertEnvironment(
  context: Awaited<ReturnType<typeof fixture>>,
  entry: Entry,
  expected: string
) {
  const environment = await invoke(context, entry);
  // Never print fixture bearer tokens when the decisive URL assertion fails.
  expect(environment?.MAR_CTL_SERVER_URL).toBe(expected);
  expect(environment?.MAR_CTL_CONTEXT_REQUIRED).toBe('1');
  expect(environment?.MAR_USERNAME).toBe('admin');
  const token = environment?.MAR_CTL_USER_TOKEN;
  if (typeof token !== 'string') throw new Error('EXECUTION_CREDENTIAL_MISSING');
  const credential = await context.credentials.authenticateContext(`Bearer ${token}`);
  expect(credential?.user.userId).toBe(1);
  expect(credential?.source.type).toBe(entry.endsWith('terminal') ? 'terminal' : 'delegation');
  expect(credential?.scope).toEqual(
    entry === 'terminal' ? undefined : { nodeId: context.nodeId, workspaceId: WORKSPACE }
  );
  if (entry === 'start' || entry === 'send' || entry.startsWith('network.')) {
    expect(credential?.scheduled).toBe(true);
    expect(credential?.expiresAt).toBe(NOW + 60_000);
  }
}

describe.each(['managed', 'remote', 'ordinary'] as const)(
  'Production %s Node execution URL',
  (mode) => {
    it.each(entries)('resolves the authorized target for %s', async (entry) => {
      const context = await fixture(mode);
      await assertEnvironment(context, entry, mode === 'managed' ? LOCAL : PUBLIC);
    });
  }
);

it('reads a managed identity that appears after startup without regressing Web entrypoints', async () => {
  const context = await fixture('managed', false);
  for (const entry of ['web.start', 'web.terminal', 'execution', 'terminal'] as const) {
    await assertEnvironment(context, entry, PUBLIC);
  }
  await context.registerIdentity();
  for (const entry of ['web.start', 'web.terminal', 'execution', 'terminal'] as const) {
    await assertEnvironment(context, entry, LOCAL);
  }
});

it('keeps background authorization and marctl Node access ahead of credential issuance', async () => {
  const context = await fixture('managed');
  context.authorize.mockResolvedValue(false);
  context.allow.mockResolvedValue(false);
  const environment = vi.spyOn(context.credentials, 'environment');
  await expect(invoke(context, 'execution')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/marctl/terminals',
    headers: { authorization: `Bearer ${context.token}` },
    payload: { nodeId: context.nodeId, rows: 24, cols: 80 }
  });
  expect(response.statusCode).toBe(403);
  expect(environment).not.toHaveBeenCalled();
  expect(context.requestNode).not.toHaveBeenCalled();
});

it.each(['execution', 'schedule'] as const)(
  'keeps %s model admission ahead of credential issuance',
  async (entry) => {
    const context = await fixture('managed');
    const environment = vi.spyOn(context.credentials, 'environment');
    const request = {
      workspaceId: WORKSPACE,
      sessionId: 'session-1',
      runner: 'mar-agent' as const,
      modelId: null
    };
    const denied =
      entry === 'execution'
        ? context.consumers.executionPreparer!(context.nodeId, {
            ...request,
            userId: 1
          })
        : context.consumers.scheduleAuthorizer(context.nodeId, {
            ...request,
            ownerUserId: 1,
            taskId: 'task-1',
            revision: 1,
            occurrenceId: 'occurrence-1'
          });
    await expect(denied).rejects.toThrow(
      entry === 'execution' ? 'EXECUTION_MODEL_UNAVAILABLE' : 'SCHEDULE_MODEL_UNAVAILABLE'
    );
    expect(environment).not.toHaveBeenCalled();
    expect(context.requestNode).not.toHaveBeenCalled();
  }
);

it('does not treat the internal execution URL as an allowed browser Origin or relax CSRF', async () => {
  const context = await fixture('managed');
  for (const [origin, csrf, code] of [
    [LOCAL, 'fixture-csrf', 'ORIGIN_NOT_ALLOWED'],
    [PUBLIC, 'wrong', 'CSRF_INVALID']
  ] as const) {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: { origin, cookie: 'mar_user_session=fixture-session', 'x-csrf-token': csrf },
      payload: { nodeId: context.nodeId }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(code);
  }
  expect(context.requestNode).not.toHaveBeenCalled();
});
