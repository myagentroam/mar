import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

const [home, parentId] = process.argv.slice(2) as [string, string];
const store = await JsonlSessionStore.open(home);
try {
  const result = await store.delete(parentId);
  process.stdout.write(JSON.stringify(result));
} finally {
  await store.close();
}
