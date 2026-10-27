import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  parseModelCatalog,
  type ExecutionHandle,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelTurnSession,
  type ModelUsage
} from '../../src/model/contracts.js';
import {
  contextGcMessageTokens,
  contextGcPrefixTokens
} from '../../src/runtime/context/gc-tokens.js';
import { buildContextProjection } from '../../src/runtime/context/projection.js';
import { parseContextGcCheckpoint } from '../../src/session/context-gc-checkpoint.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const retainFixture = process.env.MAR_AGENT_REAL_E2E_RETAIN_FIXTURE === '1';
const directories: string[] = [];
const issueId = 'RATE-731';
const contextWindowTokens = 272_000;
const gcStartTokens = contextWindowTokens / 2;
const compactThresholdTokens = contextWindowTokens * 0.9;
const moduleCount = 16;
const changedFiles = Array.from(
  { length: moduleCount },
  (_, index) => `src/rates/region-${String(index + 1).padStart(2, '0')}.js`
);
const targetedCommand = 'node --test test/rate.test.js';
const fullCommand = 'npm test';
const oldRegistryMarker = 'LEDGER-RATE-01-001';

interface RequestCapture {
  readonly phase: 'initial' | 'resumed';
  readonly ordinal: number;
  readonly gcApplied: boolean;
  readonly containsOldRegistryMarker: boolean;
  readonly estimatedInputTokens: number;
  originalUsage?: ModelUsage;
}

interface ToolCallCapture {
  readonly phase: 'initial' | 'resumed';
  readonly requestOrdinal: number;
  readonly gcApplied: boolean;
  readonly name: string;
  readonly arguments: unknown;
}

interface Capture {
  readonly requests: RequestCapture[];
  readonly toolCalls: ToolCallCapture[];
}

async function finish(handle: ExecutionHandle, timeoutMs = 240_000) {
  const events: AgentEvent[] = [];
  const timeout = setTimeout(() => handle.cancel(), timeoutMs);
  try {
    for await (const event of handle) events.push(event);
    return { events, result: await handle.result() };
  } finally {
    clearTimeout(timeout);
  }
}

function estimatedRequestTokens(request: ModelRequest, model: AgentModelConfiguration): number {
  const input = { ...request, modelId: model.id, modelProtocol: model.protocol };
  return contextGcPrefixTokens(input) + contextGcMessageTokens(input, request.messages);
}

function captureAdapter(
  model: AgentModelConfiguration,
  phase: RequestCapture['phase'],
  capture: Capture
): ModelAdapter {
  const delegate = new OpenAiResponsesAdapter(model);
  const wrap = (turn: ModelTurnSession): ModelTurnSession => ({
    async *start(request, signal) {
      const ordinal = capture.requests.length + 1;
      const serializedMessages = JSON.stringify(request.messages);
      const gcApplied = serializedMessages.includes('<mar_context_gc kind=');
      const requestCapture: RequestCapture = {
        phase,
        ordinal,
        gcApplied,
        containsOldRegistryMarker: serializedMessages.includes(oldRegistryMarker),
        estimatedInputTokens: estimatedRequestTokens(request, model)
      };
      capture.requests.push(requestCapture);
      for await (const event of turn.start(request, signal)) {
        if (event.type === 'client_tool.call')
          capture.toolCalls.push({
            phase,
            requestOrdinal: ordinal,
            gcApplied,
            name: event.name,
            arguments: structuredClone(event.arguments)
          });
        if (event.type !== 'usage') {
          yield event;
          continue;
        }
        requestCapture.originalUsage = { ...event.usage };
        yield event;
      }
    },
    resetContinuation: () => turn.resetContinuation?.(),
    close: () => turn.close()
  });
  return {
    configuration: model,
    start: (request, signal) => delegate.start(request, signal),
    createTurnSession: () => wrap(delegate.createTurnSession()),
    close: () => delegate.close()
  };
}

async function createFixture(workspace: string) {
  await mkdir(join(workspace, 'src', 'rates'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspace, 'package.json'),
      `${JSON.stringify(
        {
          name: 'rate-calculation-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' }
        },
        null,
        2
      )}\n`
    ),
    ...changedFiles.map((path, index) =>
      writeFile(
        join(workspace, path),
        [
          `export function ${rateFunctionName(index)}(subtotalCents, rateBasisPoints) {`,
          '  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) throw new TypeError("invalid subtotal");',
          '  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) throw new TypeError("invalid rate");',
          '  return subtotalCents - Math.round((subtotalCents * rateBasisPoints) / 100);',
          '}',
          '',
          ...Array.from({ length: 170 }, (_, lineIndex) => ledgerEvidenceLine(index, lineIndex)),
          ''
        ].join('\n')
      )
    ),
    writeFile(
      join(workspace, 'test', 'rate.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        ...changedFiles.map(
          (path, index) => `import { ${rateFunctionName(index)} } from '../${path}';`
        ),
        '',
        `const calculators = [${changedFiles.map((_, index) => rateFunctionName(index)).join(', ')}];`,
        '',
        "test('applies basis points using integer cents', () => {",
        '  for (const calculate of calculators) assert.equal(calculate(10000, 1500), 8500);',
        '});',
        '',
        "test('keeps zero rates unchanged', () => {",
        '  for (const calculate of calculators) assert.equal(calculate(1999, 0), 1999);',
        '});',
        '',
        "test('rejects rates above one hundred percent', () => {",
        '  for (const calculate of calculators) assert.throws(() => calculate(1000, 10001), TypeError);',
        '});',
        ''
      ].join('\n')
    )
  ]);
}

function rateFunctionName(index: number): string {
  return `calculateRegion${String(index + 1).padStart(2, '0')}NetCents`;
}

function ledgerEvidenceLine(moduleIndex: number, lineIndex: number): string {
  const moduleOrdinal = String(moduleIndex + 1).padStart(2, '0');
  const lineOrdinal = String(lineIndex + 1).padStart(3, '0');
  return `// LEDGER-RATE-${moduleOrdinal}-${lineOrdinal}: preserve the exported rate calculation contract and immutable regional audit evidence; subtotal cents and basis points must remain integer-safe; regression fixture ${issueId}-${moduleOrdinal}-${lineOrdinal} must remain unchanged.`;
}

afterAll(async () => {
  if (retainFixture) return;
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(enabled)('Context GC real long-task E2E', () => {
  it('preserves task capability after GC while avoiding repeated source work and measuring savings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-context-gc-real-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await createFixture(workspace);
    const catalog = parseModelCatalog(JSON.parse(await readFile('.e2e/models.local.json', 'utf8')));
    const configured = catalog.models.find((candidate) => candidate.id === 'gpt-5.6-luna');
    if (!configured) throw new Error('MAR_AGENT_E2E_RESPONSES_MODEL_MISSING');
    const model: AgentModelConfiguration = {
      ...configured,
      contextWindowTokens,
      maxOutputTokens: Math.min(configured.maxOutputTokens, 4_096),
      hostedWebSearch: false
    };
    const capture: Capture = { requests: [], toolCalls: [] };
    let sessionId = '';
    let initialEvents: AgentEvent[] = [];
    const initialAgent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => captureAdapter(model, 'initial', capture)
    );
    try {
      const session = await initialAgent.createSession({
        workspace,
        title: 'Rate calculation repair'
      });
      sessionId = session.id;
      const prepared = await finish(
        session.run({
          prompt:
            'A source repair task will follow. Reply ready without inspecting files or using tools.'
        })
      );
      expect(prepared.result.status).toBe('completed');
      const compacted = await finish(session.compact());
      expect(compacted.result.status).toBe('completed');
      const completed = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            `Resolve issue ${issueId} in this package without committing or using external services.`,
            `The affected public modules are exactly: ${JSON.stringify(changedFiles)}.`,
            `Before editing, inspect every affected module completely. In one parallel tool batch, issue exactly ${moduleCount} separate read tool calls, one call per path with one reads item; do not combine paths into one call and do not use exec, rg, cat, code_exec, or another tool to inspect source text.`,
            'Each source file is below 200 lines, so read it from the beginning with a sufficient limit in that one call. Its in-file ledger is part of the acceptance boundary.',
            'Diagnose the shared failing behavior, preserve every exported API, and make the smallest correct source change across all affected modules.',
            'Do not run tests in the same tool batch as the source patch.',
            `After the source patch, run ${targetedCommand} and then ${fullCommand}.`,
            'Only after both commands pass, create verification.json with apply_patch. It must contain exactly these JSON fields and values:',
            JSON.stringify({
              issueId,
              changedFiles,
              targetedCommand,
              fullCommand,
              status: 'passed'
            }),
            'Then finish with an accurate concise result.'
          ].join('\n')
        })
      );
      initialEvents = completed.events;
      expect(completed.result, completed.result.errorCode).toMatchObject({ status: 'completed' });
    } finally {
      await initialAgent.dispose();
    }

    for (const path of changedFiles)
      expect(await readFile(join(workspace, path), 'utf8')).toContain('/ 10000)');
    expect(JSON.parse(await readFile(join(workspace, 'verification.json'), 'utf8'))).toEqual({
      issueId,
      changedFiles,
      targetedCommand,
      fullCommand,
      status: 'passed'
    });
    expect(initialEvents.some((event) => (event.type as string).includes('gc'))).toBe(false);

    const store = await JsonlSessionStore.open(home);
    const rawBeforeResume = await store.read(sessionId);
    const checkpoints = rawBeforeResume
      .map((record) => ({ record, payload: parseContextGcCheckpoint(record) }))
      .filter(
        (
          item
        ): item is {
          record: (typeof rawBeforeResume)[number];
          payload: NonNullable<ReturnType<typeof parseContextGcCheckpoint>>;
        } => item.payload !== undefined
      );
    const checkpoint = checkpoints.at(-1);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.payload.base.type).toBe('COMPACT');
    const state = await store.readExecutionState(sessionId);
    expect(buildContextProjection(state.contextRecords).checkpoint?.checkpointId).toBe(
      checkpoint!.payload.checkpointId
    );
    expect(checkpoint?.payload.replacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'READ_OUTPUT_ITEMS' }),
        expect.objectContaining({ kind: 'TOOL_CALL_INPUT', toolName: 'apply_patch' })
      ])
    );
    expect(checkpoint?.payload.metrics).toMatchObject({
      grossReductionRate: expect.any(Number),
      requiredTargetRoiRollouts: expect.any(Number)
    });
    expect(checkpoint!.payload.metrics.reclaimedTokens).toBeGreaterThan(0);
    expect(checkpoint!.payload.metrics.grossReductionRate).toBeGreaterThanOrEqual(0.2);
    expect(checkpoint!.payload.metrics.requiredTargetRoiRollouts).toBeLessThanOrEqual(20);
    expect(checkpoint!.payload.trigger.contextWindowTokens).toBe(contextWindowTokens);
    expect(checkpoint!.payload.trigger.contextInputTokens).toBeGreaterThanOrEqual(gcStartTokens);
    expect(checkpoint!.payload.trigger.contextInputTokens).toBeLessThan(compactThresholdTokens);
    expect(
      checkpoint!.payload.replacements
        .filter((replacement) => replacement.kind === 'READ_OUTPUT_ITEMS')
        .reduce((total, replacement) => total + replacement.items.length, 0)
    ).toBe(moduleCount);
    const firstGcRequest = capture.requests.find((request) => request.gcApplied);
    expect(firstGcRequest).toBeDefined();
    const triggerRequest = capture.requests.findLast((request) => {
      const usage = request.originalUsage;
      return (
        request.ordinal < firstGcRequest!.ordinal &&
        (usage?.contextInputTokens ?? usage?.inputTokens) ===
          checkpoint!.payload.trigger.contextInputTokens
      );
    });
    expect(triggerRequest).toBeDefined();
    const rawJson = JSON.stringify(rawBeforeResume);
    expect(rawJson).toContain(oldRegistryMarker);
    expect(rawJson).toContain('/ 100)');
    await store.close();

    expect(firstGcRequest!.containsOldRegistryMarker).toBe(false);
    expect(firstGcRequest!.estimatedInputTokens).toBeGreaterThan(0);
    expect(
      firstGcRequest!.originalUsage?.contextInputTokens ??
        firstGcRequest!.originalUsage?.inputTokens
    ).toBeLessThan(checkpoint!.payload.trigger.contextInputTokens * 0.8);
    const projectedCounterfactualTokens =
      firstGcRequest!.estimatedInputTokens + checkpoint!.payload.metrics.reclaimedTokens;
    expect(projectedCounterfactualTokens).toBeGreaterThan(firstGcRequest!.estimatedInputTokens);
    const providerContextInputTokens =
      firstGcRequest!.originalUsage?.contextInputTokens ??
      firstGcRequest!.originalUsage?.inputTokens ??
      null;
    const interRequestContextInputDelta =
      providerContextInputTokens === null
        ? null
        : checkpoint!.payload.trigger.contextInputTokens - providerContextInputTokens;
    expect(interRequestContextInputDelta).toBeGreaterThan(0);

    let resumedEvents: AgentEvent[] = [];
    const resumedAgent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => captureAdapter(model, 'resumed', capture)
    );
    try {
      const session = await resumedAgent.openSession(sessionId);
      const completed = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            'Continue from the restored task state.',
            'Do not read any existing file, invoke read/rg/cat, reopen the modified source, or rerun a command that already passed.',
            'Using only retained task state, create handoff.json with apply_patch. Include issueId, changedFiles, targetedCommand, fullCommand, status, and verificationArtifact using the exact established values.',
            'After creating it, you may only run a new bounded command that parses handoff.json as JSON; then report completion. If retained state is insufficient, stop as blocked rather than repeating prior work.'
          ].join('\n')
        })
      );
      resumedEvents = completed.events;
      expect(completed.result, completed.result.errorCode).toMatchObject({ status: 'completed' });
    } finally {
      await resumedAgent.dispose();
    }

    expect(JSON.parse(await readFile(join(workspace, 'handoff.json'), 'utf8'))).toEqual({
      issueId,
      changedFiles,
      targetedCommand,
      fullCommand,
      status: 'passed',
      verificationArtifact: 'verification.json'
    });
    expect(resumedEvents.some((event) => (event.type as string).includes('gc'))).toBe(false);

    const gcVisibleCalls = capture.toolCalls.filter((call) => call.gcApplied);
    expect(
      gcVisibleCalls.some(
        (call) =>
          (call.name === 'read' || call.name === 'exec') &&
          changedFiles.some((path) => JSON.stringify(call.arguments).includes(path))
      )
    ).toBe(false);
    expect(
      gcVisibleCalls.some(
        (call) =>
          call.name === 'apply_patch' &&
          changedFiles.some((path) =>
            JSON.stringify(call.arguments).includes(`*** Update File: ${path}`)
          )
      )
    ).toBe(false);
    expect(
      gcVisibleCalls.some(
        (call) =>
          call.name === 'exec' &&
          [targetedCommand, fullCommand].some((command) =>
            JSON.stringify(call.arguments).includes(command)
          )
      )
    ).toBe(false);
    const sourceReadCalls = capture.toolCalls.filter((call) => call.name === 'read');
    expect(sourceReadCalls).toHaveLength(moduleCount);
    expect(
      sourceReadCalls.flatMap((call) => {
        const arguments_ = isRecord(call.arguments) ? call.arguments : {};
        const reads = Array.isArray(arguments_.reads) ? arguments_.reads : [];
        expect(reads).toHaveLength(1);
        return reads.flatMap((read) =>
          isRecord(read) && typeof read.path === 'string' ? [read.path] : []
        );
      })
    ).toEqual(changedFiles);
    for (const path of changedFiles) {
      expect(
        capture.toolCalls.filter(
          (call) =>
            call.name === 'apply_patch' &&
            typeof call.arguments === 'string' &&
            call.arguments.split(`*** Update File: ${path}`).length - 1 === 1
        )
      ).toHaveLength(1);
    }
    expect(
      capture.toolCalls.filter(
        (call) =>
          call.name === 'exec' &&
          isRecord(call.arguments) &&
          call.arguments.command === targetedCommand
      )
    ).toHaveLength(1);
    expect(
      capture.toolCalls.filter(
        (call) =>
          call.name === 'exec' && isRecord(call.arguments) && call.arguments.command === fullCommand
      )
    ).toHaveLength(1);

    const reopenedStore = await JsonlSessionStore.open(home);
    const rawAfterResume = await reopenedStore.read(sessionId);
    expect(rawAfterResume.some((record) => record.type === 'context.gc.completed')).toBe(true);
    await reopenedStore.close();
    expect(
      (await readdir(join(home, '.mar', 'agent'), { recursive: true })).some((entry) =>
        String(entry).endsWith('.lock')
      )
    ).toBe(false);

    const runId = process.env.MAR_TEST_RUN_ID;
    if (runId && /^[\w-]+$/u.test(runId)) {
      const directory = resolve('../test/runs', runId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'context-gc-real.json'),
        `${JSON.stringify(
          {
            checkpointBase: checkpoint!.payload.base.type,
            checkpointGeneration: checkpoint!.payload.generation,
            checkpointStage: checkpoint!.payload.metrics.stage,
            contextWindowTokens,
            gcStartTokens,
            compactThresholdTokens,
            triggerContextInputTokens: checkpoint!.payload.trigger.contextInputTokens,
            reclaimedTokens: checkpoint!.payload.metrics.reclaimedTokens,
            grossReductionRate: checkpoint!.payload.metrics.grossReductionRate,
            requiredPositiveNetRollouts: checkpoint!.payload.metrics.requiredPositiveNetRollouts,
            requiredTargetRoiRollouts: checkpoint!.payload.metrics.requiredTargetRoiRollouts,
            cacheInvestmentRoi: checkpoint!.payload.metrics.cacheInvestmentRoi,
            projectedRequestTokens: firstGcRequest!.estimatedInputTokens,
            projectedCounterfactualTokens,
            providerContextInputTokens,
            providerCacheReadTokens: firstGcRequest!.originalUsage?.cacheReadTokens ?? null,
            interRequestContextInputDelta,
            interRequestContextInputDeltaRate:
              interRequestContextInputDelta === null
                ? null
                : interRequestContextInputDelta / checkpoint!.payload.trigger.contextInputTokens,
            controlledUsageProjection: false,
            sourceFileCount: changedFiles.length,
            sourceReadCalls: sourceReadCalls.length,
            initialModelRequests: capture.requests.filter((request) => request.phase === 'initial')
              .length,
            resumedModelRequests: capture.requests.filter((request) => request.phase === 'resumed')
              .length,
            gcVisibleToolCalls: gcVisibleCalls.map((call) => call.name),
            repeatedSourceReads: 0,
            repeatedSourcePatches: 0,
            repeatedVerificationCommands: 0
          },
          null,
          2
        )}\n`
      );
    }
  }, 1_200_000);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
