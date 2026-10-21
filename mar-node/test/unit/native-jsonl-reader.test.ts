import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  forEachJsonlRecord,
  mapConcurrent,
  readJsonlBackwardWindow,
  readJsonlWindow
} from '../../src/native-jsonl-reader.js';

describe('Shared native JSONL reader', () => {
  it('keeps consecutive head/tail windows free of inserted newlines and isolates incomplete records in truncated windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-jsonl-window-'));
    const path = join(directory, 'history.jsonl');
    try {
      const content = `${JSON.stringify({ id: 1, text: '中文' })}\n${JSON.stringify({ id: 2, text: 'second' })}`;
      await writeFile(path, content);
      const splitInsideUtf8 = Buffer.from(content).indexOf(Buffer.from('中')) + 1;
      await expect(
        readJsonlWindow(path, {
          headBytes: splitInsideUtf8,
          tailBytes: Buffer.byteLength(content) - splitInsideUtf8
        })
      ).resolves.toMatchObject({
        content,
        truncated: false
      });
      const truncated = await readJsonlWindow(path, { headBytes: 8, tailBytes: 8 });
      const records: Record<string, unknown>[] = [];
      forEachJsonlRecord(truncated?.content ?? '', (record) => records.push(record));
      expect(truncated?.truncated).toBe(true);
      expect(records).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('skips corrupt records line by line while bounded concurrency preserves input order', async () => {
    const records: Record<string, unknown>[] = [];
    forEachJsonlRecord('{"id":1}\nbroken\n{"id":2}', (record) => records.push(record));
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    let active = 0;
    let peak = 0;
    const values = await mapConcurrent([30, 5, 20, 1], 2, async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });
    expect(peak).toBe(2);
    expect(values).toEqual([0, 1, 2, 3]);
  });

  it('reads complete JSONL backward by byte cursor without duplicating or skipping boundary records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-jsonl-cursor-'));
    const path = join(directory, 'history.jsonl');
    try {
      await writeFile(
        path,
        Array.from({ length: 12 }, (_, id) => JSON.stringify({ id, text: `record-${id}` })).join(
          '\n'
        )
      );
      const ids: number[] = [];
      let end: number | undefined;
      let pageSnapshotEnd: number | undefined;
      let pageAnchor: string | undefined;
      let pageAnchorBytes: number | undefined;
      let pages = 0;
      do {
        const page = await readJsonlBackwardWindow(path, {
          headBytes: 0,
          targetLines: 3,
          maxBytes: 80,
          ...(end === undefined
            ? {}
            : {
                page: {
                  snapshotEnd: pageSnapshotEnd!,
                  nextEnd: end,
                  fileAnchor: pageAnchor!,
                  anchorBytes: pageAnchorBytes!
                }
              })
        });
        expect(page).toBeDefined();
        const pageIds: number[] = [];
        forEachJsonlRecord(page?.content ?? '', (record) => pageIds.push(Number(record.id)));
        ids.unshift(...pageIds);
        pageSnapshotEnd ??= page?.snapshotEnd;
        pageAnchor ??= page?.fileAnchor;
        pageAnchorBytes ??= page?.anchorBytes;
        if (pages === 0)
          await appendFile(
            path,
            `\n${JSON.stringify({ id: 12, text: 'live-append-12' })}\n${JSON.stringify({ id: 13, text: 'live-append-13' })}`
          );
        end = page?.truncated === true ? page.start : undefined;
        pages += 1;
      } while (end !== undefined);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toEqual(Array.from({ length: 12 }, (_, id) => id));
      const latest = await readJsonlBackwardWindow(path, {
        headBytes: 0,
        targetLines: 2,
        maxBytes: 80
      });
      const latestIds: number[] = [];
      forEachJsonlRecord(latest?.pageContent ?? '', (record) => latestIds.push(Number(record.id)));
      expect(latestIds).toEqual([12, 13]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
