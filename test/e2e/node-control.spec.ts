import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import {
  createEnvelope,
  nodeEnvelopeSchema,
  type NodeEnvelope
} from '../../packages/protocol/src/index.js';
import { createTestServerApp as createServerApp } from '../support/create-test-server-app.js';
import { NodeUpgradeService } from '../../packages/server-core/src/node-upgrade-service.js';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Workspace-only grants retain canonical ID-only relay access through cleanup and invalidate deleted resources', async () => {
  const server = await createEnterpriseTestServer('resource-scope');
  let socket: WebSocket | undefined;
  try {
    async function api<T>(
      headers: Record<string, string>,
      method: string,
      path: string,
      data?: unknown,
      status = 200
    ): Promise<T> {
      const response = await fetch(server.baseURL + path, {
        method,
        headers: {
          ...headers,
          ...(data === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
      const body = response.status === 204 ? undefined : await response.json();
      expect(response.status, JSON.stringify(body)).toBe(status);
      return body as T;
    }
    async function login(username: string, password: string): Promise<Record<string, string>> {
      const response = await fetch(server.baseURL + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      expect(response.status).toBe(200);
      const login = (await response.json()) as { csrfToken: string };
      const changed = await fetch(server.baseURL + '/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: response.headers.get('set-cookie')!.split(';')[0]!,
          'x-csrf-token': login.csrfToken
        },
        body: JSON.stringify({ currentPassword: password, password: 'ResourceScopeTest123!' })
      });
      expect(changed.status).toBe(200);
      return {
        cookie: changed.headers.get('set-cookie')!.split(';')[0]!,
        'x-csrf-token': ((await changed.json()) as { csrfToken: string }).csrfToken
      };
    }
    const admin = await login('admin', INITIAL_ADMIN_PASSWORD);
    await api(admin, 'POST', '/api/license/import', {
      document: createPlaywrightTestLicenseDocument()
    });
    const memberRecord = await api<{ user: { id: number }; temporaryPassword: string }>(
      admin,
      'POST',
      '/api/enterprise/users',
      { username: 'scope-member', role: 'MEMBER', organizationId: 1 },
      201
    );
    const member = await login('scope-member', memberRecord.temporaryPassword);
    await api(
      member,
      'POST',
      '/api/node-registration-tokens',
      {
        displayName: 'Unauthorized organization Node',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      },
      403
    );
    const verification = await mysql.createConnection(server.databaseUrl);
    try {
      const [tokens] = await verification.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM node_registration_tokens'
      );
      expect(Number(tokens[0]?.['count'])).toBe(0);
    } finally {
      await verification.end();
    }
    const registration = await api<{ token: string }>(
      admin,
      'POST',
      '/api/node-registration-tokens',
      {
        displayName: 'Resource scope relay Node',
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      }
    );
    socket = new WebSocket(server.baseURL.replace('http', 'ws') + '/api/node/connect');
    await onceOpen(socket);
    const registered = onceMessage(socket);
    socket.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: registration.token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            nodeAppVersion: nodePackage.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        })
      )
    );
    const identity = await registered;
    expect(identity.type).toBe('registered');
    const nodeId = (identity.payload as { nodeId: string }).nodeId;
    const workspace = { id: 'scope-w', path: '/fixture/workspace', kind: 'DIRECTORY' };
    const session = {
      id: 'scope-s',
      workspaceId: workspace.id,
      runner: 'codex',
      customTitle: 'Scope fixture'
    };
    const operations: string[] = [];
    // The Node producer is controlled; HTTP, MySQL authorization and control transport are real.
    socket.addEventListener('message', (event) => {
      const frame = nodeEnvelopeSchema.parse(JSON.parse(String(event.data)));
      if (frame.type !== 'node.request') return;
      const { operation } = frame.payload as { operation: string };
      operations.push(operation);
      let result: unknown;
      if (operation === 'workspace.register') result = { workspace };
      else if (operation === 'session.list') result = { sessions: [session] };
      else if (operation === 'session.get') result = { session };
      else if (operation === 'run.image.read')
        result = {
          image: { mime: 'image/png', dataBase64: Buffer.from('fixture-image').toString('base64') }
        };
      else if (operation === 'session.remove') result = { deleted: true };
      else if (operation === 'workspace.sessions.cleanup')
        result = { deleted: 0, skipped: 1, failed: 0, deletedByRunner: {} };
      else throw new Error('UNEXPECTED_NODE_OPERATION: ' + operation);
      socket!.send(
        JSON.stringify(createEnvelope('node.response', { result }, { replyTo: frame.id }))
      );
    });
    await api(
      admin,
      'POST',
      '/api/workspaces',
      {
        nodeId,
        path: workspace.path,
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 1 }
      },
      201
    );
    const grant = () =>
      api<{ id: string }>(
        admin,
        'POST',
        '/api/resource-grants',
        {
          resourceType: 'WORKSPACE',
          nodeId,
          workspaceId: workspace.id,
          targetType: 'USER',
          targetUserId: memberRecord.user.id
        },
        201
      );
    const permission = await grant();
    const detailUrl = '/api/agent-sessions/' + session.id + '?nodeId=' + nodeId;
    const imageUrl =
      '/api/agent-runs/' +
      encodeURIComponent('native-history:' + session.id) +
      '/images/' +
      encodeURIComponent('reader:fixture') +
      '?nodeId=' +
      nodeId;
    const denied = await api<{ error: { code: string } }>(member, 'GET', detailUrl, undefined, 403);
    expect(denied.error.code).toBe('NODE_ACCESS_DENIED');
    await api(member, 'GET', imageUrl, undefined, 403);
    expect(operations).toEqual(['workspace.register']);
    const listed = await api<{ sessions: { id: string }[] }>(
      member,
      'GET',
      '/api/agent-sessions?nodeId=' + nodeId + '&workspaceId=' + workspace.id
    );
    expect(listed.sessions[0]?.id).toBe(session.id);
    const image = await fetch(server.baseURL + imageUrl, { headers: member });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe('fixture-image');
    expect(await api(member, 'GET', detailUrl)).toMatchObject({ session: { id: session.id } });
    await api(admin, 'POST', '/api/workspaces/' + workspace.id + '/sessions/cleanup', {
      nodeId,
      inactiveDays: 7
    });
    expect(await api(member, 'GET', detailUrl)).toMatchObject({ session: { id: session.id } });
    await api(admin, 'DELETE', '/api/resource-grants/' + permission.id, undefined, 204);
    const beforeRevoked = operations.length;
    await api(member, 'GET', detailUrl, undefined, 403);
    await api(member, 'GET', imageUrl, undefined, 403);
    expect(operations).toHaveLength(beforeRevoked);
    await grant();
    await api(member, 'DELETE', detailUrl);
    const beforeDeleted = operations.length;
    await api(member, 'GET', detailUrl, undefined, 403);
    await api(member, 'GET', imageUrl, undefined, 403);
    expect(operations).toHaveLength(beforeDeleted);
    expect(operations).toEqual([
      'workspace.register',
      'session.list',
      'run.image.read',
      'session.get',
      'workspace.sessions.cleanup',
      'session.get',
      'session.remove'
    ]);
  } finally {
    socket?.close();
    await server.close();
  }
});

test('Admin creates a one-use token and Node registers, sends heartbeats, and can be revoked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-node-e2e-'));
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const cookie = cookieFrom(login.headers['set-cookie']);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie, 'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'node-e2e-password-123' }
    });
    const adminCookie = cookieFrom(changed.headers['set-cookie']);
    const crossOriginToken = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: {
        cookie: adminCookie,
        origin: 'https://attacker.example',
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(crossOriginToken).toMatchObject({ statusCode: 403 });
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(tokenResponse.statusCode).toBe(200);
    const token = tokenResponse.json<{ token: string }>().token;

    const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/api/node/connect');
    await onceOpen(socket);
    socket.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        })
      )
    );
    const registered = await onceMessage(socket);
    expect(registered.type).toBe('registered');
    const nodeId = (registered.payload as { nodeId: string }).nodeId;
    socket.send(JSON.stringify(createEnvelope('heartbeat', {})));
    await expect
      .poll(async () => {
        const nodes = await app.inject({
          method: 'GET',
          url: '/api/nodes',
          headers: { cookie: adminCookie }
        });
        return nodes.json<{ nodes: { id: string; connected: boolean }[] }>().nodes;
      })
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: nodeId, connected: true })]));

    const secondToken = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    const secondSocket = new WebSocket(baseUrl.replace('http', 'ws') + '/api/node/connect');
    await onceOpen(secondSocket);
    secondSocket.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: secondToken.json<{ token: string }>().token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            codex: { available: false },
            claudeCode: { available: false }
          }
        })
      )
    );
    const secondRegistered = await onceMessage(secondSocket);
    expect(secondRegistered.type).toBe('registered');
    const secondNodeId = (secondRegistered.payload as { nodeId: string }).nodeId;

    const workspaceRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      },
      payload: { nodeId, path: '/safe/workspace' }
    });
    const inspection = await onceMessage(socket);
    expect(inspection.type).toBe('node.request');
    expect(inspection.payload).toMatchObject({ operation: 'workspace.register' });
    secondSocket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          { result: { workspace: { id: 'attacker', path: '/attacker/workspace' } } },
          { replyTo: inspection.id }
        )
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              workspace: {
                id: 'workspace-node-1',
                path: '/safe/workspace',
                kind: 'DIRECTORY'
              }
            }
          },
          { replyTo: inspection.id }
        )
      )
    );
    expect((await workspaceRequest).statusCode).toBe(201);
    const workspacesRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces?nodeId=${nodeId}`,
      headers: { cookie: adminCookie }
    });
    const listCommand = await onceMessage(socket);
    expect(listCommand).toMatchObject({
      type: 'node.request',
      payload: { operation: 'workspace.list' }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              workspaces: [
                {
                  id: 'workspace-node-1',
                  path: '/safe/workspace',
                  kind: 'DIRECTORY'
                }
              ]
            }
          },
          { replyTo: listCommand.id }
        )
      )
    );
    expect((await workspacesRequest).json()).toMatchObject({
      workspaces: [expect.objectContaining({ kind: 'DIRECTORY' })]
    });

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/revoke`,
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(revoke.statusCode).toBe(204);
    const crossOriginWorkspace = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: adminCookie,
        origin: 'https://attacker.example',
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      },
      payload: { nodeId, path: '/safe/workspace' }
    });
    expect(crossOriginWorkspace).toMatchObject({ statusCode: 403 });
    const crossOriginRevoke = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/revoke`,
      headers: {
        cookie: adminCookie,
        origin: 'https://attacker.example',
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(crossOriginRevoke).toMatchObject({ statusCode: 403 });
    const crossOriginDelete = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${nodeId}`,
      headers: {
        cookie: adminCookie,
        origin: 'https://attacker.example',
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(crossOriginDelete).toMatchObject({ statusCode: 403 });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${nodeId}`,
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(deleted.statusCode).toBe(204);
    const deletedConnectedNode = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${secondNodeId}`,
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    expect(deletedConnectedNode.statusCode).toBe(204);
    await expect.poll(() => secondSocket.readyState).toBe(WebSocket.CLOSED);
    const nodesAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      headers: { cookie: adminCookie }
    });
    expect(nodesAfterDelete.json<{ nodes: { id: string }[] }>().nodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: nodeId })])
    );
    expect(nodesAfterDelete.json<{ nodes: { id: string }[] }>().nodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondNodeId })])
    );
    await expect(app.shutdown()).resolves.toBeUndefined();
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
    socket.close();
    secondSocket.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Node management sends the latest npm stable version not exceeding Server to Supervisor-capable Nodes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-upgrade-e2e-'));
  const nodeUpgrades = new NodeUpgradeService('0.1.8', async (specifier) =>
    specifier === '@myagentroam/node' ? ['0.1.9', '0.1.7', '0.1.6'] : undefined
  );
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false,
    nodeUpgrades
  });
  let nodeProcess: ChildProcess | undefined;
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: cookieFrom(login.headers['set-cookie']),
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'upgrade-e2e-password-123' }
    });
    const cookie = cookieFrom(changed.headers['set-cookie']);
    const csrf = changed.json<{ csrfToken: string }>().csrfToken;
    const registration = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: { cookie, 'x-csrf-token': csrf }
    });
    const configPath = join(directory, 'node.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: baseUrl,
        allowedRoots: [directory],
        dataDirectory: directory,
        registrationToken: registration.json<{ token: string }>().token
      })
    );
    const nodeScript = `
      import { NodeConnector } from './mar-node/src/connector.ts';
      const configPath = process.argv[1];
      const connector = new NodeConnector({
        configPath,
        capabilities: {
          platform: 'linux', architecture: 'x64', nodeAppVersion: '0.1.6',
          nodeVersion: process.version, codex: { available: false },
          claudeCode: { available: false }, openCode: { available: false }
        },
        reconnect: false,
        upgradeReady: () => undefined
      });
      await connector.start();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => connector.stop());
    `;
    nodeProcess = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', nodeScript, configPath],
      {
        cwd: process.cwd(),
        stdio: 'ignore',
        env: { ...process.env, MAR_NODE_SUPERVISED: '1' }
      }
    );
    await expect
      .poll(async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/nodes',
          headers: { cookie }
        });
        return response
          .json<{ nodes: { connected: boolean }[] }>()
          .nodes.some((node) => node.connected);
      })
      .toBe(true);
    const nodes = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
    const node = nodes.json<{
      nodes: { id: string; upgradeAvailability: { state: string; targetVersion: string } }[];
    }>().nodes[0]!;
    const nodeId = node.id;
    expect(node.upgradeAvailability).toEqual({ state: 'AVAILABLE', targetVersion: '0.1.7' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/nodes/${nodeId}/upgrade`,
      headers: { cookie, 'x-csrf-token': csrf }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'ACCEPTED', targetVersion: '0.1.7' });
    await expect
      .poll(() => readFile(join(directory, 'upgrade-request.json'), 'utf8').catch(() => ''))
      .toContain('"targetVersion":"0.1.7"');
  } finally {
    if (nodeProcess?.exitCode === null) nodeProcess.kill('SIGTERM');
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('NodeConnector reconnects with credentials and restores online status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-node-connector-e2e-'));
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  const connectorConfig = join(directory, 'node.json');
  const capabilities = {
    platform: 'linux' as const,
    architecture: 'x64',
    nodeVersion: process.version,
    codex: { available: false },
    claudeCode: { available: false }
  };
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        cookie: cookieFrom(login.headers['set-cookie']),
        'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
      },
      payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'connector-e2e-password-123' }
    });
    const adminCookie = cookieFrom(changed.headers['set-cookie']);
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: {
        cookie: adminCookie,
        'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
      }
    });
    const first = new NodeConnector({
      configPath: connectorConfig,
      config: {
        serverUrl: baseUrl,
        allowedRoots: [directory],
        registrationToken: token.json<{ token: string }>().token
      },
      capabilities,
      reconnect: false
    });
    await first.start();
    const nodeId = await waitForConnectedNode(app, adminCookie);
    first.stop();
    await expect.poll(() => nodeOnline(app, adminCookie, nodeId)).toBe(false);

    const second = new NodeConnector({
      configPath: connectorConfig,
      capabilities,
      reconnect: false
    });
    await second.start();
    await expect.poll(() => nodeOnline(app, adminCookie, nodeId)).toBe(true);
    second.stop();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WEBSOCKET_ERROR')), { once: true });
  });
}

function onceMessage(socket: WebSocket): Promise<NodeEnvelope> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => {
        try {
          resolve(nodeEnvelopeSchema.parse(JSON.parse(String(event.data))));
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    socket.addEventListener('error', () => reject(new Error('WEBSOCKET_ERROR')), { once: true });
  });
}

function cookieFrom(value: string | string[] | number | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : typeof value === 'string' ? value : '';
}

async function waitForConnectedNode(
  app: ReturnType<typeof createServerApp>,
  cookie: string
): Promise<string> {
  await expect
    .poll(async () => {
      const response = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
      return response.json<{ nodes: { id: string; connected: boolean }[] }>().nodes;
    })
    .toEqual(expect.arrayContaining([expect.objectContaining({ connected: true })]));
  const response = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
  return response.json<{ nodes: { id: string }[] }>().nodes[0]?.id ?? '';
}

async function nodeOnline(
  app: ReturnType<typeof createServerApp>,
  cookie: string,
  nodeId: string
): Promise<boolean> {
  const response = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
  return (
    response
      .json<{ nodes: { id: string; connected: boolean }[] }>()
      .nodes.find((node) => node.id === nodeId)?.connected ?? false
  );
}
