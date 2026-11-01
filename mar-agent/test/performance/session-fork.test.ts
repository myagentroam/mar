import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { stageSessionSegments } from '../../src/session/store/jsonl/history.js';
import type { SessionRecord } from '../../src/session/store/types.js';
import { activeSessionDirectory } from '../support/jsonl-session-path.js';

it('forks a 220 MB history with 413 diff resources within the 15-second request budget', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mar-large-session-fork-'));
  let store = await JsonlSessionStore.open(home);
  try {
    const session = await store.createSession({ workspace: home, title: 'Source' });
    const records = await store.read(session.id);
    await store.close();
    const directory = await activeSessionDirectory(home, session.id);
    await mkdir(join(directory, 'tool_results'));
    const references: string[] = [];
    const text = 'x'.repeat(3090);
    for (let index = 0; index < 67_000; index++) {
      const record: SessionRecord = {
        recordId: randomUUID(),
        sequence: records.length + 1,
        sessionId: session.id,
        timestamp: session.createdAt,
        turnId: 'boundary',
        type: 'benchmark.record',
        payload: { text }
      };
      // Spread resources across the entire history rather than a tiny synthetic prefix.
      if (index % 160 === 0 && references.length < 413) {
        const resourceRef = randomUUID();
        references.push(resourceRef);
        await writeFile(join(directory, 'tool_results', `${resourceRef}.diff`), '+'.repeat(3653));
        record.type = 'tool.completed';
        record.payload = {
          resultExtensions: [
            {
              type: 'file_changes',
              version: 1,
              entries: [
                {
                  changeId: randomUUID(),
                  path: 'file',
                  change: 'modified',
                  additions: 1,
                  deletions: 0,
                  diff: {
                    status: 'available',
                    format: 'unified-diff',
                    resourceRef,
                    byteSize: 3653,
                    sha256: 'a'.repeat(64)
                  }
                }
              ]
            }
          ]
        };
      }
      records.push(record);
    }
    records.push({
      ...records.at(-1)!,
      recordId: randomUUID(),
      sequence: records.length + 1,
      turnId: 'excluded',
      payload: { text: 'Do not retain this tail' }
    });
    const staged = await stageSessionSegments(directory, records, 'fork');
    for (const file of staged.files) await rename(file.temporaryPath, file.path);
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const meta = index.sessions.find((item: { id: string }) => item.id === session.id);
    meta.segments = staged.segments;
    meta.nextSequence = records.length + 1;
    await writeFile(indexPath, JSON.stringify(index));
    const bytes = staged.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    expect(bytes).toBeGreaterThan(215_000_000);
    store = await JsonlSessionStore.open(home);
    const startedAt = performance.now();
    const branch = await store.forkSession(session.id, {
      boundaryTurnId: 'boundary',
      title: 'Branch'
    });
    const durationMs = performance.now() - startedAt;
    console.log(
      JSON.stringify({
        records: records.length,
        bytes,
        resources: references.length,
        durationMs: Math.round(durationMs),
        budgetMs: 15_000
      })
    );
    expect(durationMs).toBeLessThan(15_000);
    const branchDirectory = await activeSessionDirectory(home, branch.id);
    expect(await readdir(join(branchDirectory, 'tool_results'))).toEqual(['index.json']);
    expect((await store.readPage(branch.id, { limit: 1 })).records.at(-1)?.turnId).toBe('boundary');
    await store.delete(session.id);
    expect(
      (await store.readToolResultResource(branch.id, { resourceRef: references[0]! })).content
    ).toBe('+'.repeat(3653));
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
