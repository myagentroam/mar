import { resolve } from 'node:path';
import { verifyUnifiedCommonIntegration } from './common-candidate-integration.mjs';

const root = resolve(import.meta.dirname, '..');
const [manifestPath, output] = process.argv.slice(2);
if (!manifestPath) throw new Error('RELEASE_MANIFEST_ARGUMENTS_REQUIRED');

await verifyUnifiedCommonIntegration(
  resolve(manifestPath),
  output === undefined ? undefined : resolve(output),
  root
);
