import Fastify from 'fastify';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWebStaticRoutes } from '../../src/web-static-routes.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mar-static-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'web');
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'docs/en-US/getting-started'), { recursive: true });
  const files = {
    'index.html': '<html>console</html>',
    'web-version.json': '{"version":"0.10.1"}',
    'manifest.webmanifest': '{"start_url":"/console"}',
    'service-worker.js': 'self.addEventListener("install",()=>{});',
    'assets/app-abcdef12.mjs': 'export const message = "hello";',
    'docs/en-US/getting-started/overview.html': '<html>documentation</html>'
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const app = Fastify();
  cleanups.push(() => app.close());
  app.get('/api/test', () => ({ ok: true }));
  app.get('/health', () => ({ status: 'ok' }));
  registerWebStaticRoutes(app, root);
  return { app, root, directory };
}

describe('Server Web distribution', () => {
  it('serves application routes and real help deep links without intercepting API routes', async () => {
    const { app } = await fixture();
    for (const url of ['/', '/console', '/console/deep-link']) {
      const reply = await app.inject(url);
      expect(reply.statusCode).toBe(200);
      expect(reply.headers['content-type']).toContain('text/html');
      expect(reply.body).toBe('<html>console</html>');
    }
    const docs = await app.inject('/docs/en-US/getting-started/overview');
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toBe('<html>documentation</html>');
    expect((await app.inject('/api/test')).json()).toEqual({ ok: true });
    expect((await app.inject('/health')).statusCode).toBe(200);
    for (const url of ['/api/missing', '/docs/missing', '/assets/missing.js', '/missing.js']) {
      const reply = await app.inject(url);
      expect(reply.statusCode).toBe(404);
      expect(reply.json().error.code).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('preserves help language redirects, PWA MIME and update cache rules', async () => {
    const { app } = await fixture();
    for (const url of ['/docs', '/docs/', '/docs/index.html']) {
      const reply = await app.inject({ url, headers: { 'accept-language': 'zh-CN,en;q=0.8' } });
      expect(reply.statusCode).toBe(302);
      expect(reply.headers.location).toBe('/docs/getting-started/overview');
    }
    expect((await app.inject('/docs')).headers.location).toBe(
      '/docs/en-US/getting-started/overview'
    );
    const manifest = await app.inject('/manifest.webmanifest');
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    for (const url of ['/', '/console', '/service-worker.js', '/web-version.json'])
      expect((await app.inject(url)).headers['cache-control']).toBe('no-cache');
    const asset = await app.inject('/assets/app-abcdef12.mjs');
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ url: '/assets/app-abcdef12.mjs', method: 'HEAD' })).body).toBe('');
    const cached = await app.inject({
      url: '/assets/app-abcdef12.mjs',
      headers: { 'if-none-match': asset.headers.etag! }
    });
    expect(cached.statusCode).toBe(304);
  });

  it('rejects traversal, hidden files and symlink escapes rather than serving the app', async () => {
    const { app, root, directory } = await fixture();
    await writeFile(join(directory, 'secret'), 'private');
    await writeFile(join(root, '.env'), 'private');
    await symlink(join(directory, 'secret'), join(root, 'assets/escape.txt'));
    for (const url of [
      '/assets/escape.txt',
      '/.env',
      '/assets/%2e%2e/%2e%2e/secret',
      '/assets/%5csecret'
    ]) {
      const reply = await app.inject(url);
      expect(reply.statusCode).toBe(404);
      expect(reply.body).not.toContain('private');
    }
    expect((await app.inject({ url: '/console', method: 'POST' })).statusCode).toBe(404);
  });

  it('does not send partial content for a stale or weak If-Range validator', async () => {
    const { app } = await fixture();
    const url = '/assets/app-abcdef12.mjs';
    const full = await app.inject(url);
    const partial = await app.inject({ url, headers: { range: 'bytes=0-5' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe(full.body.slice(0, 6));
    for (const validator of ['"obsolete"', full.headers.etag!, 'Thu, 01 Jan 1970 00:00:00 GMT']) {
      const reply = await app.inject({
        url,
        headers: { range: 'bytes=0-5', 'if-range': validator }
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(full.body);
    }
    const unchanged = await app.inject({
      url,
      headers: { range: 'bytes=0-5', 'if-range': full.headers['last-modified']! }
    });
    expect(unchanged.statusCode).toBe(206);
    expect(unchanged.body).toBe(full.body.slice(0, 6));
  });

  it('uses weak comparison and wildcard matching for If-None-Match', async () => {
    const { app } = await fixture();
    const url = '/web-version.json';
    const full = await app.inject(url);
    for (const validator of ['*', full.headers.etag!.replace(/^W\//u, '')]) {
      const reply = await app.inject({ url, headers: { 'if-none-match': validator } });
      expect(reply.statusCode).toBe(304);
      expect(reply.body).toBe('');
    }
  });

  it('fails startup on an incomplete production Web distribution', async () => {
    const { app, root } = await fixture();
    await rm(join(root, 'web-version.json'));
    await expect(app.ready()).rejects.toThrow('WEB_DISTRIBUTION_INVALID');
  });
});
