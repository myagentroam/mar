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
const issueId = 'CATALOG-842';
const contextWindowTokens = 64_000;
const gcStartTokens = contextWindowTokens / 2;
const compactThresholdTokens = contextWindowTokens * 0.85;
const moduleCount = 6;
const sourceMarker = 'CM_SOURCE_MARKER_CATALOG_842';
const sourceFiles = Array.from(
  { length: moduleCount },
  (_, index) => `src/catalog/region-${String(index + 1).padStart(2, '0')}.js`
);
const targetedCommand = 'node --test test/catalog.test.js';
const fullCommand = 'npm test';

interface RequestCapture {
  readonly phase: 'initial' | 'resumed';
  readonly ordinal: number;
  readonly gcApplied: boolean;
  readonly containsSourceMarker: boolean;
  readonly containsCodeInputReplacement: boolean;
  readonly containsCodeOutputReplacement: boolean;
  readonly pairedCodeModeReplacement: boolean;
  readonly estimatedInputTokens: number;
  originalUsage?: ModelUsage;
}

interface DirectToolCall {
  readonly phase: RequestCapture['phase'];
  readonly requestOrdinal: number;
  readonly gcApplied: boolean;
  readonly name: string;
  readonly arguments: unknown;
}

interface Capture {
  readonly requests: RequestCapture[];
  readonly directToolCalls: DirectToolCall[];
}

interface CompletedRun {
  readonly events: AgentEvent[];
  readonly result: Awaited<ReturnType<ExecutionHandle['result']>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function finish(handle: ExecutionHandle, timeoutMs = 480_000): Promise<CompletedRun> {
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
      const codeModeCalls = request.messages.filter(
        (message) => message.role === 'tool_call' && message.name === 'code_exec'
      );
      const codeModeInputs = JSON.stringify(codeModeCalls.map((message) => message.arguments));
      const replacedCodeModeCallIds = new Set(
        codeModeCalls
          .filter((message) =>
            JSON.stringify(message.arguments).includes('completed_code_mode_input')
          )
          .map((message) => message.callId)
      );
      const pairedCodeModeReplacement = request.messages.some(
        (message) =>
          message.role === 'tool' &&
          replacedCodeModeCallIds.has(message.callId) &&
          message.content.includes(
            'Detailed Code Mode output was reclaimed after the protection period.'
          )
      );
      const gcApplied = serializedMessages.includes('<mar_context_gc kind=');
      const requestCapture: RequestCapture = {
        phase,
        ordinal,
        gcApplied,
        containsSourceMarker: codeModeInputs.includes(sourceMarker),
        containsCodeInputReplacement: serializedMessages.includes(
          '<mar_context_gc kind=\\"completed_code_mode_input\\"'
        ),
        containsCodeOutputReplacement: serializedMessages.includes(
          'Detailed Code Mode output was reclaimed after the protection period.'
        ),
        pairedCodeModeReplacement,
        estimatedInputTokens: estimatedRequestTokens(request, model)
      };
      capture.requests.push(requestCapture);
      for await (const event of turn.start(request, signal)) {
        if (event.type === 'client_tool.call')
          capture.directToolCalls.push({
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

function functionName(index: number): string {
  return `calculateRegion${String(index + 1).padStart(2, '0')}NetCents`;
}

function auditLine(moduleIndex: number, lineIndex: number): string {
  const moduleOrdinal = String(moduleIndex + 1).padStart(2, '0');
  const lineOrdinal = String(lineIndex + 1).padStart(3, '0');
  return `// CATALOG-AUDIT-${moduleOrdinal}-${lineOrdinal}: preserve immutable regional pricing evidence for ${issueId}; subtotal cents and basis points remain integer-safe; this unique record must remain byte-for-byte unchanged.`;
}

async function createFixture(workspace: string) {
  await mkdir(join(workspace, 'src', 'catalog'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspace, 'package.json'),
      `${JSON.stringify(
        {
          name: 'catalog-pricing-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' }
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(workspace, 'AGENTS.md'),
      [
        '# Fixture rules',
        '',
        '- Inspect every affected source module completely before editing.',
        '- Preserve every CATALOG-AUDIT line byte-for-byte and keep all public exports.',
        '- Use the smallest source-only fix.',
        `- Run \`${targetedCommand}\` before \`${fullCommand}\`.`,
        '- Create verification.json only after both commands pass.',
        '- Do not commit, access the network, or modify tests.'
      ].join('\n')
    ),
    ...sourceFiles.map((path, index) =>
      writeFile(
        join(workspace, path),
        [
          `export function ${functionName(index)}(subtotalCents, rateBasisPoints) {`,
          '  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) throw new TypeError("invalid subtotal");',
          '  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) throw new TypeError("invalid rate");',
          '  return subtotalCents - Math.round((subtotalCents * rateBasisPoints) / 100);',
          '}',
          '',
          ...Array.from({ length: 80 }, (_, lineIndex) => auditLine(index, lineIndex)),
          ''
        ].join('\n')
      )
    ),
    writeFile(
      join(workspace, 'test', 'catalog.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        ...sourceFiles.map((path, index) => `import { ${functionName(index)} } from '../${path}';`),
        '',
        `const calculators = [${sourceFiles.map((_, index) => functionName(index)).join(', ')}];`,
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

function startedTools(events: readonly AgentEvent[]): Array<{ name: string; input: unknown }> {
  return events.flatMap((event) =>
    event.type === 'tool.started' ? [{ name: event.toolName, input: event.input }] : []
  );
}

function commandCalls(calls: readonly { name: string; input: unknown }[], command: string): number {
  return calls.filter(
    (call) => call.name === 'exec' && isRecord(call.input) && call.input.command === command
  ).length;
}

function continuationEvidence(index: number): string {
  return Array.from(
    { length: 320 },
    (_, item) =>
      `AUDIT-CONTINUATION-${String(index + 1).padStart(2, '0')}-${String(item + 1).padStart(3, '0')}`
  ).join(' ');
}

afterAll(async () => {
  if (retainFixture) return;
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(enabled)('Code Mode and Context GC real long-flow E2E', () => {
  it('completes a composed development task, reclaims Code Mode history, and resumes without replay', async () => {
    const startedAt = Date.now();
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-code-mode-context-gc-real-'));
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
      hostedWebSearch: false,
      codeMode: true
    };
    const capture: Capture = { requests: [], directToolCalls: [] };
    const initialEvents: AgentEvent[] = [];
    let sessionId = '';
    let checkpoint: NonNullable<ReturnType<typeof parseContextGcCheckpoint>> | undefined;
    let rawBeforeResume: Awaited<ReturnType<JsonlSessionStore['read']>> = [];

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
        title: 'Catalog pricing repair with composed tools'
      });
      sessionId = session.id;
      const prepared = await finish(
        session.run({ prompt: 'A development task will follow. Reply ready without using tools.' })
      );
      initialEvents.push(...prepared.events);
      expect(prepared.result.status).toBe('completed');
      const compacted = await finish(session.compact());
      initialEvents.push(...compacted.events);
      expect(compacted.result.status).toBe('completed');

      const diagnosed = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            `Begin the diagnosis phase for issue ${issueId} in this isolated package without committing or external access.`,
            `The affected modules are exactly ${JSON.stringify(sourceFiles)}.`,
            'Use exactly one successful Code Mode cell for this phase and generate its JavaScript yourself.',
            'Read every affected module completely with independent tools.read calls inside Promise.all. Do not inspect source with direct read, exec, rg, or cat.',
            'Use result.data.results[0].text as each source string. Confirm each source contains its CATALOG-AUDIT prefix and the same suspicious calculation; do not parse the numbered display in result.content.',
            'Save only a bounded summary in state under key catalog842: issueId, sourceFiles, suspected expression, replacement expression, per-file audit-line counts, and status=diagnosed. Do not put complete source text in state.',
            `The cell source must contain the literal marker ${sourceMarker}. Emit one observe.text object containing phase=diagnosis, status=diagnosed, and evidence entries with each path and its complete source text. The test, not the cell, measures the real output size.`,
            'Do not patch files or run tests in this phase. Finish by reporting only that diagnosis state was established.'
          ].join('\n')
        })
      );
      initialEvents.push(...diagnosed.events);
      expect(diagnosed.result, diagnosed.result.errorCode).toMatchObject({ status: 'completed' });

      const repaired = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            `Continue issue ${issueId} with the repair phase.`,
            'Use one Code Mode cell. Read the bounded catalog842 diagnosis from state and validate its status and exact source file list.',
            'Apply the smallest correct source-only patch across all diagnosed modules with tools.apply_patch. Preserve every audit line and public export; do not modify tests.',
            `After patching, run only the targeted command ${targetedCommand} inside the same cell and require exitCode 0.`,
            'Update catalog842 state to status=targeted-passed while retaining the established exact facts. Emit a compact repair summary.',
            'Do not run the full test or create verification artifacts in this phase.'
          ].join('\n')
        })
      );
      initialEvents.push(...repaired.events);
      expect(repaired.result, repaired.result.errorCode).toMatchObject({ status: 'completed' });

      const verified = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            `Complete issue ${issueId} with the independent verification phase.`,
            'Use one Code Mode cell and read catalog842 from state. Require status=targeted-passed.',
            `Run ${fullCommand} and require exitCode 0.`,
            'Then use tools.apply_patch to create verification.json with exactly these fields:',
            JSON.stringify({
              issueId,
              sourceFiles,
              targetedCommand,
              fullCommand,
              status: 'passed'
            }),
            'Update catalog842 to status=passed and include verificationArtifact=verification.json. Emit a compact final verification summary.',
            'Finish with an accurate concise result without rereading source.'
          ].join('\n')
        })
      );
      initialEvents.push(...verified.events);
      expect(verified.result, verified.result.errorCode).toMatchObject({ status: 'completed' });

      for (const path of sourceFiles)
        expect(await readFile(join(workspace, path), 'utf8')).toContain('/ 10000)');
      expect(JSON.parse(await readFile(join(workspace, 'verification.json'), 'utf8'))).toEqual({
        issueId,
        sourceFiles,
        targetedCommand,
        fullCommand,
        status: 'passed'
      });

      for (let continuation = 0; continuation < 12; continuation++) {
        const store = await JsonlSessionStore.open(home);
        rawBeforeResume = await store.read(sessionId);
        checkpoint = rawBeforeResume
          .map((record) => parseContextGcCheckpoint(record))
          .filter((payload): payload is NonNullable<typeof payload> => payload !== undefined)
          .findLast((payload) => {
            const input = payload.replacements.find(
              (replacement) =>
                replacement.kind === 'TOOL_CALL_INPUT' && replacement.toolName === 'code_exec'
            );
            return (
              input !== undefined &&
              payload.replacements.some(
                (replacement) =>
                  replacement.kind === 'CODE_MODE_OUTPUT' && replacement.callId === input.callId
              )
            );
          });
        await store.close();
        if (checkpoint) break;
        const continued = await finish(
          session.run({
            modelId: model.id,
            reasoningEffort: 'high',
            prompt: [
              'Without tools, reply with only the issue id and completed status retained from the task.',
              `This bounded unique audit ledger belongs to continuation ${continuation + 1}; do not reproduce it in the answer:`,
              continuationEvidence(continuation)
            ].join('\n')
          })
        );
        initialEvents.push(...continued.events);
        expect(continued.result.status).toBe('completed');
      }
      if (checkpoint) {
        const projected = await finish(
          session.run({
            modelId: model.id,
            reasoningEffort: 'high',
            prompt:
              'Without tools, confirm only that the completed issue remains retained after context maintenance.'
          })
        );
        initialEvents.push(...projected.events);
        expect(projected.result.status).toBe('completed');
      }
    } finally {
      await initialAgent.dispose();
    }

    expect(checkpoint).toBeDefined();
    const store = await JsonlSessionStore.open(home);
    rawBeforeResume = await store.read(sessionId);
    const state = await store.readExecutionState(sessionId);
    expect(buildContextProjection(state.contextRecords).checkpoint?.checkpointId).toBe(
      checkpoint!.checkpointId
    );
    await store.close();

    expect(checkpoint!.trigger.contextWindowTokens).toBe(contextWindowTokens);
    expect(checkpoint!.trigger.contextInputTokens).toBeGreaterThanOrEqual(gcStartTokens);
    expect(checkpoint!.trigger.contextInputTokens).toBeLessThan(compactThresholdTokens);
    expect(checkpoint!.metrics.reclaimedTokens).toBeGreaterThan(4_096);
    expect(checkpoint!.metrics.grossReductionRate).toBeGreaterThan(0);
    expect(checkpoint!.replacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'TOOL_CALL_INPUT', toolName: 'code_exec' }),
        expect.objectContaining({ kind: 'CODE_MODE_OUTPUT' })
      ])
    );
    const rawJson = JSON.stringify(rawBeforeResume);
    expect(rawJson).toContain(sourceMarker);
    const diagnosticCall = rawBeforeResume.find((record) => {
      if (record.type !== 'model.context' || !isRecord(record.payload)) return false;
      return (
        record.payload.role === 'tool_call' &&
        record.payload.name === 'code_exec' &&
        JSON.stringify(record.payload.arguments).includes(sourceMarker)
      );
    });
    expect(diagnosticCall).toBeDefined();
    const diagnosticCallId =
      diagnosticCall && isRecord(diagnosticCall.payload)
        ? diagnosticCall.payload.callId
        : undefined;
    expect(typeof diagnosticCallId).toBe('string');
    expect(
      checkpoint!.replacements.find(
        (replacement) =>
          replacement.kind === 'TOOL_CALL_INPUT' &&
          replacement.toolName === 'code_exec' &&
          replacement.callId === diagnosticCallId
      )
    ).toBeDefined();
    expect(
      checkpoint!.replacements.find(
        (replacement) =>
          replacement.kind === 'CODE_MODE_OUTPUT' && replacement.callId === diagnosticCallId
      )
    ).toBeDefined();
    const diagnosticResult = rawBeforeResume.find(
      (record) =>
        record.type === 'model.context' &&
        isRecord(record.payload) &&
        record.payload.role === 'tool' &&
        record.payload.callId === diagnosticCallId
    );
    expect(diagnosticResult).toBeDefined();
    const diagnosticOutput =
      diagnosticResult && isRecord(diagnosticResult.payload)
        ? diagnosticResult.payload.content
        : undefined;
    expect(typeof diagnosticOutput).toBe('string');
    expect((diagnosticOutput as string).length).toBeGreaterThan(16_000);

    const firstGcRequest = capture.requests.find(
      (request) =>
        request.gcApplied &&
        request.containsCodeInputReplacement &&
        request.containsCodeOutputReplacement &&
        request.pairedCodeModeReplacement
    );
    expect(firstGcRequest).toBeDefined();
    expect(firstGcRequest!.containsSourceMarker).toBe(false);
    const triggerRequest = capture.requests.findLast((request) => {
      const usage = request.originalUsage;
      return (
        request.ordinal < firstGcRequest!.ordinal &&
        (usage?.contextInputTokens ?? usage?.inputTokens) === checkpoint!.trigger.contextInputTokens
      );
    });
    expect(triggerRequest).toBeDefined();
    const providerContextInputTokens =
      firstGcRequest!.originalUsage?.contextInputTokens ??
      firstGcRequest!.originalUsage?.inputTokens ??
      null;
    expect(providerContextInputTokens).not.toBeNull();
    expect(providerContextInputTokens!).toBeLessThan(checkpoint!.trigger.contextInputTokens);

    const initialStarted = startedTools(initialEvents);
    const directCodeModeCalls = capture.directToolCalls.filter(
      (call) => call.phase === 'initial' && call.name === 'code_exec'
    );
    expect(directCodeModeCalls.length).toBeGreaterThanOrEqual(2);
    expect(initialStarted.filter((call) => call.name === 'read')).toHaveLength(moduleCount);
    expect(
      initialStarted.filter((call) => call.name === 'apply_patch').length
    ).toBeGreaterThanOrEqual(2);
    expect(commandCalls(initialStarted, targetedCommand)).toBe(1);
    expect(commandCalls(initialStarted, fullCommand)).toBe(1);

    const resumedEvents: AgentEvent[] = [];
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
      const resumed = await finish(
        session.run({
          modelId: model.id,
          reasoningEffort: 'high',
          prompt: [
            'Continue from restored state after Context GC.',
            'Do not read source files, call read/rg/cat, reopen modified files, repeat a source patch, or rerun either previously passed test command.',
            'Using only retained task state, create handoff.json with apply_patch. Include issueId, sourceFiles, targetedCommand, fullCommand, status, and verificationArtifact using the exact established values.',
            'After creating it, run only one new bounded command that parses handoff.json as JSON. If retained state is insufficient, stop as blocked rather than repeating work.'
          ].join('\n')
        })
      );
      resumedEvents.push(...resumed.events);
      expect(resumed.result, resumed.result.errorCode).toMatchObject({ status: 'completed' });
    } finally {
      await resumedAgent.dispose();
    }

    expect(JSON.parse(await readFile(join(workspace, 'handoff.json'), 'utf8'))).toEqual({
      issueId,
      sourceFiles,
      targetedCommand,
      fullCommand,
      status: 'passed',
      verificationArtifact: 'verification.json'
    });
    const resumedStarted = startedTools(resumedEvents);
    const repeatedSourceReads = resumedStarted.filter(
      (call) =>
        (call.name === 'read' || call.name === 'exec') &&
        sourceFiles.some((path) => JSON.stringify(call.input).includes(path))
    );
    const repeatedSourcePatches = resumedStarted.filter(
      (call) =>
        call.name === 'apply_patch' &&
        sourceFiles.some((path) => JSON.stringify(call.input).includes(path))
    );
    const repeatedVerificationCommands = resumedStarted.filter(
      (call) =>
        call.name === 'exec' &&
        [targetedCommand, fullCommand].some((command) =>
          JSON.stringify(call.input).includes(command)
        )
    );
    const handoffParseCalls = resumedStarted.filter(
      (call) =>
        call.name === 'exec' &&
        JSON.stringify(call.input).includes('handoff.json') &&
        !sourceFiles.some((path) => JSON.stringify(call.input).includes(path)) &&
        ![targetedCommand, fullCommand].some((command) =>
          JSON.stringify(call.input).includes(command)
        )
    );
    expect(repeatedSourceReads).toHaveLength(0);
    expect(repeatedSourcePatches).toHaveLength(0);
    expect(repeatedVerificationCommands).toHaveLength(0);
    expect(handoffParseCalls).toHaveLength(1);

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
        join(directory, 'code-mode-context-gc-real.json'),
        `${JSON.stringify(
          {
            modelId: model.id,
            reasoningEffort: 'high',
            contextWindowTokens,
            gcStartTokens,
            compactThresholdTokens,
            elapsedMs: Date.now() - startedAt,
            checkpointGeneration: checkpoint!.generation,
            triggerContextInputTokens: checkpoint!.trigger.contextInputTokens,
            reclaimedTokens: checkpoint!.metrics.reclaimedTokens,
            grossReductionRate: checkpoint!.metrics.grossReductionRate,
            requiredPositiveNetRollouts: checkpoint!.metrics.requiredPositiveNetRollouts,
            providerContextInputTokens,
            interRequestContextInputDelta:
              checkpoint!.trigger.contextInputTokens - providerContextInputTokens!,
            requests: capture.requests,
            directToolSequence: capture.directToolCalls.map((call) => call.name),
            runtimeToolSequence: [...initialStarted, ...resumedStarted].map((call) => call.name),
            directCodeModeCalls: directCodeModeCalls.length,
            nestedReadCalls: initialStarted.filter((call) => call.name === 'read').length,
            repeatedSourceReads: repeatedSourceReads.length,
            repeatedSourcePatches: repeatedSourcePatches.length,
            repeatedVerificationCommands: repeatedVerificationCommands.length,
            handoffParseCalls: handoffParseCalls.length,
            rawHistoryPreservedSourceMarker: rawJson.includes(sourceMarker),
            rawHistoryCodeModeOutputCharacters: (diagnosticOutput as string).length,
            projectedSourceMarkerRemoved: !firstGcRequest!.containsSourceMarker,
            restartContinuationPassed: true
          },
          null,
          2
        )}\n`
      );
    }
  }, 1_200_000);
});
