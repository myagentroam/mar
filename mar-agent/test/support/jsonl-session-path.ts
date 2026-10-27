import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Locate the single active physical generation for a test-created Session. */
export async function activeSessionDirectory(home: string, id: string): Promise<string> {
  const root = join(home, '.mar', 'agent', 'sessions');
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as {
    sessions: Array<{ id: string; storage?: { encoding: number; generation?: string } }>;
  };
  const session = index.sessions.find((entry) => entry.id === id);
  if (!session) throw new Error('Session missing from fixture index');
  return session.storage?.encoding === 2
    ? join(root, id, 'v2', session.storage.generation!)
    : join(root, id);
}
