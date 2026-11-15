import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSessionDirectory } from '../tools/session-analysis.mjs';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const sessionId = '00000000-0000-4000-8000-000000000001';
const generation = '00000000-0000-4000-8000-000000000002';
const previous = '00000000-0000-4000-8000-000000000003';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session analysis storage selection', () => {
  it('reads only the indexed V2 generation through the API and CLI without changing storage', async () => {
    const { home, directory } = await fixture();
    await index(directory, 2, { encoding: 2, generation });
    const current = join(directory, 'v2', generation);
    await events(current, 7);
    await events(directory, 100);
    await events(join(directory, 'v2', previous), 200);
    const before = await readFile(join(dirname(directory), 'index.json'), 'utf8');

    const report = await analyzeSessionDirectory(directory);
    expect(report.range.recordCount).toBe(1);
    expect(report.usage).toMatchObject({ requestCount: 1, inputTokens: 7, outputTokens: 2 });
    const tool = resolve(import.meta.dirname, '../tools/session-analyzer.mjs');
    for (const args of [
      ['--session-dir', directory],
      ['--source-home', home, '--session', sessionId]
    ]) {
      const { stdout } = await execFileAsync(process.execPath, [tool, ...args, '--json']);
      expect(JSON.parse(stdout).usage).toMatchObject({ requestCount: 1, inputTokens: 7 });
    }
    expect((await analyzeSessionDirectory(current)).usage.inputTokens).toBe(7);
    expect(await readFile(join(dirname(directory), 'index.json'), 'utf8')).toBe(before);
  });

  it.each(['standalone', 'v1', 'v2-legacy'] as const)(
    'keeps %s event directories readable',
    async (layout) => {
      const { directory } = await fixture();
      if (layout === 'v1') await index(directory, 1);
      if (layout === 'v2-legacy') await index(directory, 2, { encoding: 1 });
      await events(directory, 11);
      expect((await analyzeSessionDirectory(directory)).usage).toMatchObject({
        requestCount: 1,
        inputTokens: 11
      });
    }
  );

  it('accepts a genuinely empty indexed session and an empty standalone event segment', async () => {
    const { directory } = await fixture();
    await index(directory, 2, { encoding: 2, generation }, 1);
    const current = join(directory, 'v2', generation);
    await mkdir(current, { recursive: true });
    expect((await analyzeSessionDirectory(directory)).range.recordCount).toBe(0);
    await writeFile(join(current, 'events-000001.jsonl'), '');
    expect((await analyzeSessionDirectory(current)).range.recordCount).toBe(0);
  });

  it.each([1, 2] as const)(
    'does not mistake empty published v%s logs for an empty session or a filtered view',
    async (version) => {
      const { directory } = await fixture();
      await index(directory, version, version === 2 ? { encoding: 2, generation } : undefined);
      const active = version === 2 ? join(directory, 'v2', generation) : directory;
      await mkdir(active, { recursive: true });
      for (const contents of ['', '\n\n']) {
        await writeFile(join(active, 'events-000001.jsonl'), contents);
        await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/no records/i);
      }
      await events(active, 7);
      expect(
        (await analyzeSessionDirectory(directory, { sinceSequence: 2 })).range.recordCount
      ).toBe(0);
    }
  );

  it('rejects an unrecognized directory instead of reporting a successful empty analysis', async () => {
    const { directory } = await fixture();
    await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/event|layout|Session/i);
    const tool = resolve(import.meta.dirname, '../tools/session-analyzer.mjs');
    await expect(
      execFileAsync(process.execPath, [tool, '--session-dir', directory])
    ).rejects.toMatchObject({
      code: 1
    });
    await expect(analyzeSessionDirectory(join(directory, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('does not guess a V2 generation when its index is missing', async () => {
    const { directory } = await fixture();
    await events(directory, 100);
    await events(join(directory, 'v2', generation), 7);
    await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/index/i);
  });

  it('does not fall back to legacy records when selected V2 storage is missing or incomplete', async () => {
    const { directory } = await fixture();
    await index(directory, 2, { encoding: 2, generation });
    await events(directory, 100);
    await expect(analyzeSessionDirectory(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(directory, 'v2', generation), { recursive: true });
    await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/event|segment/i);
  });

  it.each([
    { version: 3, storage: { encoding: 2, generation } },
    { version: 2, storage: { encoding: 3 } },
    { version: 2, storage: { encoding: 2, generation: '../PRIVATE_VALUE' } }
  ])(
    'rejects unsupported or unsafe indexed storage %# without echoing its contents',
    async ({ version, storage }) => {
      const { directory } = await fixture();
      await index(directory, version, storage);
      await events(directory, 100);
      const error = await analyzeSessionDirectory(directory).then(
        () => undefined,
        (caught: Error) => caught
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain('PRIVATE_VALUE');
    }
  );

  it('rejects corrupt indexes and missing session entries rather than ignoring the index', async () => {
    const { directory } = await fixture();
    await events(directory, 100);
    const path = join(dirname(directory), 'index.json');
    await writeFile(path, 'PRIVATE_INVALID_JSON');
    await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/index/i);
    await writeFile(path, JSON.stringify({ version: 2, sessions: [] }));
    await expect(analyzeSessionDirectory(directory)).rejects.toThrow(/index/i);
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-session-layout-'));
  roots.push(home);
  const directory = join(home, '.mar', 'agent', 'sessions', sessionId);
  await mkdir(directory, { recursive: true });
  return { home, directory };
}

async function index(directory: string, version: number, storage?: object, nextSequence = 2) {
  await writeFile(
    join(dirname(directory), 'index.json'),
    JSON.stringify({
      version,
      revision: 0,
      sessions: [{ id: sessionId, nextSequence, ...(storage === undefined ? {} : { storage }) }]
    })
  );
}

async function events(directory: string, inputTokens: number) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'events-000001.jsonl'),
    JSON.stringify({
      schemaVersion: 1,
      recordId: 'record-1',
      sequence: 1,
      timestamp: '2026-11-15T00:00:00.000Z',
      sessionId,
      executionId: 'execution',
      type: 'usage.updated',
      payload: { inputTokens, outputTokens: 2 }
    }) + '\n'
  );
}
