import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

const productRoot = resolve(import.meta.dirname, '../../..');
const privateUserFilePath = '/api/nodes/pwa-fixture/workspaces/pwa-fixture/files/private.txt';
const privateUserFileBody = 'PWA_PRIVATE_USER_FILE_SENTINEL';

export interface PwaOfflineFixture {
  readonly artifactRoot: string;
  readonly buildVersion: string;
  readonly buildId: string;
  readonly origin: string;
  readonly scriptAssets: readonly { readonly path: string; readonly size: number }[];
  readonly current: PwaArtifactRelease;
  readonly previous?: PwaArtifactRelease;
  readonly requests: string[];
  readonly failedRequests: string[];
  setRelease(release: 'current' | 'previous'): void;
  blockPath(path: string | undefined): void;
  close(): Promise<void>;
}

export interface PwaArtifactRelease {
  readonly artifactRoot: string;
  readonly buildVersion: string;
  readonly buildId: string;
  readonly scriptAssets: readonly { readonly path: string; readonly size: number }[];
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8'
  });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.webp':
      return 'image/webp';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function staticFile(artifactRoot: string, pathname: string): Promise<string | undefined> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  if (decodedPath === '/console' || decodedPath.startsWith('/console/')) {
    return join(artifactRoot, 'index.html');
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  const candidate = resolve(artifactRoot, relativePath);
  if (!isWithin(artifactRoot, candidate)) return undefined;

  const candidates =
    decodedPath.startsWith('/docs/') && extname(candidate) === ''
      ? [
          decodedPath.endsWith('/') ? join(candidate, 'index.html') : `${candidate}.html`,
          join(candidate, 'index.html')
        ]
      : [candidate];

  for (const file of candidates) {
    if (!isWithin(artifactRoot, file)) continue;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Try the next clean-URL candidate.
    }
  }
  return undefined;
}

async function listScriptAssets(artifactRoot: string) {
  const assetsRoot = join(artifactRoot, 'assets');
  const assets: { path: string; size: number }[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file);
          return;
        }
        if (!entry.isFile() || !/\.m?js$/u.test(entry.name)) return;
        const metadata = await stat(file);
        assets.push({
          path: `/${relative(artifactRoot, file).split(sep).join('/')}`,
          size: metadata.size
        });
      })
    );
  }

  await visit(assetsRoot);
  return assets.sort((left, right) => right.size - left.size);
}

async function snapshotArtifact(
  artifactInput: string | undefined,
  suffix: string
): Promise<{ artifactRoot: string; snapshotRoot: string }> {
  const runId = process.env.MAR_TEST_RUN_ID?.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (!runId) throw new Error('MAR_TEST_RUN_ID is required for the isolated PWA fixture.');

  const source = artifactInput?.trim()
    ? resolve(productRoot, artifactInput.trim())
    : resolve(productRoot, 'mar-web-console/dist');
  const runsRoot = resolve(productRoot, 'test/runs');
  const snapshotRoot = join(runsRoot, `pwa-offline-artifact-${runId}-${suffix}`);
  await mkdir(runsRoot, { recursive: true });
  try {
    await lstat(snapshotRoot);
    throw new Error(`PWA snapshot already exists: ${snapshotRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryRoot = await mkdtemp(join(runsRoot, `.pwa-offline-${runId}-`));
  const stagedArtifact = join(temporaryRoot, 'artifact');
  try {
    await cp(source, stagedArtifact, { recursive: true, errorOnExist: true, force: false });
    for (const requiredPath of [
      'index.html',
      'service-worker.js',
      'web-version.json',
      'docs/getting-started/overview.html',
      'docs/en-US/getting-started/overview.html'
    ]) {
      if (!(await stat(join(stagedArtifact, requiredPath))).isFile()) {
        throw new Error(`PWA artifact is missing required file: ${requiredPath}`);
      }
    }
    await rename(stagedArtifact, snapshotRoot);
    return { artifactRoot: snapshotRoot, snapshotRoot };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function loadRelease(artifactInput: string | undefined, suffix: string) {
  const { artifactRoot, snapshotRoot } = await snapshotArtifact(artifactInput, suffix);
  try {
    const identity = JSON.parse(await readFile(join(artifactRoot, 'web-version.json'), 'utf8')) as {
      version?: unknown;
      hash?: unknown;
    };
    if (typeof identity.version !== 'string' || typeof identity.hash !== 'string') {
      throw new Error(`PWA artifact ${suffix} has no version/hash identity.`);
    }
    return {
      artifactRoot,
      buildVersion: identity.version,
      buildId: identity.hash,
      scriptAssets: await listScriptAssets(artifactRoot),
      snapshotRoot
    };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  activeArtifactRoot: () => string,
  blockedPath: () => string | undefined,
  requests: string[],
  failedRequests: string[]
): void {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }
  requests.push(url.pathname);

  if (url.pathname === blockedPath()) {
    failedRequests.push(url.pathname);
    sendText(response, 503, 'Fixture blocked this PWA install resource.');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === privateUserFilePath) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(privateUserFileBody);
      return;
    }
    if (url.pathname === '/api/pwa-fixture/profile') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end('{"fixture":"private-api-response"}');
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"error":{"code":"PWA_FIXTURE_NO_API","message":"No API fixture"}}');
    return;
  }

  void staticFile(activeArtifactRoot(), url.pathname).then(async (file) => {
    if (!file) {
      sendText(response, 404, 'Not Found');
      return;
    }
    try {
      const metadata = await stat(file);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': metadata.size,
        'content-type': contentType(file),
        ...(url.pathname === '/service-worker.js' ? { 'service-worker-allowed': '/' } : {})
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(file)
        .on('error', () => response.destroy())
        .pipe(response);
    } catch {
      sendText(response, 404, 'Not Found');
    }
  });
}

export async function startPwaOfflineFixture(options: {
  readonly suffix: string;
  readonly includePrevious?: boolean;
}): Promise<PwaOfflineFixture> {
  const previousInput = process.env.MAR_PWA_PREVIOUS_ARTIFACT_DIR?.trim();
  if (options.includePrevious === true && !previousInput) {
    throw new Error('MAR_PWA_PREVIOUS_ARTIFACT_DIR is required for PWA version lifecycle tests.');
  }
  const current = await loadRelease(process.env.MAR_PWA_ARTIFACT_DIR, `${options.suffix}-current`);
  let previous: Awaited<ReturnType<typeof loadRelease>> | undefined;
  try {
    previous =
      options.includePrevious === true
        ? await loadRelease(previousInput, `${options.suffix}-previous`)
        : undefined;
  } catch (error) {
    await rm(current.snapshotRoot, { recursive: true, force: true });
    throw error;
  }
  if (previous !== undefined && previous.buildId === current.buildId) {
    await rm(current.snapshotRoot, { recursive: true, force: true });
    await rm(previous.snapshotRoot, { recursive: true, force: true });
    throw new Error('PWA version lifecycle requires two distinct artifact build identities.');
  }

  const releases = new Map<'current' | 'previous', typeof current>([['current', current]]);
  if (previous !== undefined) releases.set('previous', previous);
  let activeRelease: 'current' | 'previous' =
    options.includePrevious === true ? 'previous' : 'current';
  let blockedResource: string | undefined;
  const requests: string[] = [];
  const failedRequests: string[] = [];
  const server = createServer((request, response) => {
    respond(
      request,
      response,
      () => releases.get(activeRelease)!.artifactRoot,
      () => blockedResource,
      requests,
      failedRequests
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  }).catch(async (error: unknown) => {
    await Promise.all(
      [...releases.values()].map((release) =>
        rm(release.snapshotRoot, { recursive: true, force: true })
      )
    );
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    await Promise.all(
      [...releases.values()].map((release) =>
        rm(release.snapshotRoot, { recursive: true, force: true })
      )
    );
    throw new Error('PWA fixture listener did not receive an isolated TCP port.');
  }

  return {
    artifactRoot: current.artifactRoot,
    buildVersion: current.buildVersion,
    buildId: current.buildId,
    origin: `http://127.0.0.1:${address.port}`,
    scriptAssets: current.scriptAssets,
    current,
    ...(previous === undefined ? {} : { previous }),
    requests,
    failedRequests,
    setRelease(release) {
      if (!releases.has(release)) throw new Error(`PWA fixture has no ${release} artifact.`);
      activeRelease = release;
    },
    blockPath(path) {
      blockedResource = path;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await Promise.all(
        [...releases.values()].map((release) =>
          rm(release.snapshotRoot, { recursive: true, force: true })
        )
      );
    }
  };
}

export const pwaFixturePrivateUserFile = {
  path: privateUserFilePath,
  body: privateUserFileBody
} as const;
