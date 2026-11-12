import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import { createQuickStartServerApp, createServerApp } from '../../ee/server/src/app.js';
import { createLocalApplicationOptions } from '../../mar-server/src/quick-start/application.js';
import { createQuickStartConfig } from '../../mar-server/src/quick-start/config.js';
import {
  createLicenseDocument,
  inspectLicenseRequestCode
} from '../../ee/server/src/license/license-domain.js';
import { readQuickStartHostFingerprint } from '../../ee/server/src/license/license-service.js';
import { createTestServerApp } from '../support/create-test-server-app.js';
import { openServerDatabase } from '../../ee/server/src/database.js';
import { createMysqlPool } from '../../ee/server/src/mysql/connection.js';
import {
  ENTERPRISE_MYSQL_MIGRATIONS,
  ENTERPRISE_MYSQL_SCHEMA_V6
} from '../../ee/server/src/mysql/enterprise-migrations.js';
import { runServerMysqlMigrations } from '../../packages/server-core/src/mysql-migrations.js';
import {
  CORE_MYSQL_MIGRATIONS,
  CORE_MYSQL_SCHEMA_V9
} from '../../packages/server-core/src/mysql-schema.js';
import { validateMysqlSchema } from '../../packages/server-core/src/mysql-schema-support.js';
import { hashPassword, INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';
import {
  createEnvelope,
  nodeEnvelopeSchema,
  type NodeEnvelope
} from '../../packages/protocol/src/index.js';
import {
  createPlaywrightTestDatabase,
  dropPlaywrightTestDatabase,
  resolvePlaywrightTestDatabase
} from './support/playwright-test-database.js';
import {
  createPlaywrightTestLicenseDocument,
  getPlaywrightTestLicensePublicKey,
  PLAYWRIGHT_LICENSE_PRODUCT_UUID
} from './support/playwright-test-license.js';

const HISTORICAL_INITIAL_PASSWORD = 'mar102030';

const HISTORICAL_CORE_SCHEMA_V14 = {
  ...CORE_MYSQL_SCHEMA_V9,
  mar_agent_models: CORE_MYSQL_SCHEMA_V9['mar_agent_models']!.replace(
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',",
    "  `fast_mode` tinyint(1) NOT NULL DEFAULT '0',\n  `service_tier` enum('auto','default','flex','priority','fast','ultrafast') DEFAULT NULL,"
  ),
  workbench_notifications: CORE_MYSQL_SCHEMA_V9['workbench_notifications']!.replace(
    "enum('run','approval','plan','user-input')",
    "enum('run','approval','plan','user-input','schedule')"
  )
};

async function validateHistoricalMysqlDatabase(
  connection: Parameters<typeof validateMysqlSchema>[0]
): Promise<void> {
  await validateMysqlSchema(connection, HISTORICAL_CORE_SCHEMA_V14);
  await validateMysqlSchema(connection, ENTERPRISE_MYSQL_SCHEMA_V6);
}

test('Internal marctl removes deployment keys during MySQL upgrade and rejects external credentials', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-marctl-migration`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  const pool = createMysqlPool({ url: target.databaseUrl });
  try {
    directory = await mkdtemp(join(tmpdir(), 'marctl-migration-e2e-'));
    const options = {
      databaseUrl: target.databaseUrl,
      dataDirectory: directory,
      productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
      secureCookies: false,
      logger: false as const
    };
    const migrationPool = createMysqlPool({ url: target.databaseUrl });
    try {
      await runServerMysqlMigrations(migrationPool, {
        edition: 'enterprise',
        core: CORE_MYSQL_MIGRATIONS.filter(({ version }) => version <= 14),
        enterprise: ENTERPRISE_MYSQL_MIGRATIONS.filter(({ version }) => version <= 6),
        validate: validateHistoricalMysqlDatabase
      });
    } finally {
      await migrationPool.end();
    }
    const legacyKey = `marmgr_${'x'.repeat(43)}`;
    const hash = createHash('sha256').update(legacyKey).digest('hex');
    await pool.execute(
      `INSERT INTO users
       (id,username,password_hash,must_change_password,enabled,is_fixed_admin,created_at,updated_at)
       VALUES (1,'admin',?,TRUE,TRUE,TRUE,1,1)`,
      [hashPassword(HISTORICAL_INITIAL_PASSWORD)]
    );
    await pool.execute(
      "INSERT INTO system_settings (setting_key,setting_value,updated_at) VALUES ('marmgr_management_key',JSON_OBJECT('hash',?),123)",
      [hash]
    );
    // Resume the real v14/v6 history only after the retired key and fixed admin exist.
    app = (await createServerApp(options)).app;
    await app.ready();
    await pool.execute('UPDATE users SET must_change_password=FALSE WHERE id=1');
    const headers = { authorization: `Bearer ${legacyKey}` };
    expect((await app.inject({ url: '/api/marctl/nodes', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/marmgr/nodes', headers })).statusCode).toBe(404);
    const [rows] = await pool.execute(
      "SELECT setting_key,JSON_UNQUOTE(JSON_EXTRACT(setting_value,'$.hash')) AS key_hash,updated_at FROM system_settings WHERE setting_key IN ('marmgr_management_key','marctl_management_key')"
    );
    expect(rows).toEqual([]);
    await app.close();
    app = (await createServerApp(options)).app;
    await app.ready();
    expect((await app.inject({ url: '/api/marctl/nodes', headers })).statusCode).toBe(401);
    const historicalLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(historicalLogin.statusCode).toBe(200);
    const newDefaultLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(newDefaultLogin.statusCode).toBe(401);
  } finally {
    await app?.close();
    await pool.end();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    await dropPlaywrightTestDatabase(target);
  }
});

test('Linux Quick Start activates through administrator URLs and retains authorization across restart', async () => {
  test.skip(process.platform !== 'linux', 'Only Linux Quick Start supports machine-id activation');
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-quick-start-license`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  const previousKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  const keys = generateKeyPairSync('ed25519');
  let now = Date.now();
  try {
    directory = await mkdtemp(join(tmpdir(), 'quick-start-license-e2e-'));
    process.env['MAR_LICENSE_PUBLIC_KEY'] = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const start = async () => {
      const composition = await createQuickStartServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory!,
        now: () => now,
        publicOrigin: 'http://localhost',
        secureCookies: false,
        logger: false
      });
      app = composition.app;
      await app.ready();
      return composition;
    };
    const first = await start();
    const nodeRegistration = await first.quickStartNode.issue();
    const login = await app!.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost' },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const changed = await app!.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        origin: 'http://localhost',
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const headers = {
      origin: 'http://localhost',
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const readStatus = async () => (await app!.inject({ url: '/api/license', headers })).json();
    expect(await readStatus()).toMatchObject({
      state: 'COMMUNITY',
      activationAvailable: true,
      activationVisible: false
    });
    const request = await app!.inject({ url: '/api/license/request-code', headers });
    expect(request.statusCode).toBe(200);
    const binding = inspectLicenseRequestCode(request.json().requestCode).hostFingerprint;
    expect(binding).toBe(readQuickStartHostFingerprint());
    const document = (hostFingerprint = binding) =>
      createLicenseDocument(
        {
          formatVersion: 1,
          licenseId: 'quick-start-enterprise',
          enterpriseName: 'Quick Start Enterprise',
          issuedAt: now - 1_000,
          expiresAt: now + 60_000,
          hostFingerprint,
          features: ['ENTERPRISE']
        },
        keys.privateKey
      );
    const mismatched = await app!.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: document('f'.repeat(64)) }
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: 'LICENSE_HOST_MISMATCH' } });
    expect(await readStatus()).toMatchObject({ state: 'COMMUNITY' });
    const imported = await app!.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: document() }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ state: 'ENTERPRISE_VALID' });
    await app!.close();
    app = undefined;
    const restarted = await start();
    expect(await readStatus()).toMatchObject({
      state: 'ENTERPRISE_VALID',
      activationAvailable: true,
      activationVisible: false
    });
    const identity = await app!.inject({ url: '/api/auth/me', headers });
    expect(identity.json()).toMatchObject({
      edition: 'ENTERPRISE',
      role: 'ADMIN',
      organizationId: 1
    });
    const recovered = await restarted.quickStartNode.issue(nodeRegistration.token);
    expect(recovered.token).toBe(nodeRegistration.token);
    now += 60_000;
    await app!.close();
    app = undefined;
    const frozen = await start();
    await expect(frozen.quickStartNode.issue(nodeRegistration.token)).rejects.toThrow(
      'LICENSE_MANAGEMENT_FROZEN'
    );
    expect(await readStatus()).toMatchObject({
      state: 'ENTERPRISE_FROZEN',
      reason: 'LICENSE_EXPIRED'
    });
    const blocked = await app!.inject({
      method: 'POST',
      url: '/api/organizations',
      headers,
      payload: { name: 'Blocked' }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: 'LICENSE_MANAGEMENT_FROZEN' } });
    expect((await app!.inject({ url: '/api/license/request-code', headers })).statusCode).toBe(200);
    const renewed = await app!.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: document() }
    });
    expect(renewed.statusCode).toBe(200);
    expect(await readStatus()).toMatchObject({ state: 'ENTERPRISE_VALID' });
  } finally {
    if (previousKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousKey;
    await app?.close();
    await dropPlaywrightTestDatabase(target);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test('Quick Start injects its HTTP marctl URL only for the registered local Node', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-quick-start-marctl-url`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createQuickStartServerApp>>['app'] | undefined;
  const sockets: WebSocket[] = [];

  try {
    directory = await mkdtemp(join(tmpdir(), 'quick-start-marctl-url-e2e-'));
    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject);
      portProbe.listen(0, '127.0.0.1', resolve);
    });
    const address = portProbe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      portProbe.close((error) => (error ? reject(error) : resolve()))
    );
    const localServerUrl = `http://127.0.0.1:${address.port}`;
    const publicOrigin = 'https://public.invalid';
    const quickStartOptions = createLocalApplicationOptions(
      directory,
      createQuickStartConfig({
        serverPort: address.port,
        mysqlPort: 3306,
        node: true,
        search: 'disabled'
      }),
      () => false,
      { MAR_SERVER_HOST: '127.0.0.1', MAR_PUBLIC_ORIGIN: publicOrigin }
    );
    expect(await quickStartOptions.readQuickStartLocalNodeId?.()).toBeUndefined();
    const composition = await createQuickStartServerApp({
      ...quickStartOptions,
      databaseUrl: target.databaseUrl,
      secureCookies: true,
      logger: false
    });
    app = composition.app;
    let baseUrl = await app.listen({ host: '127.0.0.1', port: address.port });
    expect(baseUrl).toBe(localServerUrl);
    expect(new URL(baseUrl).protocol).toBe('http:');

    type NodeRequestFrame = Omit<NodeEnvelope, 'type' | 'payload'> & {
      readonly type: 'node.request';
      readonly payload: {
        readonly operation: string;
        readonly userAuthorization: {
          readonly userId: number;
          readonly nodeId: string;
          readonly operation: string;
          readonly workspaceId?: string;
          readonly requestId: string;
          readonly sessionHash: string;
          readonly issuedAt: number;
          readonly expiresAt: number;
        };
        readonly data: unknown;
      };
    };
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const isNodeRequest = (frame: NodeEnvelope): frame is NodeRequestFrame => {
      if (frame.type !== 'node.request' || !isRecord(frame.payload)) return false;
      const authorization = frame.payload['userAuthorization'];
      return (
        typeof frame.payload['operation'] === 'string' &&
        Object.hasOwn(frame.payload, 'data') &&
        isRecord(authorization) &&
        typeof authorization['userId'] === 'number' &&
        typeof authorization['nodeId'] === 'string' &&
        typeof authorization['operation'] === 'string' &&
        (authorization['workspaceId'] === undefined ||
          typeof authorization['workspaceId'] === 'string') &&
        typeof authorization['requestId'] === 'string' &&
        typeof authorization['sessionHash'] === 'string' &&
        typeof authorization['issuedAt'] === 'number' &&
        typeof authorization['expiresAt'] === 'number'
      );
    };

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: publicOrigin },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/;\s*Secure(?:;|$)/u);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        origin: publicOrigin,
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    let adminHeaders = {
      origin: publicOrigin,
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
    };

    const receiveFrame = (socket: WebSocket): Promise<NodeEnvelope> =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
        };
        const onMessage = (event: MessageEvent) => {
          cleanup();
          try {
            resolve(nodeEnvelopeSchema.parse(JSON.parse(String(event.data))));
          } catch {
            reject(new Error('FAKE_NODE_MESSAGE_INVALID'));
          }
        };
        const onError = () => {
          cleanup();
          reject(new Error('FAKE_NODE_SOCKET_ERROR'));
        };
        socket.addEventListener('message', onMessage, { once: true });
        socket.addEventListener('error', onError, { once: true });
      });
    const registerNode = async (registrationToken: string) => {
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/node/connect`);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('FAKE_NODE_SOCKET_ERROR')), {
          once: true
        });
      });
      const registeredPromise = receiveFrame(socket);
      socket.send(
        JSON.stringify(
          createEnvelope('register', {
            registrationToken,
            capabilities: {
              platform: 'linux',
              architecture: 'x64',
              nodeVersion: process.version,
              nodeAppVersion: nodePackage.version,
              codex: { available: true, version: 'test' },
              claudeCode: { available: false }
            }
          })
        )
      );
      const registered = await registeredPromise;
      if (registered.type !== 'registered' || !isRecord(registered.payload))
        throw new Error('FAKE_NODE_REGISTRATION_FAILED');
      const nodeId = registered.payload['nodeId'];
      if (typeof nodeId !== 'string') throw new Error('FAKE_NODE_REGISTRATION_FAILED');
      return { socket, nodeId };
    };
    const nextRequest = async (socket: WebSocket, operation: string): Promise<NodeRequestFrame> => {
      while (true) {
        const frame = await receiveFrame(socket);
        if (isNodeRequest(frame) && frame.payload.operation === operation) return frame;
        if (frame.type === 'error') throw new Error('FAKE_NODE_REQUEST_REJECTED');
      }
    };
    const assertAuthorization = (
      frame: NodeRequestFrame,
      nodeId: string,
      operation: string,
      workspaceId: string
    ) => {
      const authorization = frame.payload.userAuthorization;
      expect({
        userId: authorization.userId === 1,
        nodeId: authorization.nodeId === nodeId,
        operation: authorization.operation === operation,
        workspaceId:
          authorization.workspaceId === undefined || authorization.workspaceId === workspaceId,
        requestId: authorization.requestId === frame.id,
        sessionHash: typeof authorization.sessionHash === 'string',
        lifetime: authorization.expiresAt > authorization.issuedAt
      }).toEqual({
        userId: true,
        nodeId: true,
        operation: true,
        workspaceId: true,
        requestId: true,
        sessionHash: true,
        lifetime: true
      });
    };
    const createWorkspace = async (node: { socket: WebSocket; nodeId: string }, name: string) => {
      const workspaceId = `workspace-${name}`;
      const pending = app!.inject({
        method: 'POST',
        url: '/api/workspaces',
        headers: adminHeaders,
        payload: { nodeId: node.nodeId, path: `/project/${name}` }
      });
      const frame = await nextRequest(node.socket, 'workspace.register');
      node.socket.send(
        JSON.stringify(
          createEnvelope(
            'node.response',
            {
              result: {
                workspace: { id: workspaceId, path: `/project/${name}`, kind: 'DIRECTORY' }
              }
            },
            { replyTo: frame.id }
          )
        )
      );
      const response = await pending;
      expect(response.statusCode).toBeLessThan(300);
      return workspaceId;
    };

    const localRegistration = await composition.quickStartNode.issue();
    const localNode = await registerNode(localRegistration.token);
    expect(await quickStartOptions.readQuickStartLocalNodeId?.()).toBeUndefined();
    const nodeDataDirectory = join(directory, 'node-data');
    const workspaceDirectory = join(directory, 'workspace');
    await mkdir(nodeDataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(nodeDataDirectory, 'node.json'),
      `${JSON.stringify(
        {
          serverUrl: localServerUrl,
          allowedRoots: [workspaceDirectory],
          dataDirectory: nodeDataDirectory,
          conversationHosting: { enabled: false },
          nodeId: localNode.nodeId,
          credential: 'fixture-local-node-credential'
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    expect(await quickStartOptions.readQuickStartLocalNodeId?.()).toBe(localNode.nodeId);
    const remoteTokenResponse = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: adminHeaders,
      payload: { displayName: 'Quick Start remote fixture' }
    });
    expect(remoteTokenResponse.statusCode).toBe(200);
    const remoteNode = await registerNode(remoteTokenResponse.json<{ token: string }>().token);

    for (const [name, node, expectedServerUrl] of [
      ['local', localNode, localServerUrl],
      ['remote', remoteNode, publicOrigin]
    ] as const) {
      const workspaceId = await createWorkspace(node, name);
      const sessionRequest = app!.inject({
        method: 'POST',
        url: '/api/agent-sessions/start',
        headers: adminHeaders,
        payload: {
          nodeId: node.nodeId,
          workspaceId,
          runner: 'codex',
          cwd: `/project/${name}`,
          clientMessageId: `first-${name}`,
          content: 'hello'
        }
      });
      const sessionCommand = await nextRequest(node.socket, 'session.start');
      assertAuthorization(sessionCommand, node.nodeId, 'session.start', workspaceId);
      const sessionData = sessionCommand.payload.data as {
        readonly secretEnvironment: Readonly<Record<string, string>>;
      };
      expect(sessionData.secretEnvironment.MAR_CTL_SERVER_URL).toBe(expectedServerUrl);
      expect(typeof sessionData.secretEnvironment.MAR_CTL_USER_TOKEN).toBe('string');
      node.socket.send(
        JSON.stringify(
          createEnvelope(
            'node.response',
            {
              result: {
                session: {
                  id: `session-${name}`,
                  nodeId: node.nodeId,
                  workspaceId,
                  runner: 'codex',
                  cwd: `/project/${name}`
                },
                run: { id: `run-${name}`, sessionId: `session-${name}`, status: 'RUNNING' },
                delivery: 'STARTED',
                auditReceipt: { sessionId: `session-${name}`, inputMode: 'NEW_SESSION' }
              }
            },
            { replyTo: sessionCommand.id }
          )
        )
      );
      expect((await sessionRequest).statusCode).toBe(201);

      const terminalRequest = app!.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: adminHeaders,
        payload: { nodeId: node.nodeId, workspaceId }
      });
      const terminalCommand = await nextRequest(node.socket, 'terminal.open');
      assertAuthorization(terminalCommand, node.nodeId, 'terminal.open', workspaceId);
      const terminalData = terminalCommand.payload.data as {
        readonly secretEnvironment: Readonly<Record<string, string>>;
      };
      expect(terminalData.secretEnvironment.MAR_CTL_SERVER_URL).toBe(expectedServerUrl);
      expect(typeof terminalData.secretEnvironment.MAR_CTL_USER_TOKEN).toBe('string');
      node.socket.send(
        JSON.stringify(
          createEnvelope(
            'node.response',
            { result: { terminal: { id: `terminal-${name}` } } },
            { replyTo: terminalCommand.id }
          )
        )
      );
      expect((await terminalRequest).statusCode).toBe(201);
    }

    await Promise.all(
      sockets.splice(0).map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve();
            socket.addEventListener('close', () => resolve(), { once: true });
            socket.close();
          })
      )
    );
    await app.close();
    app = undefined;
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory,
        publicOrigin,
        secureCookies: true,
        logger: false
      })
    ).app;
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const ordinaryLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: publicOrigin },
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(ordinaryLogin.statusCode).toBe(200);
    adminHeaders = {
      origin: publicOrigin,
      cookie: String(ordinaryLogin.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': ordinaryLogin.json<{ csrfToken: string }>().csrfToken
    };
    const ordinaryTokenResponse = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: adminHeaders,
      payload: { displayName: 'Ordinary server fixture' }
    });
    expect(ordinaryTokenResponse.statusCode).toBe(200);
    const ordinaryNode = await registerNode(ordinaryTokenResponse.json<{ token: string }>().token);
    const ordinaryWorkspaceId = await createWorkspace(ordinaryNode, 'ordinary');
    const ordinarySessionRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers: adminHeaders,
      payload: {
        nodeId: ordinaryNode.nodeId,
        workspaceId: ordinaryWorkspaceId,
        runner: 'codex',
        cwd: '/project/ordinary',
        clientMessageId: 'first-ordinary',
        content: 'hello'
      }
    });
    const ordinarySessionCommand = await nextRequest(ordinaryNode.socket, 'session.start');
    assertAuthorization(
      ordinarySessionCommand,
      ordinaryNode.nodeId,
      'session.start',
      ordinaryWorkspaceId
    );
    const ordinarySessionData = ordinarySessionCommand.payload.data as {
      readonly secretEnvironment: Readonly<Record<string, string>>;
    };
    expect(ordinarySessionData.secretEnvironment.MAR_CTL_SERVER_URL).toBe(publicOrigin);
    ordinaryNode.socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              session: {
                id: 'session-ordinary',
                nodeId: ordinaryNode.nodeId,
                workspaceId: ordinaryWorkspaceId,
                runner: 'codex',
                cwd: '/project/ordinary'
              },
              run: { id: 'run-ordinary', sessionId: 'session-ordinary', status: 'RUNNING' },
              delivery: 'STARTED',
              auditReceipt: { sessionId: 'session-ordinary', inputMode: 'NEW_SESSION' }
            }
          },
          { replyTo: ordinarySessionCommand.id }
        )
      )
    );
    expect((await ordinarySessionRequest).statusCode).toBe(201);

    const ordinaryTerminalRequest = app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: adminHeaders,
      payload: { nodeId: ordinaryNode.nodeId, workspaceId: ordinaryWorkspaceId }
    });
    const ordinaryTerminalCommand = await nextRequest(ordinaryNode.socket, 'terminal.open');
    assertAuthorization(
      ordinaryTerminalCommand,
      ordinaryNode.nodeId,
      'terminal.open',
      ordinaryWorkspaceId
    );
    const ordinaryTerminalData = ordinaryTerminalCommand.payload.data as {
      readonly secretEnvironment: Readonly<Record<string, string>>;
    };
    expect(ordinaryTerminalData.secretEnvironment.MAR_CTL_SERVER_URL).toBe(publicOrigin);
    ordinaryNode.socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          { result: { terminal: { id: 'terminal-ordinary' } } },
          { replyTo: ordinaryTerminalCommand.id }
        )
      )
    );
    expect((await ordinaryTerminalRequest).statusCode).toBe(201);
  } finally {
    for (const socket of sockets) socket.close();
    await app?.close();
    await dropPlaywrightTestDatabase(target);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test('The product stack covers authentication, License activation, and enterprise authorization in isolated MySQL', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-product-composition`);
  await createPlaywrightTestDatabase(target);
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  const previousKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  try {
    directory = await mkdtemp(join(tmpdir(), 'product-composition-e2e-'));
    process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory,
        productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
        secureCookies: false,
        logger: false
      })
    ).app;
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/license' })).statusCode).toBe(401);
    const retiredLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(retiredLogin.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      authenticated: true,
      edition: 'COMMUNITY',
      licenseState: 'COMMUNITY'
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const auditPool = createMysqlPool({ url: target.databaseUrl });
    try {
      const [rows] = await auditPool.execute(
        `SELECT event_type,actor_username,actor_ip,result,metadata
         FROM audit_events WHERE event_type='password_changed'`
      );
      expect(rows).toMatchObject([
        { event_type: 'password_changed', actor_username: 'admin', result: 'SUCCESS' }
      ]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(INITIAL_ADMIN_PASSWORD);
      expect(JSON.stringify(rows)).not.toContain(login.json().csrfToken);
    } finally {
      await auditPool.end();
    }
    const headers = {
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const imported = await app.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: createPlaywrightTestLicenseDocument() }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ edition: 'ENTERPRISE', state: 'ENTERPRISE_VALID' });
    const current = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      authenticated: true,
      mustChangePassword: false,
      edition: 'ENTERPRISE',
      licenseState: 'ENTERPRISE_VALID',
      role: 'ADMIN',
      organizationId: expect.any(Number),
      managementWritable: true
    });
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect(
        (await app.inject({ method, url: '/api/system-settings/management-key', headers }))
          .statusCode
      ).toBe(404);
    }
    for (const key of [
      `marctl_${'x'.repeat(43)}`,
      `marmgr_${'x'.repeat(43)}`,
      `marctl_user_${'x'.repeat(43)}`
    ]) {
      expect(
        (
          await app.inject({
            url: '/api/marctl/nodes',
            headers: { authorization: `Bearer ${key}` }
          })
        ).statusCode
      ).toBe(401);
    }
    const organizations = await app.inject({ method: 'GET', url: '/api/organizations', headers });
    expect(organizations.statusCode).toBe(200);
    expect(organizations.json().organizations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: current.json().organizationId })])
    );
  } finally {
    if (previousKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousKey;
    try {
      await app?.close();
    } finally {
      try {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      } finally {
        await dropPlaywrightTestDatabase(target);
      }
    }
  }
});

test('Fixed admin profile editing preserves recovery protection and rejects organization admins', async () => {
  const runId = process.env['MAR_TEST_RUN_ID'];
  if (!runId) throw new Error('MAR_TEST_RUN_ID_REQUIRED');
  const target = resolvePlaywrightTestDatabase(`${runId}-fixed-admin-profile`);
  await createPlaywrightTestDatabase(target);
  const pool = createMysqlPool({ url: target.databaseUrl });
  const previousKey = process.env['MAR_LICENSE_PUBLIC_KEY'];
  let directory: string | undefined;
  let app: Awaited<ReturnType<typeof createServerApp>>['app'] | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'fixed-admin-profile-e2e-'));
    process.env['MAR_LICENSE_PUBLIC_KEY'] = getPlaywrightTestLicensePublicKey();
    app = (
      await createServerApp({
        databaseUrl: target.databaseUrl,
        dataDirectory: directory,
        productUuid: PLAYWRIGHT_LICENSE_PRODUCT_UUID,
        secureCookies: false,
        logger: false
      })
    ).app;
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.statusCode).toBe(200);
    const headers = {
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': changed.json().csrfToken as string
    };
    const imported = await app.inject({
      method: 'POST',
      url: '/api/license/import',
      headers,
      payload: { document: createPlaywrightTestLicenseDocument() }
    });
    expect(imported.statusCode).toBe(200);
    const [identityBefore] = await pool.execute(
      'SELECT username,role,organization_id,is_fixed_admin,enabled,password_hash FROM users WHERE id=1'
    );
    const profile = {
      email: 'admin@example.com',
      nickname: '恢复管理员',
      role: 'ADMIN',
      organizationId: 1
    };
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers,
      payload: profile
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().user).toMatchObject({ ...profile, username: 'admin', fixedAdmin: true });
    const listed = await app.inject({ method: 'GET', url: '/api/enterprise/users', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().users).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 1, ...profile })])
    );
    for (const membership of [
      { role: 'MEMBER', organizationId: 1 },
      { role: 'ORG_ADMIN', organizationId: 1 },
      { role: 'ADMIN', organizationId: 999 }
    ]) {
      const denied = await app.inject({
        method: 'PATCH',
        url: '/api/enterprise/users/1',
        headers,
        payload: { ...profile, email: 'forbidden@example.com', ...membership }
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('ADMIN_USER_PROTECTED');
    }
    const deleted = await app.inject({ method: 'DELETE', url: '/api/management/users/1', headers });
    expect(deleted.statusCode).toBe(400);
    expect(deleted.json().error.code).toBe('ADMIN_USER_PROTECTED');
    const reset = await app.inject({
      method: 'POST',
      url: '/api/management/users/1/reset-password',
      headers
    });
    expect(reset.statusCode).toBe(400);
    await pool.execute(
      `INSERT INTO users (username,password_hash,must_change_password,enabled,role,organization_id,is_fixed_admin,created_at,updated_at)
       VALUES ('org-admin',?,FALSE,TRUE,'ORG_ADMIN',1,FALSE,1,1)`,
      [hashPassword('org-admin-password')]
    );
    const orgLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'org-admin', password: 'org-admin-password' }
    });
    expect(orgLogin.statusCode).toBe(200);
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers: {
        cookie: String(orgLogin.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': orgLogin.json().csrfToken
      },
      payload: { ...profile, nickname: 'Forbidden' }
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('RBAC_TARGET_ROLE_DENIED');
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/enterprise/users/1',
      headers,
      payload: { ...profile, email: null, nickname: null }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().user).toMatchObject({ email: null, nickname: null });
    const [identityAfter] = await pool.execute(
      'SELECT username,role,organization_id,is_fixed_admin,enabled,password_hash FROM users WHERE id=1'
    );
    expect(identityAfter).toEqual(identityBefore);
  } finally {
    if (previousKey === undefined) delete process.env['MAR_LICENSE_PUBLIC_KEY'];
    else process.env['MAR_LICENSE_PUBLIC_KEY'] = previousKey;
    try {
      await app?.close();
    } finally {
      await pool.end();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      await dropPlaywrightTestDatabase(target);
    }
  }
});

test('A new database supports the default login and first password change while invalidating old sessions', async ({
  request
}) => {
  await withServer(async (baseUrl, databasePath) => {
    const admin = await playwrightRequest.newContext({ baseURL: baseUrl });
    const retiredLogin = await admin.post('/api/auth/login', {
      data: { username: 'admin', password: HISTORICAL_INITIAL_PASSWORD }
    });
    expect(retiredLogin.status()).toBe(401);
    const login = await admin.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const loginBody = await login.json();
    expect(login.ok()).toBeTruthy();
    expect(loginBody).toMatchObject({ authenticated: true, mustChangePassword: true });

    const changed = await admin.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': loginBody.csrfToken },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password: INITIAL_ADMIN_PASSWORD }
    });
    expect(changed.ok()).toBeTruthy();
    expect((await admin.get('/api/auth/me')).status()).toBe(200);

    const oldSession = await playwrightRequest.newContext({ baseURL: baseUrl });
    await oldSession.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const database = openServerDatabase(databasePath);
    database.resetPassword(INITIAL_ADMIN_PASSWORD, 'e2e-local-command');
    database.close();
    expect((await oldSession.get('/api/auth/me')).status()).toBe(401);

    const temporaryLogin = await request.post(`${baseUrl}/api/auth/login`, {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    expect(await temporaryLogin.json()).toMatchObject({ mustChangePassword: true });
    await admin.dispose();
    await oldSession.dispose();
  });
});

test('At most five active logins are retained, new logins evict the least-recently-used session, and accounts can list sessions', async () => {
  await withServer(async (baseUrl) => {
    const devices = await Promise.all(
      Array.from({ length: 6 }, () => playwrightRequest.newContext({ baseURL: baseUrl }))
    );
    const [firstDevice, secondDevice, ...otherDevices] = devices;
    if (firstDevice === undefined || secondDevice === undefined)
      throw new Error('DEVICE_FIXTURE_INVALID');
    try {
      const logins = [];
      for (const device of devices.slice(0, 5)) {
        logins.push(
          await device.post('/api/auth/login', {
            data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
          })
        );
      }
      const firstLogin = logins[0];
      if (firstLogin === undefined) throw new Error('LOGIN_FIXTURE_INVALID');
      expect((await firstDevice.get('/api/auth/me')).status()).toBe(200);
      const sixthDevice = devices[5];
      if (sixthDevice === undefined) throw new Error('DEVICE_FIXTURE_INVALID');
      const sixthLogin = await sixthDevice.post('/api/auth/login', {
        data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
      });
      expect([...logins, sixthLogin].map((login) => login.status())).toEqual([
        200, 200, 200, 200, 200, 200
      ]);
      expect((await secondDevice.get('/api/auth/me')).status()).toBe(401);
      const sessionList = (await (await firstDevice.get('/api/auth/sessions')).json()) as {
        sessions: Array<{ id: string; current: boolean }>;
      };
      expect(sessionList.sessions).toHaveLength(5);
      expect(sessionList.sessions.some((session) => session.current)).toBe(true);

      const secondSession = sessionList.sessions.find((session) => !session.current);
      if (secondSession === undefined) throw new Error('SESSION_FIXTURE_INVALID');
      expect(
        (
          await firstDevice.delete(`/api/auth/sessions/${encodeURIComponent(secondSession.id)}`, {
            headers: { 'x-csrf-token': (await firstLogin.json()).csrfToken }
          })
        ).status()
      ).toBe(204);
      expect((await firstDevice.get('/api/auth/me')).status()).toBe(200);
      expect((await firstDevice.get('/api/auth/sessions')).status()).toBe(200);
    } finally {
      await Promise.all(
        [firstDevice, secondDevice, ...otherDevices].map((device) => device.dispose())
      );
    }
  });
});

test('Login attempts are rate-limited and no second-account registration endpoint is exposed', async ({
  request
}) => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await request.post(`${baseUrl}/api/auth/login`, {
            data: { username: 'admin', password: 'invalid' }
          })
        ).status()
      ).toBe(401);
    }
    expect(
      (
        await request.post(`${baseUrl}/api/auth/login`, {
          data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
        })
      ).status()
    ).toBe(429);
    expect(
      (
        await request.post(`${baseUrl}/api/auth/register`, { data: { username: 'another' } })
      ).status()
    ).toBe(404);
  });
});

async function withServer(
  callback: (baseUrl: string, databasePath: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-server-e2e-'));
  const databasePath = join(directory, 'server.sqlite');
  const app = createTestServerApp({
    databasePath,
    // Local Playwright HTTP tests explicitly allow non-Secure cookies; production defaults remain Secure.
    secureCookies: false
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await callback(address, databasePath);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
