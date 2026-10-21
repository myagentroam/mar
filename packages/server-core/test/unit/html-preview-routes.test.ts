import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { hashOpaque } from '../../src/session-token.js';
import { sendError } from '../../src/http-errors.js';
import {
  registerHtmlPreviewRoutes,
  htmlPreviewResourcePath
} from '../../src/html-preview-routes.js';
import { HtmlPreviewOrigin, parseHtmlPreviewOrigin } from '../../src/html-preview-origin.js';
import { SessionShares } from '../../src/session-shares.js';
import { SESSION_SHARE_COOKIE } from '../../src/session-share-routes.js';
import { sessionShareStore } from './support/session-share-store.js';

describe('Executable HTML preview', () => {
  it('requires a clean relative path and a valid configured origin', () => {
    expect(htmlPreviewResourcePath('pages/demo', 'scripts/app.js')).toBe(
      'pages/demo/scripts/app.js'
    );
    for (const invalid of [
      '../secret.txt',
      '/absolute',
      'sub//file.js',
      'sub\\file.js',
      'sub/./file.js'
    ])
      expect(htmlPreviewResourcePath('pages/demo', invalid)).toBeUndefined();
    expect(parseHtmlPreviewOrigin('')).toBe('');
    expect(parseHtmlPreviewOrigin('https://preview.example.test')).toBe(
      'https://preview.example.test'
    );
    expect(parseHtmlPreviewOrigin('http://example.test')).toBeUndefined();
    expect(parseHtmlPreviewOrigin('https://example.test/path')).toBeUndefined();
  });

  it('reads persisted origin values and validates writes', async () => {
    let stored: unknown;
    const execute = vi.fn(async (statement: string, values: unknown[]) => {
      if (statement.startsWith('SELECT'))
        return [[stored === undefined ? {} : { setting_value: stored }]];
      stored = values[1];
      return [[]];
    });
    const settings = new HtmlPreviewOrigin({ raw: { execute } as never });
    expect(await settings.read()).toBe('');
    await settings.write('https://preview.example.test');
    expect(await settings.read()).toBe('https://preview.example.test');
    stored = 'https://preview.example.test';
    expect(await settings.read()).toBe('https://preview.example.test');
    await expect(settings.write('javascript:alert(1)')).rejects.toThrow(
      'SYSTEM_SETTING_INPUT_INVALID'
    );
  });

  it('authorizes each resource, preserves executable MIME and rejects revoked sessions and escapes', async () => {
    const app = Fastify();
    let active = true;
    let configured = '';
    let boundaryVerified = true;
    const seen: string[] = [];
    const content: Record<string, string> = {
      'pages/demo/index.html': '<script type="module" src="./js/app.mjs"></script>',
      'pages/demo/js/app.mjs': "import '../css/style.css';",
      'pages/demo/css/style.css': 'body { color: red; }'
    };
    const nodeControl = {
      requestNode: vi.fn(async (_nodeId: string, _op: string, data: unknown) => {
        const input = data as {
          path: string;
          previewDirectory?: string;
          offset: number;
          limit: number;
        };
        seen.push(input.path);
        if (input.previewDirectory !== undefined) expect(input.previewDirectory).toBe('pages/demo');
        const bytes = Buffer.from(content[input.path] ?? '');
        if (!Object.hasOwn(content, input.path)) throw new Error('FILE_NOT_FOUND');
        return {
          previewBoundaryVerified: boundaryVerified,
          file: {
            size: bytes.length,
            offset: input.offset,
            contentBase64: bytes
              .subarray(input.offset, input.offset + input.limit)
              .toString('base64')
          }
        };
      })
    };
    registerHtmlPreviewRoutes({
      app,
      database: {
        findCurrentUserSession: (sessionId) =>
          active && sessionId === 'session'
            ? {
                userId: 1,
                username: 'admin',
                isAdmin: true,
                sessionHash: 'session-hash',
                mustChangePassword: false,
                csrfTokenHash: hashOpaque('csrf')
              }
            : undefined
      },
      nodeControl: nodeControl as never,
      originSetting: { read: async () => configured },
      publicOrigin: 'http://localhost',
      databaseError: (reply, error) =>
        sendError(reply, 404, error instanceof Error ? error.message : 'FILE_NOT_FOUND')
    });
    app.get('/api/auth/me', async () => ({ userId: 1 }));
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/html-preview/grants',
        headers: { cookie: 'mar_user_session=session' },
        payload: { nodeId: 'node', workspaceId: 'workspace', path: 'pages/demo/index.html' }
      });
      expect(denied.statusCode).toBe(403);
      boundaryVerified = false;
      const olderNode = await app.inject({
        method: 'POST',
        url: '/api/html-preview/grants',
        headers: { cookie: 'mar_user_session=session', 'x-csrf-token': 'csrf' },
        payload: { nodeId: 'node', workspaceId: 'workspace', path: 'pages/demo/index.html' }
      });
      expect(olderNode.statusCode).not.toBe(200);
      boundaryVerified = true;
      const granted = await app.inject({
        method: 'POST',
        url: '/api/html-preview/grants',
        headers: { cookie: 'mar_user_session=session', 'x-csrf-token': 'csrf' },
        payload: { nodeId: 'node', workspaceId: 'workspace', path: 'pages/demo/index.html' }
      });
      expect(granted.statusCode).toBe(200);
      const url = new URL(granted.json().url as string);
      const html = await app.inject({ method: 'GET', url: url.pathname });
      expect(html.statusCode).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts');
      expect(html.body).toContain('type="module"');
      const script = await app.inject({
        method: 'GET',
        url: url.pathname.replace('index.html', 'js/app.mjs')
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers['content-type']).toContain('text/javascript');
      expect(script.body).toContain('import');
      const forbidden = await app.inject({
        method: 'GET',
        url: url.pathname.replace('index.html', '%2e%2e%2fsecret.txt')
      });
      expect(forbidden.statusCode).not.toBe(200);
      configured = 'https://preview.example.test';
      expect((await app.inject({ method: 'GET', url: url.pathname })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/auth/me',
            headers: { host: 'preview.example.test' }
          })
        ).statusCode
      ).toBe(403);
      expect((await app.inject({ url: '/api/auth/me' })).statusCode).toBe(200);
      const separate = await app.inject({
        method: 'POST',
        url: '/api/html-preview/grants',
        headers: { cookie: 'mar_user_session=session', 'x-csrf-token': 'csrf' },
        payload: { nodeId: 'node', workspaceId: 'workspace', path: 'pages/demo/index.html' }
      });
      expect(separate.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            url: new URL(separate.json().url as string).pathname,
            headers: { host: 'preview.example.test' }
          })
        ).statusCode
      ).toBe(200);
      configured = '';
      active = false;
      expect((await app.inject({ method: 'GET', url: url.pathname })).statusCode).toBe(401);
      expect(seen).toContain('pages/demo/js/app.mjs');
    } finally {
      await app.close();
    }
  });

  it('rechecks share grants for every Range chunk and invalidates them on share deletion without account fallback', async () => {
    const app = Fastify();
    const { store, rows } = sessionShareStore();
    const target = { nodeId: 'node-one', workspaceId: 'workspace-one', sessionId: 'session-one' };
    const authorize = vi.fn(async () => true);
    const bytes = Buffer.alloc(512 * 1024 + 4, 0x61);
    const nodeControl = {
      requestNode: vi.fn(async (_nodeId: string, operation: string, raw: unknown) => {
        if (operation === 'session.get')
          return { session: { id: target.sessionId, workspaceId: target.workspaceId } };
        const input = raw as { path: string; offset: number; limit: number };
        return {
          previewBoundaryVerified: true,
          file: {
            size: bytes.length,
            offset: input.offset,
            contentBase64: bytes
              .subarray(input.offset, input.offset + input.limit)
              .toString('base64')
          }
        };
      })
    };
    const shares = new SessionShares({
      store,
      nodeControl: nodeControl as never,
      authorize,
      invalidate: vi.fn()
    });
    const created = await shares.create(
      { userId: 7, username: 'owner', sessionHash: 'owner-session' },
      target,
      null
    );
    const credential = rows.get(created.share.id)!.credential;
    const findCurrentUserSession = vi.fn((sessionId: string) =>
      sessionId === 'account'
        ? {
            userId: 7,
            username: 'owner',
            isAdmin: true,
            sessionHash: 'account-session',
            mustChangePassword: false,
            csrfTokenHash: hashOpaque('csrf')
          }
        : undefined
    );
    registerHtmlPreviewRoutes({
      app,
      database: { findCurrentUserSession },
      nodeControl: nodeControl as never,
      originSetting: { read: async () => '' },
      publicOrigin: 'http://localhost',
      shares,
      databaseError: (reply, error) =>
        sendError(reply, 404, error instanceof Error ? error.message : 'FILE_NOT_FOUND')
    });
    try {
      const grant = await app.inject({
        method: 'POST',
        url: '/api/session-shares/' + created.share.id + '/html-preview/grants',
        headers: {
          origin: 'http://localhost',
          cookie: SESSION_SHARE_COOKIE + '=' + credential
        },
        payload: { path: 'pages/demo/index.html' }
      });
      expect(grant.statusCode).toBe(200);
      const grantPath = new URL(grant.json().url as string).pathname;
      const beforeRead = authorize.mock.calls.length;
      const range = await app.inject({
        url: grantPath,
        headers: { range: 'bytes=0-524288' }
      });
      expect(range.statusCode).toBe(206);
      expect(range.headers['content-range']).toBe('bytes 0-524288/524292');
      expect(range.rawPayload).toEqual(bytes.subarray(0, 524289));
      expect(authorize.mock.calls.length - beforeRead).toBe(4);

      await shares.delete(7, target, created.share.id);
      const afterDelete = await app.inject({
        url: grantPath,
        headers: { cookie: 'mar_user_session=account' }
      });
      expect(afterDelete.statusCode).toBe(404);
      expect(afterDelete.json().error.code).toBe('SESSION_SHARE_NOT_FOUND');
      expect(findCurrentUserSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
