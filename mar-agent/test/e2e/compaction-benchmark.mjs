import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LocalAgentHost, parseModelCatalog } from '../../dist/index.js';
import { OpenAiResponsesAdapter } from '../../dist/agent-core/model/openai-responses.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../dist/agent-core/sdk/agent.js';
import { countModelTokens } from '../../dist/agent-core/runtime/token-budget.js';
import { JsonlSessionStore } from '../../dist/agent-core/session/store/index.js';

const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--') arguments_.shift();
const { values } = parseArgs({
  args: arguments_,
  options: {
    session: { type: 'string' },
    'compact-sequence': { type: 'string' },
    out: { type: 'string' },
    'source-home': { type: 'string', default: homedir() },
    'source-workspace': { type: 'string' },
    'model-config': { type: 'string', default: '.e2e/models.local.json' },
    model: { type: 'string', default: 'gpt-5.6-luna' },
    'reasoning-effort': { type: 'string', default: 'high' },
    'warm-cache': { type: 'boolean', default: false }
  },
  strict: true
});

const sessionId = required(values.session, '--session');
const compactSequence = positiveInteger(values['compact-sequence'], '--compact-sequence');
const variant = 'standard';
const outputPath = resolve(required(values.out, '--out'));
const sourceHome = resolve(values['source-home']);
const sourceRoot = join(sourceHome, '.mar', 'agent');
const sourceIndex = JSON.parse(await readFile(join(sourceRoot, 'sessions', 'index.json'), 'utf8'));
const sourceMeta = sourceIndex.sessions.find((item) => item.id === sessionId);
if (!sourceMeta) throw new Error(`Source session not found: ${sessionId}`);

const sourceStore = await JsonlSessionStore.open(sourceHome);
let sourceRecords;
try {
  sourceRecords = await sourceStore.read(sessionId);
} finally {
  await sourceStore.close();
}
const compactRecord = sourceRecords.find(
  (record) => record.sequence === compactSequence && record.type === 'compact.completed'
);
if (!compactRecord) throw new Error('Reference compact checkpoint not found');
const referenceSummary = compactRecord.payload.summary;
const boundarySequence = compactRecord.payload.boundarySequence;

const root = await mkdtemp(join(tmpdir(), `mar-compaction-benchmark-${variant}-`));
const home = join(root, 'home');
const workspace = values['source-workspace']
  ? resolve(values['source-workspace'])
  : join(root, 'workspace');
let agent;
try {
  await mkdir(join(home, '.mar', 'agent', 'sessions'), { recursive: true });
  if (!values['source-workspace']) {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'README.md'), '# Isolated compaction benchmark workspace\n');
  }
  const copiedSessionDirectory = join(home, '.mar', 'agent', 'sessions', sessionId);
  await cp(join(sourceRoot, 'sessions', sessionId), copiedSessionDirectory, { recursive: true });
  await rm(join(copiedSessionDirectory, 'lock'), { force: true });
  for (const fileName of await readdir(copiedSessionDirectory)) {
    if (!/^events-\d+\.jsonl$/u.test(fileName)) continue;
    const path = join(copiedSessionDirectory, fileName);
    const retained = (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .filter((line) => JSON.parse(line).sequence <= boundarySequence);
    if (retained.length === 0) await rm(path);
    else await writeFile(path, `${retained.join('\n')}\n`);
  }
  const copiedMeta = { ...sourceMeta, nextSequence: boundarySequence + 1 };
  delete copiedMeta.resume;
  delete copiedMeta.segments;
  await writeFile(
    join(home, '.mar', 'agent', 'sessions', 'index.json'),
    `${JSON.stringify({ version: 1, revision: 1, sessions: [copiedMeta] })}\n`
  );

  const catalog = parseModelCatalog(
    JSON.parse(await readFile(resolve(values['model-config']), 'utf8'))
  );
  const configured = catalog.models.find((model) => model.id === values.model);
  if (!configured) throw new Error(`Benchmark model not found: ${values.model}`);
  const model = {
    ...configured,
    hostedWebSearch: false,
    maxOutputTokens: Math.min(configured.maxOutputTokens, 10_240)
  };

  let capturedRequest;
  const captureAdapter = {
    configuration: model,
    async *start(request) {
      capturedRequest = request;
      yield { type: 'text.completed', itemId: 'captured-summary', text: 'Captured request.' };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 1,
          contextInputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        }
      };
      yield { type: 'completed', reason: 'completed' };
    },
    close() {}
  };
  agent = await createMarAgent({
    mode: 'normal',
    host: new LocalAgentHost({
      homeDirectory: home,
      workspace,
      environment: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8' },
      restrictPaths: true
    }),
    models: [model],
    defaultModelId: model.id,
    adapterFactory: () => captureAdapter
  });
  const compactResult = await (
    await agent.openSession(sessionId)
  )
    .compact({ reasoningEffort: values['reasoning-effort'] })
    .result();
  if (compactResult.status !== 'completed' || !capturedRequest)
    throw new Error(`Unable to capture compact request: ${compactResult.errorCode ?? 'unknown'}`);
  await agent.dispose();
  agent = undefined;

  const request = capturedRequest;
  let warm;
  if (values['warm-cache']) {
    const cacheKey = `${sessionId}-compaction-benchmark-${Date.now()}`;
    request.promptCacheKey = cacheKey;
    const warmRequest = {
      ...request,
      messages: [
        ...request.messages.slice(0, -1),
        {
          role: 'user',
          content:
            'Cache warm-up only. Return a brief acknowledgement without calling any available tool.'
        }
      ],
      toolChoice: 'auto'
    };
    const warmAdapter = new OpenAiResponsesAdapter(model);
    let warmUsage;
    const warmStarted = Date.now();
    try {
      for await (const event of warmAdapter.start(warmRequest, new AbortController().signal))
        if (event.type === 'usage') warmUsage = event.usage;
    } finally {
      await warmAdapter.close();
    }
    warm = {
      durationMs: Date.now() - warmStarted,
      providerInputTokens: warmUsage?.contextInputTokens ?? warmUsage?.inputTokens ?? null,
      cacheReadTokens: warmUsage?.cacheReadTokens ?? null,
      cacheWriteTokens: warmUsage?.cacheWriteTokens ?? null
    };
  }
  const delegate = new OpenAiResponsesAdapter(model);
  let summary = '';
  let usage;
  const started = Date.now();
  try {
    for await (const event of delegate.start(request, new AbortController().signal)) {
      if (event.type === 'text.completed' && (event.phase ?? 'final_answer') === 'final_answer')
        summary = event.text.trim();
      if (event.type === 'usage') usage = event.usage;
    }
  } finally {
    await delegate.close();
  }
  if (!summary) throw new Error('Compaction summary missing');
  const durationMs = Date.now() - started;

  const judge = await judgeHandoff(model, referenceSummary, summary, values['reasoning-effort']);
  const promptText = [request.system, ...request.messages.map((message) => message.content)].join(
    '\n'
  );
  const evidence = request.messages
    .slice(0, -1)
    .map((message) => message.content)
    .join('\n');
  const result = {
    source: { sessionId, compactSequence, boundarySequence },
    configuration: {
      variant,
      modelId: model.id,
      reasoningEffort: values['reasoning-effort']
    },
    evidence: {
      sha256: createHash('sha256').update(evidence).digest('hex'),
      estimatedTokens: countModelTokens(evidence),
      characters: evidence.length,
      utf8Bytes: Buffer.byteLength(evidence)
    },
    compact: {
      inputEstimatedTokens: countModelTokens(promptText),
      providerInputTokens: usage?.contextInputTokens ?? usage?.inputTokens ?? null,
      providerOutputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      summaryEstimatedTokens: countModelTokens(summary),
      summaryCharacters: summary.length,
      summaryUtf8Bytes: Buffer.byteLength(summary),
      durationMs
    },
    ...(warm === undefined ? {} : { warm }),
    reference: {
      estimatedTokens: countModelTokens(referenceSummary),
      characters: referenceSummary.length,
      utf8Bytes: Buffer.byteLength(referenceSummary)
    },
    judge,
    summary
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        source: result.source,
        configuration: result.configuration,
        compact: result.compact,
        reference: result.reference,
        judge
      },
      null,
      2
    )
  );
} finally {
  await agent?.dispose();
  await rm(root, { recursive: true, force: true });
}

async function judgeHandoff(model, reference, candidate, reasoningEffort) {
  const adapter = new OpenAiResponsesAdapter(model);
  let text = '';
  try {
    for await (const event of adapter.start(
      {
        system: `Evaluate a structured state handoff for safe, accurate continuation. The reference is useful evidence, not an absolute checklist. Score the candidate on:
- objectiveFidelity: primary objective, current deliverable, completion criteria, and non-goals/boundaries;
- progressFidelity: completed, pending, active, blocked, and verified scope;
- boundaryFidelity: authorization, scope, safety, non-repeatable side effects, and exclusions;
- evidenceSufficiency: evidence that is necessary for later judgment or expensive to recover;
- continuationReadiness: ability to continue without material re-investigation or repeated side effects;
- exactness: exact identifiers and independent state axes;
- contradictionRisk: stale state as current, proposals promoted to facts, state-axis conflation, invented facts, or scope expansion; 0 is best.
Do not reward verbosity, matching language, or token reduction by itself. Return JSON only with those seven integer fields from 0 to 100 and arrays materialMissingFacts and contradictions.`,
        messages: [
          {
            role: 'user',
            content: `REFERENCE HANDOFF:\n${reference}\n\nCANDIDATE HANDOFF:\n${candidate}`
          }
        ],
        tools: [],
        allowTools: false,
        reasoningEffort
      },
      new AbortController().signal
    )) {
      if (event.type === 'text.completed' && (event.phase ?? 'final_answer') === 'final_answer')
        text = event.text.trim();
    }
  } finally {
    await adapter.close();
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Judge returned invalid JSON: ${text.slice(0, 500)}`);
  }
  return validateJudge(value);
}

function validateJudge(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Judge result must be an object');
  for (const key of [
    'objectiveFidelity',
    'progressFidelity',
    'boundaryFidelity',
    'evidenceSufficiency',
    'continuationReadiness',
    'exactness',
    'contradictionRisk'
  ]) {
    const score = value[key];
    if (!Number.isInteger(score) || score < 0 || score > 100)
      throw new Error(`Judge field ${key} must be an integer from 0 to 100`);
  }
  for (const key of ['materialMissingFacts', 'contradictions']) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== 'string'))
      throw new Error(`Judge field ${key} must be a string array`);
  }
  return value;
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(required(value, flag));
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
