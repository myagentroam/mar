import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { fileContentType, parseHttpByteRange } from './file-content-stream.js';
import { sendError } from './http-errors.js';

const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

async function distributionFile(root: string, path: string) {
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) return undefined;
  try {
    const actual = await realpath(candidate);
    if (!inside(root, actual)) return undefined;
    const metadata = await stat(actual);
    return metadata.isFile() ? { path: actual, metadata } : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Serves only the immutable distribution, never Node or Server runtime directories. */
export function registerWebStaticRoutes(app: FastifyInstance, directory: string): void {
  let root: string;
  app.addHook('onReady', async () => {
    try {
      root = await realpath(directory);
      for (const path of [
        'index.html',
        'web-version.json',
        'manifest.webmanifest',
        'service-worker.js'
      ])
        if ((await distributionFile(root, path)) === undefined) throw new Error();
      if (!(await stat(resolve(root, 'docs'))).isDirectory()) throw new Error();
    } catch {
      throw new Error('WEB_DISTRIBUTION_INVALID');
    }
  });

  app.get('/*', async (request, reply) => {
    let path: string;
    try {
      path = decodeURIComponent(request.url.split('?')[0]!);
    } catch {
      return sendError(reply, 404, 'ROUTE_NOT_FOUND');
    }
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => part.startsWith('.')) ||
      path === '/api' ||
      path.startsWith('/api/') ||
      extname(path) === '.map'
    )
      return sendError(reply, 404, 'ROUTE_NOT_FOUND');

    if (['/docs', '/docs/', '/docs/index.html'].includes(path)) {
      const chinese = /^\s*zh/iu.test(String(request.headers['accept-language'] ?? ''));
      return reply.redirect(
        chinese ? '/docs/getting-started/overview' : '/docs/en-US/getting-started/overview'
      );
    }

    const name = path.slice(1);
    let file = await distributionFile(root, name);
    if (file === undefined && path.startsWith('/docs/')) {
      file =
        (await distributionFile(root, `${name}.html`)) ??
        (await distributionFile(root, `${name.replace(/\/$/u, '')}/index.html`));
    } else if (
      file === undefined &&
      (path === '/' ||
        path === '/console' ||
        (path.startsWith('/console/') && extname(path) === '') ||
        /^[/]share[/][A-Za-z0-9_-]{1,128}$/u.test(path))
    ) {
      file = await distributionFile(root, 'index.html');
    }
    if (file === undefined) return sendError(reply, 404, 'ROUTE_NOT_FOUND');

    const etag = `W/"${file.metadata.size.toString(16)}-${Math.trunc(file.metadata.mtimeMs).toString(16)}"`;
    const lastModified = file.metadata.mtime.toUTCString();
    const immutable = path.startsWith('/assets/') && /[-.][\w-]{8}\.[a-z0-9]+$/iu.test(path);
    reply
      .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('etag', etag)
      .header('last-modified', lastModified)
      .header('x-content-type-options', 'nosniff')
      .type(WEB_CONTENT_TYPES[extname(file.path)] ?? fileContentType(file.path));
    if (
      String(request.headers['if-none-match'] ?? '')
        .split(/\s*,\s*/u)
        .some((value) => value === '*' || value.replace(/^W\//u, '') === etag.slice(2))
    )
      return reply.code(304).send();

    const validator = request.headers['if-range'];
    const range = parseHttpByteRange(
      validator === undefined || validator === lastModified ? request.headers.range : undefined,
      file.metadata.size
    );
    if (range === null)
      return reply.code(416).header('content-range', `bytes */${file.metadata.size}`).send();
    reply.header('accept-ranges', 'bytes');
    if (range !== undefined) {
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${file.metadata.size}`)
        .header('content-length', range.end - range.start + 1);
    } else reply.header('content-length', file.metadata.size);
    return reply.send(createReadStream(file.path, range ?? {}));
  });
}
