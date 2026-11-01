import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { SessionRecord, SessionRecordInput } from '../../src/session/store/types.js';
import { activeSessionDirectory } from './jsonl-session-path.js';

/** Build physical boundaries without forcing every test to append megabytes of history. */
export async function segmentedSession(groups: readonly (readonly SessionRecordInput[])[]) {
  const home = await mkdtemp(join(tmpdir(), 'mar-segmented-session-'));
  let store = await JsonlSessionStore.open(home);
  try {
    const session = await store.createSession({ workspace: home, title: 'Source' });
    const [created] = await store.read(session.id);
    await store.close();
    const directory = await activeSessionDirectory(home, session.id);
    const records: SessionRecord[] = [];
    const segments = [];
    for (const [index, group] of groups.entries()) {
      const firstSequence = records.length + 1;
      if (index === 0) records.push(created!);
      for (const input of group)
        records.push({
          ...input,
          recordId: randomUUID(),
          sessionId: session.id,
          sequence: records.length + 1,
          timestamp: session.createdAt
        });
      const text = records
        .slice(firstSequence - 1)
        .map((record) => JSON.stringify(record) + '\n')
        .join('');
      const number = index + 1;
      await writeFile(join(directory, `events-${String(number).padStart(6, '0')}.jsonl`), text);
      segments.push({
        number,
        firstSequence,
        lastSequence: records.length,
        bytes: Buffer.byteLength(text)
      });
    }
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const meta = index.sessions.find((item: { id: string }) => item.id === session.id);
    meta.segments = segments;
    meta.nextSequence = records.length + 1;
    await writeFile(indexPath, JSON.stringify(index));
    store = await JsonlSessionStore.open(home);
    return { home, store, session, directory, records, segments, indexPath };
  } catch (error) {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
