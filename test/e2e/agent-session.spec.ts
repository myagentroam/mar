import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodePackage from '../../mar-node/package.json' with { type: 'json' };
import { expect, test } from '@playwright/test';
import { createEnvelope, type NodeEnvelope } from '../../packages/protocol/src/index.js';
import { createTestServerApp as createServerApp } from '../support/create-test-server-app.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Admin queries and controls sessions through Server and Node without storing execution data on Server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-agent-roam-session-e2e-'));
  const app = createServerApp({
    databasePath: join(directory, 'server.sqlite'),
    secureCookies: false
  });
  let socket: WebSocket | undefined;
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const admin = await loginAndChangePassword(app);
    const token = await app.inject({
      method: 'POST',
      url: '/api/node-registration-tokens',
      headers: admin.headers
    });
    socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/node/connect`);
    await opened(socket);
    socket.send(
      JSON.stringify(
        createEnvelope('register', {
          registrationToken: token.json<{ token: string }>().token,
          capabilities: {
            platform: 'linux',
            architecture: 'x64',
            nodeVersion: process.version,
            nodeAppVersion: nodePackage.version,
            codex: { available: true, version: 'test' },
            claudeCode: { available: true, version: 'test' }
          }
        })
      )
    );
    const registered = await message(socket);
    const nodeId = (registered.payload as { nodeId: string }).nodeId;

    const workspaceRequest = app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: admin.headers,
      payload: { nodeId, path: '/project' }
    });
    const workspaceCommand = await message(socket);
    expect(workspaceCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'workspace.register',
        userAuthorization: {
          userId: 1,
          nodeId,
          operation: 'workspace.register',
          requestId: workspaceCommand.id,
          sessionHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          issuedAt: expect.any(Number),
          expiresAt: expect.any(Number)
        }
      }
    });
    expect(
      (workspaceCommand.payload as { userAuthorization: { expiresAt: number; issuedAt: number } })
        .userAuthorization.expiresAt
    ).toBeGreaterThan(
      (workspaceCommand.payload as { userAuthorization: { expiresAt: number; issuedAt: number } })
        .userAuthorization.issuedAt
    );
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              workspace: {
                id: 'workspace-node-1',
                path: '/project',
                kind: 'DIRECTORY'
              }
            }
          },
          { replyTo: workspaceCommand.id }
        )
      )
    );
    expect((await workspaceRequest).json()).toMatchObject({
      workspace: { id: 'workspace-node-1' }
    });

    const sessionRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/start',
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId: 'workspace-node-1',
        runner: 'codex',
        cwd: '/project',
        clientMessageId: 'first-message',
        content: '开始'
      }
    });
    const sessionCommand = await message(socket);
    expect(sessionCommand).toMatchObject({
      type: 'node.request',
      payload: { operation: 'session.start' }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              session: {
                id: 'session-node-1',
                nodeId,
                workspaceId: 'workspace-node-1',
                runner: 'codex',
                cwd: '/project'
              },
              run: { id: 'run-first', sessionId: 'session-node-1', status: 'RUNNING' },
              delivery: 'STARTED'
            }
          },
          { replyTo: sessionCommand.id }
        )
      )
    );
    expect((await sessionRequest).statusCode).toBe(201);

    const listRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions?nodeId=${nodeId}&workspaceId=workspace-node-1&limit=10&cursor=previous&query=release`,
      headers: admin.headers
    });
    const listCommand = await message(socket);
    expect(listCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'session.list',
        data: {
          workspaceId: 'workspace-node-1',
          limit: 10,
          cursor: 'previous',
          query: 'release'
        }
      }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: { sessions: [{ id: 'session-node-1', nodeId }], nextCursor: null }
          },
          { replyTo: listCommand.id }
        )
      )
    );
    expect((await listRequest).json()).toMatchObject({ sessions: [{ id: 'session-node-1' }] });

    const channelTokenRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions/session-node-1/channel-token?nodeId=${nodeId}`,
      headers: admin.headers
    });
    const channelTokenCommand = await message(socket);
    expect(channelTokenCommand).toMatchObject({
      type: 'node.request',
      payload: { operation: 'session.channel.token', data: { sessionId: 'session-node-1' } }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          { result: { token: 'node-local-channel-token' } },
          { replyTo: channelTokenCommand.id }
        )
      )
    );
    expect((await channelTokenRequest).json()).toEqual({ token: 'node-local-channel-token' });

    const discoverRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/discover',
      headers: admin.headers,
      payload: { nodeId, runner: 'codex', workspaceId: 'workspace-node-1' }
    });
    const discoverCommand = await message(socket);
    expect(discoverCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'session.discover',
        data: { runner: 'codex', workspaceId: 'workspace-node-1' }
      }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              sessions: [
                {
                  id: 'vscode-session-1',
                  nodeId,
                  runner: 'codex',
                  externalSessionId: 'vscode-thread-1',
                  control: { level: 'MANAGED' }
                }
              ]
            }
          },
          { replyTo: discoverCommand.id }
        )
      )
    );
    expect((await discoverRequest).json()).toMatchObject({
      sessions: [expect.objectContaining({ externalSessionId: 'vscode-thread-1' })]
    });

    const messageRequest = app.inject({
      method: 'POST',
      url: '/api/agent-sessions/session-node-1/messages',
      headers: admin.headers,
      payload: {
        nodeId,
        workspaceId: 'workspace-node-1',
        clientMessageId: 'message-1',
        content: 'continue',
        attachmentIds: ['00000000-0000-4000-8000-000000000001']
      }
    });
    const messageCommand = await message(socket);
    expect(messageCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'session.message',
        data: { attachmentIds: ['00000000-0000-4000-8000-000000000001'] }
      }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: { run: { id: 'run-node-1', nodeId, status: 'RUNNING' }, idempotent: false }
          },
          { replyTo: messageCommand.id }
        )
      )
    );
    expect((await messageRequest).json()).toMatchObject({ run: { id: 'run-node-1' } });

    const sessionRunsRequest = app.inject({
      method: 'GET',
      url: `/api/agent-sessions/session-node-1/runs?nodeId=${nodeId}`,
      headers: admin.headers
    });
    const sessionRunsCommand = await message(socket);
    expect(sessionRunsCommand).toMatchObject({
      type: 'node.request',
      payload: { operation: 'session.runs', data: { sessionId: 'session-node-1' } }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          {
            result: {
              runs: [
                {
                  id: 'run-node-1',
                  sessionId: 'session-node-1',
                  nodeId,
                  status: 'RUNNING'
                }
              ]
            }
          },
          { replyTo: sessionRunsCommand.id }
        )
      )
    );
    expect((await sessionRunsRequest).json()).toMatchObject({
      runs: [expect.objectContaining({ id: 'run-node-1', sessionId: 'session-node-1' })]
    });

    const diffRequest = app.inject({
      method: 'GET',
      url: `/api/workspaces/workspace-node-1/diff?nodeId=${nodeId}&from=main&to=feature`,
      headers: admin.headers
    });
    const diffCommand = await message(socket);
    expect(diffCommand).toMatchObject({
      type: 'node.request',
      payload: {
        operation: 'workspace.diff',
        data: { workspaceId: 'workspace-node-1', fromRef: 'main', toRef: 'feature' }
      }
    });
    socket.send(
      JSON.stringify(
        createEnvelope(
          'node.response',
          { result: { diff: { binary: false, text: 'safe diff', truncated: false } } },
          { replyTo: diffCommand.id }
        )
      )
    );
    expect((await diffRequest).json()).toMatchObject({ diff: { text: 'safe diff' } });

    expect(
      (
        await fetch(`${baseUrl}/api/agent-runs/run-node-1/events?nodeId=${nodeId}`, {
          headers: { cookie: admin.headers.cookie ?? '' }
        })
      ).status
    ).toBe(404);
  } finally {
    socket?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function loginAndChangePassword(
  app: ReturnType<typeof createServerApp>
): Promise<{ headers: Record<string, string> }> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
  });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: {
      cookie: cookie(login.headers['set-cookie']),
      'x-csrf-token': login.json<{ csrfToken: string }>().csrfToken
    },
    payload: { currentPassword: INITIAL_ADMIN_PASSWORD, password: 'agent-session-e2e-password' }
  });
  return {
    headers: {
      cookie: cookie(changed.headers['set-cookie']),
      'x-csrf-token': changed.json<{ csrfToken: string }>().csrfToken
    }
  };
}

function cookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) throw new Error('COOKIE_MISSING');
  return first.split(';')[0] ?? first;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('SOCKET_ERROR'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function message(socket: WebSocket): Promise<NodeEnvelope> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent): void => {
      cleanup();
      try {
        resolve(JSON.parse(String(event.data)) as NodeEnvelope);
      } catch {
        reject(new Error('MESSAGE_INVALID'));
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('SOCKET_ERROR'));
    };
    socket.addEventListener('message', onMessage, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}
