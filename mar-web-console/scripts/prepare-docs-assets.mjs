import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDirectory = resolve(webRoot, 'docs/public');
mkdirSync(targetDirectory, { recursive: true });
copyFileSync(
  resolve(webRoot, '../packages/web-core/src/assets/logo-icon.png'),
  resolve(targetDirectory, 'logo.png')
);
