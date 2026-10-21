import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalAgentHost } from '../../dist/index.js';
import { directLocalProcessExecutor } from '../../dist/agent-core/host/local-process-executor.js';
import { readToolDefinition } from '../../dist/agent-core/tools/local/read.js';

// Isolated, synthetic orchestration observations, not a cross-platform performance guarantee.
const iterations = Number(process.argv[2] ?? 20);
if (!Number.isSafeInteger(iterations) || iterations < 5 || iterations > 100)
  throw new Error('Use 5 to 100 iterations.');
const directory = await mkdtemp(join(tmpdir(), 'mar-code-benchmark-'));
const workspace = join(directory, 'workspace');
await mkdir(workspace);
await Promise.all(
  ['a.txt', 'b.txt'].map((name) => writeFile(join(workspace, name), 'evidence\n'.repeat(20)))
);
let children = 0;
let activeCase;
const workers = [];
const liveWorkers = new Set();
const sampling = new Set();
const sampleIntervalMs = 5;
const host = new LocalAgentHost({
  homeDirectory: join(directory, 'home'),
  workspace,
  environment: {},
  processExecutor: {
    async spawn(request) {
      children++;
      const started = performance.now();
      const child = await directLocalProcessExecutor.spawn(request);
      const record = { case: activeCase, peakObservedRssBytes: 0 };
      workers.push(record);
      liveWorkers.add(child);
      child.stdout.once('data', () => {
        record.firstStdoutMs = performance.now() - started;
      });
      let closed = false;
      child.once('close', () => {
        closed = true;
        liveWorkers.delete(child);
      });
      const sampler = (async () => {
        if (process.platform !== 'linux' || !child.pid) return;
        while (!closed) {
          try {
            const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
            const highWater = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
            if (highWater)
              record.peakObservedRssBytes = Math.max(
                record.peakObservedRssBytes,
                Number(highWater[1]) * 1024
              );
          } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
            throw error;
          }
          await delay(sampleIntervalMs);
        }
      })();
      sampling.add(sampler);
      // Keep sampling failures observable without creating unhandled rejections.
      void sampler.then(
        () => sampling.delete(sampler),
        () => {}
      );
      return child;
    }
  }
});
const context = {
  mode: 'run',
  sessionId: 'benchmark-session',
  executionId: 'benchmark-execution',
  signal: new AbortController().signal
};
const echo = {
  name: 'echo',
  description: 'Synthetic JSON round trip.',
  inputSchema: { type: 'object' },
  allowedCallers: ['programmatic'],
  parallelSafety: 'safe'
};
const largeFixture = Array.from({ length: 10_000 }, (_, id) => ({
  id,
  value: 'x'.repeat(64)
}));
const cellContext = {
  ...context,
  codeMode: {
    tools: [readToolDefinition, echo],
    invoke: async (call, signal) => {
      if (call.name !== 'echo') return host.executeTool(call, { ...context, signal });
      if (call.arguments.delayMs) await delay(call.arguments.delayMs, undefined, { signal });
      return {
        content: 'echo',
        data: call.arguments.large ? { items: largeFixture } : call.arguments
      };
    }
  }
};
async function cell(code, expected, input = cellContext, expectedCalls) {
  const output = await host.executeTool({ name: 'code_exec', arguments: code }, input);
  if (typeof expected === 'function') expected(output);
  else assert.equal(output.observations?.at(-1)?.value, String(expected));
  if (expectedCalls !== undefined) assert.equal(output.data.toolCalls, expectedCalls);
  return output;
}
const cases = {
  'direct-two-reads': async () => {
    const outputs = await Promise.all(
      ['a.txt', 'b.txt'].map((path) =>
        host.executeTool({ name: 'read', arguments: { reads: [{ path }] } }, context)
      )
    );
    for (const output of outputs)
      assert.equal(output.data.results[0].text, 'evidence\n'.repeat(20));
  },
  'empty-cell': () => cell('observe.text("ok");', 'ok', undefined, 0),
  'cell-single-bridge': () =>
    cell('observe.text((await tools.echo({value: 1})).data.value);', 1, undefined, 1),
  'cell-two-reads': () =>
    cell(
      `const results = await Promise.all(["a.txt", "b.txt"].map(path =>
        tools.read({reads: [{path}]}))); observe.text(results.map(result => result.data.results[0].text));`,
      JSON.stringify(['evidence\n'.repeat(20), 'evidence\n'.repeat(20)]),
      undefined,
      2
    ),
  'cell-128-bridges': () =>
    cell(
      `const results = await Promise.all(Array.from({length: 128}, (_, value) =>
        tools.echo({value}))); observe.text(results.length);`,
      128,
      undefined,
      128
    ),
  'cell-1mib-input': () => {
    const suffix = '*/ observe.text("input-ok");';
    const code = '/*' + 'x'.repeat(1_048_576 - 2 - suffix.length) + suffix;
    assert.equal(Buffer.byteLength(code), 1_048_576);
    return cell(code, 'input-ok', undefined, 0);
  },
  'cell-1mib-output': () =>
    cell(
      'observe.text("x".repeat(1_048_575));',
      (output) => {
        assert.equal(output.truncated, true);
        assert.equal(output.data.outputBytes, 1_048_575);
        assert.equal(JSON.parse(output.content).observations[0].truncated, true);
      },
      undefined,
      0
    ),
  'cell-large-json-filter': () =>
    cell(
      'const result = await tools.echo({large: true}); observe.text(result.data.items.filter(item => item.id % 1000 === 0).map(item => item.id));',
      JSON.stringify(Array.from({ length: 10 }, (_, index) => index * 1000)),
      undefined,
      1
    )
};
for (const count of [10, 50]) {
  for (const delayMs of [0, 5]) {
    const prefix = delayMs ? 'io-5ms' : 'cell';
    const expected = (count * (count - 1)) / 2;
    cases[`${prefix}-sequential-${count}`] = () =>
      cell(
        `let sum = 0; for (let value = 0; value < ${count}; value++)
        sum += (await tools.echo({value, delayMs: ${delayMs}})).data.value; observe.text(sum);`,
        expected,
        undefined,
        count
      );
    cases[`${prefix}-parallel-${count}`] = () =>
      cell(
        `const results = await Promise.all(Array.from({length: ${count}}, (_, value) =>
        tools.echo({value, delayMs: ${delayMs}}))); observe.text(results.reduce((sum, result) => sum + result.data.value, 0));`,
        expected,
        undefined,
        count
      );
  }
}
const summarize = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) =>
    Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95), samples };
};
const cancellation = [];
const replacement = [];
async function cancelBusyCell() {
  const controller = new AbortController();
  let timer;
  let abortedAt;
  const cancelled = Object.assign(new Error('Cancel benchmark cell.'), {
    code: 'BENCHMARK_CANCELLED'
  });
  const input = {
    ...cellContext,
    signal: controller.signal,
    codeMode: {
      ...cellContext.codeMode,
      invoke: async () => {
        timer = setTimeout(() => {
          abortedAt = performance.now();
          controller.abort(cancelled);
        }, 50);
        return { content: 'ready' };
      }
    }
  };
  try {
    await assert.rejects(
      cell('await tools.echo({}); while (true) {}', 'unreachable', input),
      (error) => error.code === 'BENCHMARK_CANCELLED'
    );
    assert.notEqual(abortedAt, undefined);
    cancellation.push(performance.now() - abortedAt);
  } finally {
    clearTimeout(timer);
  }
  activeCase = 'replacement-after-cancel';
  const started = performance.now();
  await cell('observe.text("replacement-ok");', 'replacement-ok', undefined, 0);
  replacement.push(performance.now() - started);
}
async function waitForWorkers() {
  let timer;
  try {
    await Promise.race([
      Promise.all([...sampling, ...[...liveWorkers].map((child) => once(child, 'close'))]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker cleanup did not finish.')), 5_000);
      })
    ]);
    assert.equal(liveWorkers.size, 0);
  } finally {
    clearTimeout(timer);
  }
}
const results = {};
try {
  for (const [name, run] of Object.entries(cases)) {
    activeCase = name;
    const samples = [];
    for (let index = 0; index < iterations; index++) {
      const start = performance.now();
      await run();
      samples.push(performance.now() - start);
    }
    results[name] = summarize(samples);
  }
  for (let index = 0; index < iterations; index++) {
    activeCase = 'busy-loop-cancel';
    await cancelBusyCell();
  }
  results['cancel-request-to-return'] = summarize(cancellation);
  results['replacement-after-cancel'] = summarize(replacement);
  await waitForWorkers();
  for (const [name, result] of Object.entries(results)) {
    const observed = workers.filter(
      (worker) => worker.case === (name === 'cancel-request-to-return' ? 'busy-loop-cancel' : name)
    );
    const firstOutput = observed.flatMap((worker) =>
      worker.firstStdoutMs === undefined ? [] : [worker.firstStdoutMs]
    );
    const memory = observed.map((worker) => worker.peakObservedRssBytes).filter(Boolean);
    if (firstOutput.length) result.workerFirstStdout = summarize(firstOutput);
    if (memory.length) {
      const measured = summarize(memory.map((bytes) => bytes / 1_048_576));
      result.workerRss = {
        peakObservedMiB: Number((Math.max(...memory) / 1_048_576).toFixed(2)),
        p50MiB: measured.p50Ms,
        p95MiB: measured.p95Ms,
        samplesMiB: measured.samples
      };
    }
  }
  const report = {
    runtime: process.version,
    platform: `${process.platform}-${process.arch}`,
    iterations,
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    memorySamplingIntervalMs: sampleIntervalMs,
    memoryMetric:
      'Linux /proc VmHWM sampled before process exit; worker RSS includes Node and WASM',
    notes: [
      'Synthetic tools measure host bridge latency; 5 ms tool delays simulate independent I/O.',
      'Every production cell uses a fresh worker, not a warmed reusable runtime.',
      'Measurements include RSS sampling overhead, but exclude model and external sandbox latency.',
      'No historical unsafe Node evaluator was executed.'
    ],
    guestMemoryLimitBytes: 33_554_432,
    workerProcesses: children,
    liveWorkersAfterRun: liveWorkers.size,
    workerObservations: workers,
    results
  };
  const output = resolve('test/runs', `code-mode-benchmark-${Date.now()}.json`);
  await mkdir(resolve('test/runs'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        output,
        ...report,
        workerObservations: undefined,
        results: Object.fromEntries(
          Object.entries(results).map(([name, result]) => [
            name,
            {
              p50Ms: result.p50Ms,
              p95Ms: result.p95Ms,
              ...(result.workerRss ? { peakObservedMiB: result.workerRss.peakObservedMiB } : {})
            }
          ])
        )
      },
      null,
      2
    )
  );
} finally {
  try {
    await host.dispose();
    await waitForWorkers();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
