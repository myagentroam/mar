import { JsonlSessionStore } from '../../src/session/store/jsonl/jsonl-store.js';

const [home, parentId, rootId] = process.argv.slice(2) as [string, string, string];
const store = await JsonlSessionStore.open(home);
try {
  const child = await store.createSession({
    workspace: home,
    source: {
      type: 'subagent',
      parentSessionId: parentId,
      rootSessionId: rootId,
      parentExecutionId: 'execution',
      role: 'explore',
      description: 'child'
    }
  });
  process.stdout.write(JSON.stringify({ id: child.id }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: (error as { code?: string }).code }));
} finally {
  await store.close();
}
