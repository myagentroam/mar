import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncQueue } from '../../src/agent-core/runtime/async-queue.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { LocalWorkspaceTools } from '../../src/agent-core/tools/local/workspace-tools.js';
import { TOOL_EXECUTION_LIMITS } from '../../src/agent-core/tools/execution-limits.js';
import { residencyFixture } from '../support/subagent-residency.js';

function collectHeap() {
  if (typeof globalThis.gc !== 'function') throw new Error('MAR_AGENT_MEMORY_TEST_REQUIRES_GC');
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

describe('resource growth guardrails', () => {
  it('releases consumed durable subagent bodies while retaining recent results', async () => {
    const sample = async (bytes: number) => {
      const f = await residencyFixture(bytes);
      try {
        let oldest = '';
        let recent: string[] = [];
        const samples: number[] = [];
        for (let round = 0; round < 6; round++) {
          await f.begin();
          recent = [];
          for (let i = 0; i < 16; i++) {
            const { agentId } = await f.controller.run({
              description: 'inspect',
              prompt: 'inspect',
              role: 'explore',
              background: false
            });
            oldest ||= agentId;
            recent.push(agentId);
          }
          for (const update of f.controller.collectModelUpdates()) update.acknowledge();
          await f.controller.prepareSessionResources();
          samples.push(collectHeap());
        }
        for (const id of recent)
          expect((await f.controller.inspect(id)).summary).toHaveLength(bytes * 2);
        expect(f.loads.size).toBe(0);
        const summary = (await f.controller.inspect(oldest)).summary;
        expect(summary).toHaveLength(bytes * 2);
        expect(f.controller.collectModelUpdates()).toEqual([]);
        return {
          samples,
          growth: Math.max(...samples.slice(-2)) - samples[1]!,
          reloads: f.loads.get(oldest) ?? 0
        };
      } finally {
        await f.close();
      }
    };
    const small = await sample(256);
    const large = await sample(128 * 1024);
    console.info('subagent-residency-heap', JSON.stringify({ small, large }));
    // Old bodies would retain roughly 16 MiB more after the second sample.
    expect(large.growth - small.growth).toBeLessThan(6 * 1024 * 1024);
    expect(small.reloads).toBe(1);
    expect(large.reloads).toBe(1);
  });

  it('does not retain result-only event buffers across repeated long executions', () => {
    for (let warmup = 0; warmup < 3; warmup++) {
      const queue = new AsyncQueue<string>();
      for (let index = 0; index < 10_000; index++) queue.push(`warmup-${index}`);
      queue.discardIfUnobserved();
    }
    const baseline = collectHeap();
    const samples: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let execution = 0; execution < 20; execution++) {
        const queue = new AsyncQueue<string>();
        for (let index = 0; index < 5_000; index++)
          queue.push(`${round}:${execution}:${index}:${'x'.repeat(128)}`);
        expect(queue.discardIfUnobserved()).toBe(true);
        expect(queue.bufferedSize).toBe(0);
      }
      samples.push(collectHeap());
    }
    const retainedGrowth = Math.max(...samples.slice(-2)) - baseline;
    expect(retainedGrowth).toBeLessThan(8 * 1024 * 1024);
  });

  it('does not retain file streams across repeated large-file batch reads', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-memory-batch-read-'));
    const tools = new LocalWorkspaceTools(workspace);
    const reads = Array.from({ length: TOOL_EXECUTION_LIMITS.readMaxBatchItems }, (_, index) => ({
      path: `large-${index}.txt`,
      offset: 1,
      limit: 2
    }));
    try {
      await Promise.all(
        reads.map((item) => writeFile(join(workspace, item.path), 'line\n'.repeat(200_000)))
      );
      for (let warmup = 0; warmup < 3; warmup++) await tools.read({ reads });
      const baseline = collectHeap();
      const samples: number[] = [];
      for (let round = 0; round < 10; round++) {
        const result = await tools.read({ reads });
        expect(result.results).toHaveLength(TOOL_EXECUTION_LIMITS.readMaxBatchItems);
        samples.push(collectHeap());
      }
      const retainedGrowth = Math.max(...samples.slice(-3)) - baseline;
      expect(retainedGrowth).toBeLessThan(8 * 1024 * 1024);
    } finally {
      await tools.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not retain whole JSONL segments across concurrent tail page reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-agent-memory-jsonl-page-'));
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
      const baseline = collectHeap();
      const samples: number[] = [];
      for (let round = 0; round < 10; round++) {
        const pages = await Promise.all(
          Array.from({ length: 8 }, () => store.readPage(session.id, { limit: 30 }))
        );
        expect(pages.every((page) => page.records.length === 30)).toBe(true);
        samples.push(collectHeap());
      }
      const retainedGrowth = Math.max(...samples.slice(-3)) - baseline;
      expect(retainedGrowth).toBeLessThan(12 * 1024 * 1024);
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not retain patch parsing or transaction buffers after repeated commits', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-memory-patch-'));
    const tools = new LocalWorkspaceTools(workspace);
    const target = join(workspace, 'target.txt');
    try {
      for (let warmup = 0; warmup < 3; warmup++) {
        await writeFile(target, `before-${warmup}\n${'x'.repeat(256_000)}\n`);
        await tools.applyPatch(
          `*** Begin Patch\n*** Update File: target.txt\n@@\n-before-${warmup}\n+after-${warmup}\n ${'x'.repeat(256_000)}\n*** End Patch`
        );
      }
      const baseline = collectHeap();
      const samples: number[] = [];
      for (let round = 0; round < 20; round++) {
        await writeFile(target, `before-${round}\n${'x'.repeat(256_000)}\n`);
        await tools.applyPatch(
          `*** Begin Patch\n*** Update File: target.txt\n@@\n-before-${round}\n+after-${round}\n ${'x'.repeat(256_000)}\n*** End Patch`
        );
        samples.push(collectHeap());
      }
      const retainedGrowth = Math.max(...samples.slice(-3)) - baseline;
      expect(retainedGrowth).toBeLessThan(8 * 1024 * 1024);
    } finally {
      await tools.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('releases consumed incremental exec output between completed processes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mar-agent-memory-exec-output-'));
    const tools = new LocalWorkspaceTools(workspace);
    try {
      for (let warmup = 0; warmup < 3; warmup++)
        await tools.exec({
          action: 'start',
          command: `${process.execPath} -e "process.stdout.write('x'.repeat(500000))"`,
          yieldMs: 5_000
        });
      const baseline = collectHeap();
      const samples: number[] = [];
      for (let round = 0; round < 15; round++) {
        const result = await tools.exec({
          action: 'start',
          command: `${process.execPath} -e "process.stdout.write('x'.repeat(500000))"`,
          yieldMs: 5_000
        });
        expect(result.stdoutBytes).toBe(500_000);
        samples.push(collectHeap());
      }
      const retainedGrowth = Math.max(...samples.slice(-3)) - baseline;
      expect(retainedGrowth).toBeLessThan(8 * 1024 * 1024);
    } finally {
      await tools.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
