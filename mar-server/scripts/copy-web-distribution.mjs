import { cp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const server = resolve(import.meta.dirname, '..');
const source = resolve(server, '../mar-web-console/dist');
const target = resolve(server, 'web');
const packageJson = JSON.parse(await readFile(resolve(server, 'package.json'), 'utf8'));
const webVersion = JSON.parse(await readFile(resolve(source, 'web-version.json'), 'utf8'));
if (webVersion.version !== packageJson.version)
  throw new Error('WEB_DISTRIBUTION_VERSION_MISMATCH');
for (const path of [
  'index.html',
  'service-worker.js',
  'manifest.webmanifest',
  'THIRD_PARTY_NOTICES.txt'
])
  if (!(await stat(resolve(source, path))).isFile()) throw new Error('WEB_DISTRIBUTION_INVALID');
if (!(await stat(resolve(source, 'docs'))).isDirectory())
  throw new Error('WEB_DISTRIBUTION_INVALID');
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
