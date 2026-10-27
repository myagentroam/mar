import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgent, parseModelCatalog } from '../../src/index.js';
import { LocalAgentHost } from '../../src/host.js';
import type { AgentEvent } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const directories: string[] = [];

async function listFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(root, path)));
    else result.push(relative(root, path));
  }
  return result.sort();
}

async function createFixture(workspace: string) {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(
    join(workspace, 'AGENTS.md'),
    [
      '# Development instructions',
      '',
      '- Run tests with `node --test`.',
      '- Preserve the public API and integer-cent arithmetic.',
      '- Do not add dependencies or create commits.',
      '- Load and follow `src/AGENTS.md` before editing files in `src/`.',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'src', 'AGENTS.md'),
    [
      '# Source instructions',
      '',
      '- If you change `discount.js`, add the exact comment `// Nested AGENTS.md verified.` immediately above the corrected return statement.',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify(
      { name: 'invoice-fixture', private: true, type: 'module', scripts: { test: 'node --test' } },
      null,
      2
    ) + '\n'
  );
  await writeFile(
    join(workspace, 'src', 'discount.js'),
    [
      'export function calculateDiscount(subtotalCents, percentage) {',
      '  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) throw new TypeError("subtotalCents must be a non-negative integer");',
      '  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new TypeError("percentage must be an integer from 0 to 100");',
      '  return Math.round(subtotalCents * percentage);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'src', 'invoice.js'),
    [
      "import { calculateDiscount } from './discount.js';",
      '',
      'export function invoiceTotal(items, discountPercentage = 0) {',
      '  const subtotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);',
      '  return subtotal - calculateDiscount(subtotal, discountPercentage);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'test', 'invoice.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { invoiceTotal } from '../src/invoice.js';",
      '',
      "test('totals an invoice without a discount', () => {",
      '  assert.equal(invoiceTotal([{ unitPriceCents: 1250, quantity: 2 }]), 2500);',
      '});',
      '',
      "test('applies a percentage discount using integer cents', () => {",
      '  assert.equal(invoiceTotal([{ unitPriceCents: 1999, quantity: 1 }], 15), 1699);',
      '});',
      ''
    ].join('\n')
  );
}

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(enabled)('gpt-5.6-luna high real development case', () => {
  it('diagnoses, fixes and verifies a cross-file defect from a clean fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-real-development-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await createFixture(workspace);
    const initialFiles = await listFiles(workspace);
    const initialDiscountSource = await readFile(join(workspace, 'src', 'discount.js'), 'utf8');

    const baseline = await execFileAsync(process.execPath, ['--test'], { cwd: workspace }).catch(
      (error: { stdout?: string; stderr?: string; code?: number }) => error
    );
    expect(baseline.code, 'fixture baseline must fail before Agent execution').not.toBe(0);

    const catalog = parseModelCatalog(JSON.parse(await readFile('.e2e/models.local.json', 'utf8')));
    const model = catalog.models.find((candidate) => candidate.id === 'gpt-5.6-luna')!;
    const agent = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      defaultModelId: model.id
    });
    let sessionId = '';
    const events: AgentEvent[] = [];
    try {
      const session = await agent.createSession({ workspace, title: 'Invoice discount bug' });
      sessionId = session.id;
      const handle = session.run({
        modelId: model.id,
        reasoningEffort: 'high',
        prompt:
          'Fix the invoice discount bug reported by the failing test suite. Diagnose the root cause from evidence, make the smallest correct change while preserving the public API, run targeted and full verification, inspect the resulting changes, and report what you verified.'
      });
      for await (const event of handle) events.push(event);
      const result = await handle.result();
      const diagnostics = events
        .filter((event) => event.type === 'tool.failed' || event.type === 'execution.failed')
        .map((event) =>
          event.type === 'tool.failed'
            ? { type: event.type, tool: event.toolName, code: event.code }
            : { type: event.type, code: event.code }
        );
      expect(result, JSON.stringify({ errorCode: result.errorCode, diagnostics })).toMatchObject({
        status: 'completed'
      });
    } finally {
      await agent.dispose();
    }

    const completedTools = events
      .filter(
        (event): event is Extract<AgentEvent, { type: 'tool.completed' }> =>
          event.type === 'tool.completed'
      )
      .map((event) => event.toolName);
    expect(completedTools).toEqual(expect.arrayContaining(['exec', 'apply_patch']));
    expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
    expect(await listFiles(workspace)).toEqual(initialFiles);
    const finalDiscountSource = await readFile(join(workspace, 'src', 'discount.js'), 'utf8');
    expect(finalDiscountSource).not.toBe(initialDiscountSource);
    expect(finalDiscountSource).toContain('// Nested AGENTS.md verified.');
    const discountModule = (await import(
      `${pathToFileURL(join(workspace, 'src', 'discount.js')).href}?verification=${Date.now()}`
    )) as { calculateDiscount(subtotalCents: number, percentage: number): number };
    expect(discountModule.calculateDiscount(1999, 15)).toBe(300);
    const verification = await execFileAsync(process.execPath, ['--test'], { cwd: workspace });
    expect(verification.stdout).toContain('fail 0');
    await expect(stat(join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

    const reopened = await createAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model]
    });
    try {
      await expect(reopened.openSession(sessionId)).resolves.toMatchObject({ id: sessionId });
    } finally {
      await reopened.dispose();
    }
    const sessionDirectory = join(home, '.mar', 'agent', 'sessions', sessionId);
    expect(await readdir(sessionDirectory)).toContain('events-000001.jsonl');
    expect(
      (await listFiles(join(home, '.mar', 'agent'))).some((path) => path.endsWith('.lock'))
    ).toBe(false);
  }, 300_000);
});
