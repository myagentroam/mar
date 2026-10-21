import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LocalAgentHost,
  parseModelCatalog,
  type MarAgentEvent,
  type MarAgentModelConfiguration
} from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { type ModelAdapter, type ModelRequest } from '../../src/agent-core/model/contracts.js';
import { countModelTokens } from '../../src/agent-core/runtime/token-budget.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const directories: string[] = [];

interface Capture {
  readonly requests: {
    readonly compact: boolean;
    readonly estimatedInputTokens: number;
    readonly toolNames: readonly string[];
    providerInputTokens?: number;
    providerOutputTokens?: number;
  }[];
  readonly toolCalls: {
    readonly request: number;
    readonly name: string;
    readonly arguments: unknown;
  }[];
}

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(enabled)('compaction real development continuation', () => {
  const variant = 'standard';
  it(`continues and completes a real task after ${variant} compaction`, async () => {
    const root = await mkdtemp(join(tmpdir(), `mar-agent-compact-${variant}-`));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await createFixture(workspace);
    await initializeGitFixture(workspace);
    const baselineHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace }))
      .stdout;

    const baseline = await execFileAsync(process.execPath, ['--test'], { cwd: workspace }).catch(
      (error: { code?: number }) => error
    );
    expect(baseline.code).not.toBe(0);

    const catalog = parseModelCatalog(JSON.parse(await readFile('.e2e/models.local.json', 'utf8')));
    const configured = catalog.models.find((candidate) => candidate.id === 'gpt-5.6-luna');
    if (!configured) throw new Error('MAR_AGENT_E2E_RESPONSES_MODEL_MISSING');
    const model: MarAgentModelConfiguration = {
      ...configured,
      hostedWebSearch: false,
      maxOutputTokens: Math.min(configured.maxOutputTokens, 10_240)
    };
    const capture: Capture = { requests: [], toolCalls: [] };
    const create = () =>
      createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: home,
          workspace,
          environment: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8' }
        }),
        models: [model],
        defaultModelId: model.id,
        adapterFactory: () => captureAdapter(model, capture)
      });

    const store = await JsonlSessionStore.open(home);
    const session = await store.createSession({ workspace, title: `${variant} compact task` });
    await seedDevelopmentState(store, session.id);
    await store.close();

    let agent = await create();
    let compactSummary = '';
    try {
      const compact = (await agent.openSession(session.id)).compact({ reasoningEffort: 'high' });
      expect((await compact.result()).status).toBe('completed');
      const compactStore = await JsonlSessionStore.open(home);
      try {
        const checkpoint = (await compactStore.read(session.id))
          .filter((record) => record.type === 'compact.completed')
          .at(-1);
        compactSummary = checkpoint?.payload.summary ?? '';
      } finally {
        await compactStore.close();
      }
      expect(compactSummary).not.toBe('');
      expect(compactSummary).not.toContain('RELOADABLE_AGENTS_RULE_MUST_NOT_ENTER_COMPACT');
      expect(compactSummary).not.toContain('// Reloaded AGENTS.md verified.');
    } finally {
      await agent.dispose();
    }

    const events: MarAgentEvent[] = [];
    agent = await create();
    let finalAnswer = '';
    try {
      const handle = (await agent.openSession(session.id)).run({
        modelId: model.id,
        reasoningEffort: 'high',
        prompt:
          'Continue from the current task state. Complete the remaining implementation, run the necessary verification, inspect the final changes, and report the result. Do not commit.'
      });
      for await (const event of handle) events.push(event);
      const result = await handle.result();
      expect(result.status, result.errorCode).toBe('completed');
      finalAnswer = result.finalAnswer;
    } finally {
      await agent.dispose();
    }

    const verification = await execFileAsync(process.execPath, ['--test'], { cwd: workspace });
    expect(verification.stdout).toContain('fail 0');
    const tokenBudgetSource = await readFile(join(workspace, 'src', 'token-budget.js'), 'utf8');
    const agentOutputSource = await readFile(join(workspace, 'src', 'agent-output.js'), 'utf8');
    expect(tokenBudgetSource).toContain('// Reloaded AGENTS.md verified.');
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(
      baselineHead
    );
    expect(
      (
        await execFileAsync('git', ['diff', '--name-only'], {
          cwd: workspace
        })
      ).stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort()
    ).toEqual(['src/agent-output.js', 'src/token-budget.js']);
    expect(events.some((event) => event.type === 'execution.failed')).toBe(false);
    const patchIndex = capture.toolCalls.findIndex((call) => call.name === 'apply_patch');
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    const prePatchExecCalls = capture.toolCalls
      .slice(0, patchIndex)
      .filter((call) => call.name === 'exec')
      .map((call) => JSON.stringify(call.arguments));
    expect(
      capture.toolCalls
        .slice(patchIndex + 1)
        .some(
          (call) => call.name === 'exec' && JSON.stringify(call.arguments).includes('node --test')
        )
    ).toBe(true);

    const metric = {
      variant,
      modelId: model.id,
      compact: capture.requests.find((request) => request.compact),
      compactSummary: {
        estimatedTokens: countModelTokens(compactSummary),
        characters: compactSummary.length,
        utf8Bytes: Buffer.byteLength(compactSummary),
        text: compactSummary
      },
      continuationRequests: capture.requests.filter((request) => !request.compact).length,
      continuationToolCalls: capture.toolCalls,
      patchRequest: capture.toolCalls[patchIndex]?.request ?? null,
      prePatchToolCalls: capture.toolCalls.slice(0, patchIndex),
      prePatchExecCalls,
      toolFailures: events
        .filter(
          (event): event is Extract<MarAgentEvent, { type: 'tool.failed' }> =>
            event.type === 'tool.failed'
        )
        .map((event) => ({ tool: event.toolName, code: event.code })),
      subagentStarts: capture.toolCalls.filter((call) => call.name === 'agent_start').length,
      finalAnswerCharacters: finalAnswer.length,
      finalSource: {
        tokenBudget: tokenBudgetSource,
        agentOutput: agentOutputSource
      },
      verificationPassed: true
    };
    const runId = process.env.MAR_TEST_RUN_ID;
    if (runId && /^[\w-]+$/u.test(runId)) {
      const directory = resolve('../test/runs', runId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `compaction-continuation-${variant}.json`),
        `${JSON.stringify(metric, null, 2)}\n`
      );
    }
  }, 600_000);
});

function captureAdapter(model: MarAgentModelConfiguration, capture: Capture): ModelAdapter {
  const delegate = new OpenAiResponsesAdapter(model);
  return {
    configuration: model,
    async *start(request: ModelRequest, signal: AbortSignal) {
      const requestIndex = capture.requests.length;
      const compact = request.toolChoice === 'none';
      const capturedRequest: Capture['requests'][number] = {
        compact,
        estimatedInputTokens: countModelTokens(
          request.system + request.messages.map((message) => message.content).join('\n')
        ),
        toolNames: request.tools.map((tool) => tool.name)
      };
      capture.requests.push(capturedRequest);
      for await (const event of delegate.start(request, signal)) {
        if (event.type === 'client_tool.call')
          capture.toolCalls.push({
            request: requestIndex,
            name: event.name,
            arguments: structuredClone(event.arguments)
          });
        if (event.type === 'usage') {
          capturedRequest.providerInputTokens =
            event.usage.contextInputTokens ?? event.usage.inputTokens;
          capturedRequest.providerOutputTokens = event.usage.outputTokens;
        }
        yield event;
      }
    },
    close: () => delegate.close()
  };
}

async function createFixture(workspace: string): Promise<void> {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(
    join(workspace, 'AGENTS.md'),
    [
      '# Development instructions',
      '',
      '- Preserve public APIs and existing truncation behavior.',
      '- Only `src/token-budget.js` and `src/agent-output.js` may change.',
      '- Do not add dependencies or create commits.',
      '- Run verification with `node --test`.',
      '- If you change `src/token-budget.js`, add the exact comment `// Reloaded AGENTS.md verified.` immediately above `truncateModelText`.',
      '- AGENTS-only marker: RELOADABLE_AGENTS_RULE_MUST_NOT_ENTER_COMPACT.',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'compaction-continuation-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(workspace, 'src', 'token-budget.js'),
    [
      'const BYTES_PER_TOKEN = 4;',
      '',
      'export function countModelTokens(value) {',
      "  return Math.ceil(Buffer.byteLength(value, 'utf8') / BYTES_PER_TOKEN);",
      '}',
      '',
      'export function truncateModelText(value, maximumTokens, omittedLabel = "tool output") {',
      '  const tokens = countModelTokens(value);',
      '  if (tokens <= maximumTokens) return { content: value, truncated: false };',
      '  const totalLines = value.length === 0 ? 0 : value.split("\\n").length - Number(value.endsWith("\\n"));',
      '  return {',
      '    content: `Warning: truncated output (original token count: ${tokens})\\nTotal output lines: ${totalLines}\\n\\n...[${tokens - maximumTokens} tokens of ${omittedLabel} omitted]...`,',
      '    truncated: true',
      '  };',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'src', 'agent-output.js'),
    [
      "import { truncateModelText } from './token-budget.js';",
      '',
      'export function boundedModelToolOutput(output) {',
      '  const serialized = JSON.stringify({ stdout: output.stdout, stderr: output.stderr });',
      '  return truncateModelText(serialized, 100);',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'test', 'token-budget.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { truncateModelText } from '../src/token-budget.js';",
      '',
      "test('uses caller-provided source diagnostics for a truncated envelope', () => {",
      "  const serialized = JSON.stringify({ stdout: 'out\\n'.repeat(700), stderr: 'err\\n'.repeat(700) });",
      "  const result = truncateModelText(serialized, 100, 'tool output', {",
      '    originalTokenCount: 1400,',
      '    totalLines: 1400',
      '  });',
      '  assert.match(result.content, /original token count: 1400/);',
      '  assert.match(result.content, /Total output lines: 1400/);',
      '});',
      ''
    ].join('\n')
  );
  await writeFile(
    join(workspace, 'test', 'agent-output.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { boundedModelToolOutput } from '../src/agent-output.js';",
      '',
      "test('reports raw stdout and stderr diagnostics instead of serialized-envelope statistics', () => {",
      "  const result = boundedModelToolOutput({ stdout: 'out\\n'.repeat(700), stderr: 'err\\n'.repeat(700) });",
      '  assert.match(result.content, /original token count: 1400/);',
      '  assert.match(result.content, /Total output lines: 1400/);',
      '});',
      ''
    ].join('\n')
  );
}

async function initializeGitFixture(workspace: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'MAR Agent Test'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'mar-agent-test@example.invalid'], {
    cwd: workspace
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'test fixture baseline'], {
    cwd: workspace
  });
}

async function seedDevelopmentState(store: JsonlSessionStore, sessionId: string): Promise<void> {
  await store.append(sessionId, {
    type: 'turn.user',
    payload: {
      prompt: [
        'Current objective: fix inaccurate truncation diagnostics for large exec output with the smallest compatible change.',
        'Only src/token-budget.js and src/agent-output.js may change. Preserve public APIs and existing truncation behavior.',
        'Do not add dependencies, commit, push, or use external services.'
      ].join('\n')
    }
  });
  await store.append(sessionId, {
    type: 'model.context',
    payload: {
      role: 'tool_call',
      callId: 'inspect-truncation-diagnostics',
      name: 'read',
      arguments: {
        reads: [
          { path: 'src/token-budget.js', offset: 1, limit: 200 },
          { path: 'src/agent-output.js', offset: 1, limit: 200 }
        ]
      }
    }
  });
  await store.append(sessionId, {
    type: 'model.context',
    payload: {
      role: 'tool',
      callId: 'inspect-truncation-diagnostics',
      content: [
        'Focused baseline command `node --test test/token-budget.test.js test/agent-output.test.js` failed in both tests.',
        'Root cause confirmed: boundedModelToolOutput serializes stdout/stderr before truncation, so truncateModelText calculates token and line diagnostics from the JSON envelope rather than the complete raw streams.',
        'The raw stdout and stderr remain available in boundedModelToolOutput. The compatible design is to let truncateModelText accept optional caller-reported originalTokenCount and totalLines while preserving existing callers, then compute and pass combined raw-stream diagnostics from boundedModelToolOutput.',
        'Current progress: source inspection and failure diagnosis are complete; no source edit has been performed and no post-fix verification has run.',
        'Remaining work: edit only src/token-budget.js and src/agent-output.js; run the focused baseline command, run node --test, inspect git diff --check and the final scoped diff, then report verification.',
        '',
        'Reloadable historical investigation follows and contains no later decisions:',
        'Historical trace line without a current-state change. '.repeat(12_000)
      ].join('\n')
    }
  });
}
