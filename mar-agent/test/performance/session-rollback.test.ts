import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SessionRecordInput } from '../../src/session/store/types.js';
import { segmentedSession } from '../support/segmented-session.js';

const profile = vi.hoisted(() => ({ fullRewrite: false, writtenBytes: 0 }));
vi.mock('../../src/session/store/jsonl/history.js', async (original) => {
  const history = await original<typeof import('../../src/session/store/jsonl/history.js')>();
  return {
    ...history,
    stageRollbackSegments: async (...args: Parameters<typeof history.stageRollbackSegments>) =>
      profile.fullRewrite
        ? {
            ...(await history.stageSessionSegments(
              args[0],
              args[1].filter((record) => record.type !== 'responses.continuation')
            )),
            reused: new Set<string>()
          }
        : history.stageRollbackSegments(...args)
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!String(args[0]).endsWith('.rollback-tmp')) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile')
            return (...input: Parameters<typeof handle.writeFile>) => {
              profile.writtenBytes += Buffer.byteLength(input[0] as string);
              return target.writeFile(...input);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
});

async function measure(keep: number, fullRewrite = false) {
  const groups: SessionRecordInput[][] = Array.from({ length: 14 }, () => []);
  const resources: Array<{ resourceRef: string; index: number }> = [];
  const text = 'x'.repeat(3090);
  for (let index = 0; index < 67_000; index++) {
    const turnId = index < keep ? 'keep' : 'drop';
    const input: SessionRecordInput =
      index === 0 || index === keep
        ? { type: 'turn.user', turnId, payload: { prompt: turnId } }
        : { type: 'test.record', turnId, payload: { text } };
    if (index === 25_001) {
      input.type = 'responses.continuation';
      input.payload = { responseId: 'stale-response' };
    }
    if (index > 0 && index % 160 === 0 && resources.length < 413) {
      const resourceRef = randomUUID();
      resources.push({ resourceRef, index });
      input.type = 'tool.completed';
      input.payload = {
        text,
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
                  byteSize: 8,
                  sha256: 'a'.repeat(64)
                }
              }
            ]
          }
        ]
      };
    }
    groups[Math.floor(index / 5000)]!.push(input);
  }
  const { home, store, session, directory, records, segments } = await segmentedSession(groups);
  try {
    const folder = join(directory, 'tool_results');
    await mkdir(folder);
    for (let offset = 0; offset < resources.length; offset += 8)
      await Promise.all(
        resources.slice(offset, offset + 8).map(async ({ resourceRef, index }) => {
          const owner = records[index + 1]!;
          await writeFile(join(folder, `${resourceRef}.diff`), '+change\n');
          await writeFile(
            join(folder, `${resourceRef}.json`),
            JSON.stringify({ sequence: owner.sequence, recordId: owner.recordId })
          );
        })
      );
    profile.fullRewrite = fullRewrite;
    profile.writtenBytes = 0;
    const started = performance.now();
    await store.rollbackSession(session.id, { boundaryTurnId: 'keep' });
    const durationMs = Math.round(performance.now() - started);
    const writtenBytes = profile.writtenBytes;
    const totalBytes = segments.reduce((total, segment) => total + segment.bytes, 0);
    const retained = records
      .slice(0, keep + 1)
      .filter((record) => record.type !== 'responses.continuation');
    expect(await store.read(session.id)).toEqual(retained);
    const remainingResources = resources.filter((resource) => resource.index < keep);
    expect(await readdir(folder)).toHaveLength(remainingResources.length * 2);
    const removed = resources.find((resource) => resource.index >= keep);
    if (removed)
      await expect(
        store.readToolResultResource(session.id, { resourceRef: removed.resourceRef })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_RESOURCE_NOT_FOUND' });
    if (remainingResources[0])
      expect(
        (
          await store.readToolResultResource(session.id, {
            resourceRef: remainingResources[0].resourceRef
          })
        ).content
      ).toBe('+change\n');
    expect(durationMs).toBeLessThan(15_000);
    expect(totalBytes).toBeGreaterThan(220_000_000);
    const sample = {
      keep,
      fullRewrite,
      totalBytes,
      writtenBytes,
      durationMs,
      resources: resources.length
    };
    console.log(JSON.stringify(sample));
    return sample;
  } finally {
    profile.fullRewrite = false;
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}

it('avoids rewriting an unchanged 220 MB prefix when rolling back near the tail', async () => {
  const baseline = await measure(66_000, true);
  const optimized = await measure(66_000);
  expect(baseline.writtenBytes).toBeGreaterThan(200_000_000);
  expect(optimized.writtenBytes).toBeLessThan(baseline.writtenBytes / 5);
}, 60_000);

it.each([33_000, 1])(
  'rolls back a 220 MB history and retires removed resources within 15 seconds (keep=%s)',
  async (keep) => {
    await measure(keep);
  },
  60_000
);
