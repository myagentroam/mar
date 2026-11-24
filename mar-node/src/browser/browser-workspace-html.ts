import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { BROWSER_WORKSPACE_PREVIEW_SUFFIX } from '@myagentroam/protocol';
import type { Page } from 'playwright';
import {
  resolveRegisteredWorkspaceRoot,
  resolveWorkspaceEntryMetadata
} from '../workspace/path-access.js';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg'
};

function safePath(path: string): boolean {
  return (
    !/[\\\0]/u.test(path) &&
    !path
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part === '.git' || /^[a-z]:/iu.test(part)
      )
  );
}

/** Projects one saved Workspace document and its relative resources inside an owned Chromium tab.
 * There is no listening origin or transferable grant; only this page handles the private origin. */
export async function openBrowserWorkspaceHtml(
  page: Page,
  workspaceRoot: () => string | undefined,
  path: string
): Promise<void> {
  const workspace = workspaceRoot();
  if (!workspace || !safePath(path) || !/\.html?$/iu.test(path))
    throw new Error('BROWSER_HTML_UNAVAILABLE');
  const root = await resolveRegisteredWorkspaceRoot(workspace);
  const directory = posix.dirname(path);
  const resolveDirectory = async () => {
    if (directory === '.') return root;
    const entry = await resolveWorkspaceEntryMetadata(root, directory);
    if (!entry.metadata.isDirectory()) throw new Error('BROWSER_HTML_UNAVAILABLE');
    return entry.path;
  };
  const base = await resolveDirectory();
  const name = posix.basename(path);
  const origin = `https://${randomUUID()}${BROWSER_WORKSPACE_PREVIEW_SUFFIX}`;
  await page.route(
    (url) => url.origin === origin,
    async (route) => {
      const method = route.request().method();
      if ((method !== 'GET' && method !== 'HEAD') || workspaceRoot() !== workspace) {
        await route.fulfill({
          status: 403,
          contentType: 'text/plain',
          body: 'Workspace preview is unavailable.'
        });
        return;
      }
      let resource;
      let entry;
      try {
        resource = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
        if (!safePath(resource) || (await resolveDirectory()) !== base)
          throw new Error('BROWSER_HTML_UNAVAILABLE');
        entry = await resolveWorkspaceEntryMetadata(base, resource);
        if (!entry.metadata.isFile() || entry.metadata.size > 32 * 1024 * 1024)
          throw new Error('BROWSER_HTML_UNAVAILABLE');
      } catch {
        await route.fulfill({
          status: 404,
          contentType: 'text/plain',
          body: 'Workspace file not found.'
        });
        return;
      }
      if (workspaceRoot() !== workspace) {
        await route.fulfill({
          status: 403,
          contentType: 'text/plain',
          body: 'Workspace preview is unavailable.'
        });
        return;
      }
      const contentType =
        types[posix.extname(resource).toLowerCase()] ?? 'application/octet-stream';
      await route.fulfill({
        ...(method === 'HEAD' ? {} : { path: entry.path }),
        contentType,
        headers: {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          ...(/^(?:text\/html|image\/svg\+xml)/u.test(contentType)
            ? {
                'content-security-policy':
                  "base-uri 'none'; worker-src 'none'; object-src 'none'; frame-ancestors 'none'"
              }
            : {})
        }
      });
    }
  );
  const response = await page.goto(`${origin}/${encodeURIComponent(name)}`, {
    waitUntil: 'commit'
  });
  if (!response?.ok()) throw new Error('BROWSER_HTML_UNAVAILABLE');
}
