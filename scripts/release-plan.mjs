import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePlan } from './release-version-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.stdout.write(`${JSON.stringify(await releasePlan(root), null, 2)}\n`);
