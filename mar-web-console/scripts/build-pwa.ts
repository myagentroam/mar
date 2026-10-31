import { build } from 'esbuild';
import { injectManifest } from 'workbox-build';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directDownloadServiceWorkerSource } from '@myagentroam/web-core/build/direct-download-service-worker';
import { createThirdPartyNotices } from '@myagentroam/web-core/build/third-party-notices';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const appMetadataPath = resolve(dist, '.mar-pwa-build.json');
const docsMetadataPath = resolve(dist, 'docs/.mar-distribution-modules.json');
const temporaryWorker = resolve(dist, '.mar-pwa-worker.js');
const readMetadata = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as {
    files: string[];
    immutable: string[];
    modules: string[];
  };
const app = readMetadata(appMetadataPath);
const docsModules = JSON.parse(readFileSync(docsMetadataPath, 'utf8')) as string[];
const immutable = new Set(app.immutable);
const version = JSON.parse(readFileSync(resolve(dist, 'web-version.json'), 'utf8')) as {
  hash: string;
  version: string;
};
if (
  typeof version.hash !== 'string' ||
  version.hash.length === 0 ||
  typeof version.version !== 'string' ||
  version.version.length === 0
)
  throw new Error('Missing Web build identity');

const bundled = await build({
  absWorkingDir: root,
  entryPoints: [
    fileURLToPath(import.meta.resolve('@myagentroam/web-core/build/pwa-service-worker'))
  ],
  outfile: temporaryWorker,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  metafile: true,
  define: {
    __MAR_BUILD_ID__: JSON.stringify(version.hash),
    __MAR_BUILD_VERSION__: JSON.stringify(version.version),
    __MAR_IMMUTABLE_URLS__: JSON.stringify([...immutable]),
    'process.env.NODE_ENV': '"production"'
  },
  plugins: [
    {
      name: 'mar-legacy-worker-handlers',
      setup(builder) {
        builder.onResolve({ filter: /^mar-legacy-worker-handlers$/ }, () => ({
          path: 'handlers',
          namespace: 'mar-worker'
        }));
        builder.onLoad({ filter: /.*/, namespace: 'mar-worker' }, () => ({
          contents: directDownloadServiceWorkerSource(false),
          loader: 'js'
        }));
      }
    }
  ]
});
const workerModules = Object.keys(bundled.metafile.inputs)
  .filter((path) => !path.startsWith('mar-worker:'))
  .map((path) => resolve(root, path));
writeFileSync(
  resolve(dist, 'THIRD_PARTY_NOTICES.txt'),
  createThirdPartyNotices([...app.modules, ...docsModules, ...workerModules])
);

const result = await injectManifest({
  swSrc: temporaryWorker,
  swDest: resolve(dist, 'service-worker.js'),
  injectionPoint: '__MAR_PRECACHE_MANIFEST__',
  globDirectory: dist,
  globPatterns: [
    'index.html',
    'manifest.webmanifest',
    'favicon.ico',
    'icons/app-icon-192.png',
    'icons/app-icon-512.png',
    ...app.files.map((file) => file.slice(1))
  ],
  maximumFileSizeToCacheInBytes: Number.MAX_SAFE_INTEGER,
  modifyURLPrefix: { '': '/' },
  manifestTransforms: [
    (entries) => ({
      manifest: entries.map((entry) =>
        immutable.has(entry.url) ? { ...entry, revision: null } : entry
      ),
      warnings: []
    })
  ]
});
if (result.warnings.length > 0) throw new Error(result.warnings.join('\n'));
unlinkSync(temporaryWorker);
unlinkSync(appMetadataPath);
unlinkSync(docsMetadataPath);
console.log(`Prepared ${result.count} static resources (${result.size} bytes)`);
