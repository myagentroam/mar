import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LocalWorkspaceTools } from '../../src/agent-core/tools/local/workspace-tools.js';
import { AsyncQueue } from '../../src/agent-core/runtime/async-queue.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';

const roots: string[] = [];

function percentile(values: number[], ratio: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))]!;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('local runtime performance guardrails', () => {
  it('keeps indexed session listing bounded with 200 sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-performance-session-'));
    roots.push(home);
    await mkdir(join(home, 'workspace'));
    const store = await JsonlSessionStore.open(home);
    try {
      for (let index = 0; index < 200; index++)
        await store.createSession({
          workspace: join(home, 'workspace'),
          title: `Session ${index}`
        });
      await store.list({ limit: 200 });
      const samples: number[] = [];
      for (let index = 0; index < 7; index++) {
        const startedAt = performance.now();
        const result = (await store.list({ limit: 200 })) as { sessions: unknown[] };
        samples.push(performance.now() - startedAt);
        expect(result.sessions).toHaveLength(200);
      }
      expect(percentile(samples, 0.5)).toBeLessThan(25);
      expect(percentile(samples, 0.95)).toBeLessThan(100);
    } finally {
      await store.close();
    }
  });

  it('processes and releases 100000 queued events without quadratic behavior', async () => {
    const samples: number[] = [];
    for (let round = 0; round < 5; round++) {
      const queue = new AsyncQueue<number>();
      const iterator = queue[Symbol.asyncIterator]();
      const startedAt = performance.now();
      for (let index = 0; index < 100_000; index++) queue.push(index);
      queue.close();
      let count = 0;
      for (;;) {
        const item = await iterator.next();
        if (item.done) break;
        count++;
      }
      samples.push(performance.now() - startedAt);
      expect(count).toBe(100_000);
      expect(queue.bufferedSize).toBe(0);
    }
    expect(percentile(samples, 0.5)).toBeLessThan(1_000);
    expect(percentile(samples, 0.95)).toBeLessThan(2_500);
  });

  it('batches index persistence while appending a long execution history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-performance-jsonl-'));
    roots.push(home);
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: home });
      const release = await store.acquireSessionLease(session.id);
      const startedAt = performance.now();
      for (let index = 0; index < 1_000; index++)
        await store.append(session.id, { type: 'tool.updated', payload: { index } });
      await release();
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect((await store.readPage(session.id, { limit: 10 })).records).toHaveLength(10);
    } finally {
      await store.close();
    }
  });

  it('backfills a large legacy preview with linear buffer copying', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-performance-preview-'));
    roots.push(home);
    let store = await JsonlSessionStore.open(home);
    const prompt = '界'.repeat(700_000);
    const session = await store.createSession({ workspace: home });
    await store.append(session.id, { type: 'turn.user', payload: { prompt } });
    await store.close();
    const indexPath = join(home, '.mar', 'agent', 'sessions', 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.sessions[0].resume.firstUserMessageIndexed;
    delete index.sessions[0].resume.firstUserMessagePreview;
    await writeFile(indexPath, JSON.stringify(index));
    store = await JsonlSessionStore.open(home);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      expect(await store.firstUserMessagePreview(session.id)).toBe(prompt.slice(0, 160));
      const copiedBytes = concat.mock.calls.reduce(
        (total, [parts]) => total + parts.reduce((bytes, part) => bytes + part.byteLength, 0),
        0
      );
      expect(copiedBytes).toBeLessThan(Buffer.byteLength(prompt) * 3);
    } finally {
      concat.mockRestore();
      await store.close();
    }
  });

  it('assembles a large tail record without quadratic fragment shifts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-performance-tail-fragments-'));
    roots.push(home);
    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace: home });
    const text = '界'.repeat(700_000);
    await store.append(session.id, { type: 'large.record', payload: { text } });
    let shiftedFragments = 0;
    const unshift = Array.prototype.unshift;
    const shifts = vi.spyOn(Array.prototype, 'unshift').mockImplementation(function (
      this: unknown[],
      ...items: unknown[]
    ) {
      if (items.every(Buffer.isBuffer) && this.every(Buffer.isBuffer))
        shiftedFragments += this.length;
      return unshift.apply(this, items);
    });
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const page = await store.readPage(session.id, { limit: 1 });
      expect(page.records[0]?.payload).toEqual({ text });
      const assembledFragments = concat.mock.calls.reduce(
        (total, [parts]) => total + parts.length,
        0
      );
      expect(shiftedFragments).toBeLessThanOrEqual(assembledFragments * 2);
      expect(page.previousBeforeSequence).toBe(2);
    } finally {
      shifts.mockRestore();
      concat.mockRestore();
      await store.close();
    }
  });

  it('pages a large JSONL tail without repeatedly parsing the full segment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-performance-jsonl-page-'));
    roots.push(home);
    const store = await JsonlSessionStore.open(home);
    try {
      const session = await store.createSession({ workspace: home });
      await store.append(session.id, {
        type: 'large.old.record',
        payload: { text: 'x'.repeat(12 * 1024 * 1024) }
      });
      for (let index = 0; index < 2_000; index++)
        await store.append(session.id, { type: 'tail.record', payload: { index } });
      await store.readPage(session.id, { limit: 30 });

      const samples: number[] = [];
      for (let index = 0; index < 10; index++) {
        const startedAt = performance.now();
        const page = await store.readPage(session.id, { limit: 30 });
        samples.push(performance.now() - startedAt);
        expect(page.records).toHaveLength(30);
      }
      expect(percentile(samples, 0.5)).toBeLessThan(25);
      expect(percentile(samples, 0.95)).toBeLessThan(100);
    } finally {
      await store.close();
    }
  });

  it('returns immediately when a short process exits before its yield deadline', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-performance-exec-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    try {
      const startedAt = performance.now();
      const result = await tools.exec({
        action: 'start',
        command: `${process.execPath} -e "process.stdout.write('ok')"`,
        yieldMs: 5_000
      });
      expect(result).toMatchObject({ status: 'completed', stdout: 'ok', exitCode: 0 });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await tools.dispose();
    }
  });

  it('collects many small process writes without quadratic string rebuilding', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-performance-exec-output-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    try {
      const startedAt = performance.now();
      const result = await tools.exec({
        action: 'start',
        command: `${process.execPath} -e "for(let i=0;i<50000;i++)process.stdout.write('x')"`,
        yieldMs: 5_000
      });
      expect(result).toMatchObject({
        status: 'completed',
        stdoutBytes: 50_000,
        stdoutDroppedBytes: 0,
        truncated: false
      });
      expect(result.stdout).toHaveLength(50_000);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await tools.dispose();
    }
  });

  it('reads a bounded range from a large file without whole-file rejection', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-performance-read-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    await writeFile(join(workspace, 'large.log'), 'line\n'.repeat(2_000_000));
    const samples: number[] = [];
    try {
      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await tools.read({
          reads: [{ path: 'large.log', offset: 2, limit: 2 }]
        });
        samples.push(performance.now() - startedAt);
        expect(result.results[0]).toMatchObject({
          content: '2\tline\n3\tline',
          truncated: true,
          nextOffset: 4
        });
      }
      expect(percentile(samples, 0.5)).toBeLessThan(100);
      expect(percentile(samples, 0.95)).toBeLessThan(500);
    } finally {
      await tools.dispose();
    }
  });

  it('reads sixteen known files through one bounded batch execution', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-performance-batch-read-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    const reads = Array.from({ length: TOOL_EXECUTION_LIMITS.readMaxBatchItems }, (_, index) => ({
      path: `file-${index}.txt`,
      offset: 1,
      limit: 20
    }));
    await Promise.all(
      reads.map((item, index) => writeFile(join(workspace, item.path), `value-${index}\n`))
    );
    const samples: number[] = [];
    try {
      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await tools.read({ reads });
        samples.push(performance.now() - startedAt);
        expect(result.results).toHaveLength(TOOL_EXECUTION_LIMITS.readMaxBatchItems);
        expect(result.results[15]).toMatchObject({ path: 'file-15.txt', content: '1\tvalue-15' });
      }
      expect(percentile(samples, 0.5)).toBeLessThan(100);
      expect(percentile(samples, 0.95)).toBeLessThan(500);
    } finally {
      await tools.dispose();
    }
  });

  it('preflights and atomically commits a fifty-file patch within a bounded duration', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-performance-patch-'));
    roots.push(workspace);
    const tools = new LocalWorkspaceTools(workspace);
    const operations = Array.from(
      { length: 50 },
      (_, index) => `*** Add File: generated/file-${index}.txt\n+value-${index}`
    ).join('\n');
    const startedAt = performance.now();
    const result = await tools.applyPatch(`*** Begin Patch\n${operations}\n*** End Patch`);
    expect(result.totals).toEqual({ files: 50, addedLines: 50, deletedLines: 0 });
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });
});
