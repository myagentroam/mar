import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost, parseModelCatalog } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { type ModelAdapter, type ModelRequest } from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { countModelTokens } from '../../src/agent-core/runtime/token-budget.js';

const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const expected = {
  taskId: 'PARSER-41',
  scope: 'src/parser.ts',
  report: 'report-v2.json',
  authorization: 'no_commit_no_push',
  completedMigration: 'migration-M17',
  repeatMigration: false,
  verifiedCommand: 'pnpm test:parser',
  passedTests: 19,
  integrationStatus: 'not_run',
  rejectedApproach: 'split-comma',
  backgroundTask: 'task-Q73',
  nextAction: 'run-integration'
};
const probe = [
  'Answer task status only from existing history. Do not read files, call tools, execute, or repeat any operation.',
  'Return one JSON object only, not Markdown. Use these fields; write null when genuinely unknown and do not guess:',
  'taskId (task identifier), scope (the only source path permitted to change), report (latest report filename),',
  'authorization (use no_commit_no_push when commit and push are both forbidden; otherwise use the actual authorization),',
  'completedMigration (completed migration identifier), repeatMigration (whether migration must be repeated, boolean),',
  'verifiedCommand (verification command already run), passedTests (number of passing tests),',
  'integrationStatus (not_run/passed/failed), rejectedApproach (identifier for the rejected approach),',
  'backgroundTask (ID of the still-running background task), nextAction (identifier of the next action).'
].join('\n');
const padded = (middle: string) =>
  `${'Historical background detail; no new decision. '.repeat(450)}\n${middle}\n${'Repeated background detail; no new decision. '.repeat(450)}`;

describe.runIf(enabled)('compaction retention real-model E2E', () => {
  for (const rounds of [1, 3]) {
    it(`preserves key task facts after ${rounds} compact checkpoint(s) and a restart`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-compact-retention-'));
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const catalog = parseModelCatalog(
        JSON.parse(await readFile('.e2e/models.local.json', 'utf8'))
      );
      const configured = catalog.models.find((model) => model.id === 'gpt-5.6-luna');
      if (!configured) throw new Error('MAR_AGENT_E2E_RESPONSES_MODEL_MISSING');
      const model = { ...configured, hostedWebSearch: false, maxOutputTokens: 4_096 };
      const requests: { compact: boolean; inputTokensEstimated: number; durationMs: number }[] = [];
      let modelCalls = 0;
      const factory = (): ModelAdapter => {
        const delegate = new OpenAiResponsesAdapter(model);
        return {
          configuration: model,
          async *start(request: ModelRequest, signal: AbortSignal) {
            if (++modelCalls > rounds + 1) throw new Error('MAR_AGENT_E2E_MODEL_CALL_LIMIT');
            const compact = request.toolChoice === 'none';
            if (compact) {
              expect(request.tools.map((tool) => tool.name)).toContain('read');
              expect(request.toolChoice).toBe('none');
            }
            const metric = {
              compact,
              inputTokensEstimated: countModelTokens(
                request.system + request.messages.map((message) => message.content).join('\n')
              ),
              durationMs: 0
            };
            requests.push(metric);
            const started = Date.now();
            try {
              for await (const event of delegate.start(request, signal)) {
                if (event.type === 'client_tool.call')
                  throw new Error('MAR_AGENT_E2E_UNEXPECTED_TOOL');
                yield event;
              }
            } finally {
              metric.durationMs = Date.now() - started;
            }
          },
          close: () => delegate.close()
        };
      };
      const create = () =>
        createMarAgent({
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          adapterFactory: factory
        });
      let agent: Awaited<ReturnType<typeof create>> | undefined;
      let store: JsonlSessionStore | undefined;
      try {
        store = await JsonlSessionStore.open(home);
        const session = await store.createSession({ workspace, title: 'Task retention fixture' });
        await store.append(session.id, {
          type: 'turn.user',
          payload: {
            prompt: padded(
              [
                'Current task ID PARSER-41: fix escaped-comma parsing; only src/parser.ts may be modified.',
                'Previous report filename: report-v1.json. Commit and push are forbidden; authorization is no_commit_no_push.'
              ].join('\n')
            )
          }
        });
        await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool_call',
            callId: 'fixture-evidence',
            name: 'exec',
            arguments: { action: 'start', command: 'pnpm test:parser' }
          }
        });
        await store.append(session.id, {
          type: 'model.context',
          payload: {
            role: 'tool',
            callId: 'fixture-evidence',
            content: padded(
              [
                'Confirmed execution evidence: migration-M17 completed successfully; do not repeat it.',
                'pnpm test:parser completed: 19 tests passed. Integration tests have NOT run.',
                'The approach split-comma was disproved by the escaped-comma regression.',
                'Background task task-Q73 is still running. The next action identifier is run-integration.'
              ].join('\n')
            )
          }
        });
        await store.append(session.id, {
          type: 'turn.user',
          payload: {
            prompt:
              'Correction: change the report filename to report-v2.json and do not use the old name. All other task boundaries and prohibitions remain unchanged.'
          }
        });
        await store.close();
        store = undefined;
        for (let round = 0; round < rounds; round++) {
          agent = await create();
          const active = await agent.openSession(session.id);
          const handle = active.compact({ reasoningEffort: 'high' });
          const timeout = setTimeout(() => handle.cancel(), 150_000);
          try {
            const result = await handle.result();
            expect(result.status, result.errorCode).toBe('completed');
          } finally {
            clearTimeout(timeout);
          }
          await agent.dispose();
          agent = undefined;
        }
        agent = await create();
        const active = await agent.openSession(session.id);
        const handle = active.run({ prompt: probe, reasoningEffort: 'high' });
        const timeout = setTimeout(() => handle.cancel(), 150_000);
        let answer: Record<string, unknown>;
        try {
          const result = await handle.result();
          expect(result.status, result.errorCode).toBe('completed');
          answer = JSON.parse(result.finalAnswer);
        } finally {
          clearTimeout(timeout);
        }
        const checks = Object.entries(expected).map(([key, value]) => ({
          key,
          passed: answer[key] === value
        }));
        const runId = process.env.MAR_TEST_RUN_ID;
        if (runId && /^[\w-]+$/.test(runId)) {
          const directory = resolve('../test/runs');
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, `${runId}-compact-${rounds}.json`),
            JSON.stringify(
              {
                modelId: model.id,
                reasoningEffort: 'high',
                rounds,
                passedFacts: checks.filter((check) => check.passed).length,
                totalFacts: checks.length,
                checks,
                requests
              },
              null,
              2
            )
          );
        }
        expect(checks.filter((check) => !check.passed)).toEqual([]);
        expect(modelCalls).toBe(rounds + 1);
      } finally {
        await agent?.dispose();
        await store?.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 650_000);
  }
});
