import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSessionReadPin } from '../../src/session/store/jsonl/read-pins.js';

const root = process.argv[2]!;
await withSessionReadPin(root, async () => {
  const selected = join(root, 'v2', process.argv[3] ?? 'old', 'events-000001.jsonl');
  process.send?.('selected');
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
  process.send?.(await readFile(selected, 'utf8'));
});
process.disconnect?.();
