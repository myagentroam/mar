import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseComposerTags } from '@myagentroam/protocol';
import {
  registerSessionShareRoutes,
  SESSION_SHARE_COOKIE
} from '../../src/session-share-routes.js';
import { SessionShares } from '../../src/session-shares.js';
import { SessionChannelService } from '../../src/session-channel-service.js';
import { hashOpaque } from '../../src/session-token.js';
import { sessionShareStore } from './support/session-share-store.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  await app.register(websocket);
  const { store, rows } = sessionShareStore();
  const actor = {
    userId: 7,
    username: 'owner',
    sessionHash: 'account',
    isAdmin: true,
    mustChangePassword: false,
    csrfTokenHash: hashOpaque('csrf')
  };
  const requestNode = vi.fn(async (..._args: unknown[]) => ({
    session: { id: 'session-one', workspaceId: 'workspace-one' }
  }));
  const nodeControl = { requestNode, ownsWorkbenchConnection: vi.fn(() => true) };
  const invalidate = vi.fn();
  const shares = new SessionShares({ store, authorize: async () => true, nodeControl, invalidate });
  const submitMessage = vi.fn(async () => ({ delivery: 'QUEUED' }));
  const interrupt = vi.fn(async () => ({ interrupted: true }));
  registerSessionShareRoutes({
    app,
    shares,
    channels: new SessionChannelService({ submitMessage, interrupt, executeCommand: vi.fn() }),
    nodeControl,
    database: {
      findCurrentUserSession: (id) => (id === 'account' ? actor : undefined),
      userOwnsNode: async () => true,
      userDisplayName: async () => 'Owner'
    },
    publicOrigin: 'http://localhost',
    secureCookies: false
  });
  await app.ready();
  const headers = {
    cookie: 'mar_user_session=account',
    origin: 'http://localhost',
    'x-csrf-token': 'csrf'
  };
  const url = '/api/agent-sessions/session-one/shares';
  const create = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: { nodeId: 'node-one', workspaceId: 'workspace-one' }
  });
  expect(create.statusCode).toBe(201);
  const created = create.json();
  const base = '/api/session-shares/' + created.share.id;
  return {
    app,
    rows,
    headers,
    created,
    base,
    url,
    submitMessage,
    interrupt,
    requestNode,
    invalidate,
    nodeControl
  };
}

describe('Session sharing HTTP adaptation', () => {
  it('copies share passwords only through authenticated same-origin CSRF-protected management', async () => {
    const f = await fixture();
    const url =
      f.url + '/' + f.created.share.id + '/copy?nodeId=node-one&workspaceId=workspace-one';
    const copied = await f.app.inject({ method: 'POST', url, headers: f.headers, payload: {} });
    expect(copied.statusCode).toBe(200);
    expect(copied.json()).toEqual({ password: f.created.password });
    expect(copied.headers['cache-control']).toBe('private, no-store');
    expect((await f.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { cookie: f.headers.cookie },
          payload: {}
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, origin: 'http://untrusted' },
          payload: {}
        })
      ).statusCode
    ).toBe(403);
    const original = f.rows.get(f.created.share.id)!;
    f.rows.set(original.id, { ...original, password: null });
    expect(
      (await f.app.inject({ method: 'POST', url, headers: f.headers, payload: {} })).json()
    ).toEqual({ password: null });
    const restored = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { password: f.created.password }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ password: f.created.password });
    expect(f.rows.get(original.id)).toEqual(original);
  });
  it('restores a scoped Cookie and delegates messages/interrupt to Channel without account login', async () => {
    const f = await fixture();
    const noAuth = await f.app.inject({
      method: 'GET',
      url: f.base + '/turns',
      headers: f.headers
    });
    expect(noAuth.statusCode).toBe(401);
    const auth = await f.app.inject({
      method: 'POST',
      url: f.base + '/auth',
      payload: { password: f.created.password }
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().workspaceName).toBe('Project Alpha');
    const cookie = String(auth.headers['set-cookie']);
    expect(cookie).toContain('Path=' + f.base + '/; HttpOnly; SameSite=Strict');
    expect(cookie).not.toContain('mar_user_session');
    const sessionHeaders = { cookie: cookie.split(';')[0]!, origin: 'http://localhost' };
    const restored = await f.app.inject({
      method: 'POST',
      url: f.base + '/auth',
      payload: { credential: auth.json().credential }
    });
    expect(restored.statusCode).toBe(200);
    const sent = await f.app.inject({
      method: 'POST',
      url: f.base + '/messages',
      headers: sessionHeaders,
      payload: {
        visitor: { visitorId: 'visitor-one', name: '张三' },
        content: 'Continue',
        clientMessageId: 'message-one',
        deliveryIntent: 'REPLACE_CURRENT'
      }
    });
    expect(sent.statusCode).toBe(202);
    expect(f.submitMessage).toHaveBeenCalledTimes(1);
    const [context, message] = f.submitMessage.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      { content: string }
    ];
    expect(context).toMatchObject({
      nodeId: 'node-one',
      workspaceId: 'workspace-one',
      sessionId: 'session-one',
      user: { userId: 7 }
    });
    expect(parseComposerTags(message.content)[0]).toMatchObject({
      kind: 'mar_channel',
      payload: { source: 'WEB_SHARE', name: '张三' }
    });
    expect(
      (await f.app.inject({ method: 'POST', url: f.base + '/interrupt', headers: sessionHeaders }))
        .statusCode
    ).toBe(202);
    expect(f.interrupt).toHaveBeenCalledWith(context);
    const wrongTarget = await f.app.inject({
      method: 'POST',
      url: f.base + '/messages',
      headers: sessionHeaders,
      payload: {
        nodeId: 'other',
        visitor: { visitorId: 'visitor-one', name: 'Alice' },
        content: 'Continue',
        clientMessageId: 'two'
      }
    });
    expect(wrongTarget.statusCode).toBe(400);
    expect(f.submitMessage).toHaveBeenCalledTimes(1);
    const gone = await f.app.inject({
      method: 'DELETE',
      url: f.url + '/' + f.created.share.id + '?nodeId=node-one&workspaceId=workspace-one',
      headers: f.headers
    });
    expect(gone.statusCode).toBe(204);
    expect(f.invalidate).toHaveBeenCalled();
    expect(
      (await f.app.inject({ method: 'POST', url: f.base + '/interrupt', headers: sessionHeaders }))
        .statusCode
    ).toBe(404);
    expect(f.interrupt).toHaveBeenCalledTimes(1);
  });

  it('requires workbench CSRF for management and rejects cross-origin share writes', async () => {
    const f = await fixture();
    const invalidCsrf = await f.app.inject({
      method: 'POST',
      url: f.url,
      headers: { cookie: f.headers.cookie },
      payload: { nodeId: 'node-one', workspaceId: 'workspace-one' }
    });
    expect(invalidCsrf.statusCode).toBe(403);
    const crossOrigin = await f.app.inject({
      method: 'POST',
      url: f.base + '/auth',
      headers: { origin: 'http://untrusted' },
      payload: { password: f.created.password }
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    const listed = await f.app.inject({
      url: f.url + '?nodeId=node-one&workspaceId=workspace-one',
      headers: f.headers
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain('passwordHash');
    expect(JSON.stringify(listed.json())).not.toContain('credential');
    expect(SESSION_SHARE_COOKIE).not.toBe('mar_user_session');
  });
});
