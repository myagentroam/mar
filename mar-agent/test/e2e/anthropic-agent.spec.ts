import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import {
  parseModelCatalog,
  type ExecutionHandle,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../src/index.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { type ModelAdapter, type ModelRequest } from '../../src/model/contracts.js';
import { createE2eWebExtensions } from '../support/web-fetch.js';

const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const searxngUrl = process.env.MAR_AGENT_E2E_SEARXNG_URL;
const directories: string[] = [];
const loadCatalog = async () =>
  parseModelCatalog(JSON.parse(await readFile('.e2e/models.local.json', 'utf8')));
async function finish(handle: ExecutionHandle) {
  const events: AgentEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, result: await handle.result() };
}
function latestTodoItems(events: readonly AgentEvent[]) {
  return events.findLast((event) => event.type === 'todo.updated')?.items;
}
function captureRequests(model: AgentModelConfiguration, requests: ModelRequest[]): ModelAdapter {
  const delegate = new AnthropicMessagesAdapter(model);
  return {
    configuration: model,
    async *start(request, signal) {
      requests.push(request);
      yield* delegate.start(request, signal);
    }
  };
}

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(enabled)('Anthropic-compatible Agent E2E', () => {
  it.runIf(Boolean(searxngUrl))(
    'uses self-hosted web search and client-side web fetch',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'mar-agent-anthropic-web-'));
      directories.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const catalog = await loadCatalog();
      const model = catalog.models.find((candidate) => candidate.id === 'coding')!;
      expect(model.hostedWebSearch).toBe(false);
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: home,
          workspace,
          extensions: createE2eWebExtensions(searxngUrl)
        }),
        models: [model],
        defaultModelId: model.id
      });
      try {
        const session = await agent.createSession({ workspace });
        const execution = await finish(
          session.run({
            prompt:
              'Use web_search to find the official OpenAI Responses API web search documentation. Then you must call web_fetch with mode http for https://developers.openai.com/api/docs/guides/tools-web-search and report one concrete detail from the fetched page.',
            modelId: model.id
          })
        );
        expect(execution.result, execution.result.errorCode).toMatchObject({ status: 'completed' });
        expect(execution.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool.completed', toolName: 'web_search' }),
            expect.objectContaining({ type: 'tool.completed', toolName: 'web_fetch' })
          ])
        );
      } finally {
        await agent.dispose();
      }
    },
    240_000
  );

  it.each(['coding', 'coding-flash'])(
    'completes a text turn with %s',
    async (modelId) => {
      const root = await mkdtemp(join(tmpdir(), `mar-agent-${modelId}-`));
      directories.push(root);
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const catalog = await loadCatalog();
      const model = catalog.models.find((candidate) => candidate.id === modelId)!;
      const requests: ModelRequest[] = [];
      const adapter = captureRequests(model, requests);
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model],
          defaultModelId: modelId
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({
          workspace,
          title: `${modelId} text turn`
        });
        const result = await session
          .run({ prompt: 'Reply with exactly: MAR_AGENT_OK', modelId })
          .result();
        expect(result.errorCode).toBeUndefined();
        expect(result).toMatchObject({ status: 'completed' });
        expect(result.finalAnswer).toContain('MAR_AGENT_OK');
        if (modelId === 'coding') {
          const compact = await finish(
            session.compact({ prompt: 'Preserve the completed text turn.' })
          );
          expect(compact.result, compact.result.errorCode).toMatchObject({ status: 'completed' });
          const compactRequest = requests.findLast((request) => request.toolChoice === 'none');
          expect(compactRequest).toBeDefined();
          expect(compactRequest?.tools.map((tool) => tool.name)).toContain('read');
          expect(compactRequest?.toolChoice).toBe('none');
          expect(
            requests.some(
              (request) => request.toolChoice !== 'none' && request.allowTools === undefined
            )
          ).toBe(true);
        }
      } finally {
        await agent.dispose();
      }
    },
    120_000
  );

  it('uses read and apply_patch in an isolated workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-tools-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'note.txt'), 'before\n');
    const catalog = await loadCatalog();
    const model = catalog.models.find((candidate) => candidate.id === 'coding')!;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace
      }),
      models: [model]
    });
    try {
      const session = await agent.createSession({ workspace });
      const result = await session
        .run({
          prompt:
            'Read note.txt, change its only line from before to after using apply_patch, then report completion.'
        })
        .result();
      expect(result.errorCode).toBeUndefined();
      expect(result).toMatchObject({ status: 'completed' });
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('after\n');
    } finally {
      await agent.dispose();
    }
  }, 60_000);

  it('replaces completed Todo items for an unrelated objective and preserves them for continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-todo-objectives-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'sample.ts'), 'export const value = 1;\n');
    const catalog = await loadCatalog();
    const model = catalog.models.find((candidate) => candidate.id === 'coding')!;
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [model],
      defaultModelId: model.id
    });
    try {
      const session = await agent.createSession({ workspace });
      const previous = await finish(
        session.run({
          prompt:
            'Use todo_write to replace the Todo with exactly two completed items whose IDs are old-analysis and old-verification. Do not use other tools. Then reply OLD_TODO_READY.',
          modelId: model.id
        })
      );
      expect(previous.result, previous.result.errorCode).toMatchObject({ status: 'completed' });
      expect(latestTodoItems(previous.events)?.map((item) => item.id)).toEqual([
        'old-analysis',
        'old-verification'
      ]);

      const unrelated = await finish(
        session.run({
          prompt:
            'Start a completely different multi-stage objective: inspect sample.ts, verify its exported value, and report the result. Use Todo to track this new objective before reading the file.',
          modelId: model.id
        })
      );
      expect(unrelated.result, unrelated.result.errorCode).toMatchObject({ status: 'completed' });
      const unrelatedIds = latestTodoItems(unrelated.events)?.map((item) => item.id) ?? [];
      expect(unrelatedIds.length).toBeGreaterThan(1);
      expect(unrelatedIds).not.toContain('old-analysis');
      expect(unrelatedIds).not.toContain('old-verification');
      expect(unrelated.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool.completed', toolName: 'read' })
        ])
      );

      const continuation = await finish(
        session.run({
          prompt:
            'Continue the same sample.ts objective by adding a final verification step. Update the existing Todo, preserve every current Todo ID, and then complete the verification.',
          modelId: model.id
        })
      );
      expect(continuation.result, continuation.result.errorCode).toMatchObject({
        status: 'completed'
      });
      const continuationIds = latestTodoItems(continuation.events)?.map((item) => item.id) ?? [];
      expect(continuationIds.length).toBeGreaterThan(unrelatedIds.length);
      expect(continuationIds).toEqual(expect.arrayContaining(unrelatedIds));
    } finally {
      await agent.dispose();
    }
  }, 180_000);

  it('completes workflow modes, interaction, resume, cancellation and subagent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-workflows-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'sample.ts'), 'export const value = 1;\n');
    const catalog = await loadCatalog();
    const model = catalog.models.find((candidate) => candidate.id === 'coding')!;
    const create = () =>
      createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: home,
          workspace,
          question: async (request) =>
            Object.fromEntries(
              request.questions.map((question) => [
                question.id,
                question.options[0]?.label ?? 'Use the recommended option'
              ])
            )
        }),
        models: [model]
      });
    let agent = await create();
    const session = await agent.createSession({ workspace });
    const todo = await finish(
      session.run({
        prompt: 'Use todo_write to create one completed item, then reply TODO_OK.'
      })
    );
    expect(todo.result.errorCode).toBeUndefined();
    expect(todo.result).toMatchObject({ status: 'completed' });
    expect(todo.events.some((event) => event.type === 'todo.updated')).toBe(true);
    const plan = await finish(
      session.plan({
        prompt:
          'Inspect sample.ts and produce a decision-complete implementation plan for adding a public update API. The product owner has not decided whether negative values should be rejected or clamped to zero, and the workspace contains no policy that resolves this product behavior.'
      })
    );
    expect(plan.result).toMatchObject({ status: 'completed' });
    expect(plan.events.some((event) => event.type === 'user_input.requested')).toBe(true);
    expect(plan.events.some((event) => event.type === 'user_input.resolved')).toBe(true);
    expect(plan.events.some((event) => event.type === 'plan.completed')).toBe(true);
    const delegated = await finish(
      session.run({
        prompt:
          'Use task with role explore to have a subagent read sample.ts, then summarize its result.'
      })
    );
    expect(delegated.result.status).toBe('completed');
    expect(delegated.events.some((event) => event.type === 'subagent.completed')).toBe(true);
    expect(
      (await finish(session.run({ prompt: 'Remember the codeword ORBIT-731.' }))).result.status
    ).toBe('completed');
    expect((await finish(session.compact())).result.status).toBe('completed');
    const sessionId = session.id;
    await agent.dispose();
    agent = await create();
    const resumed = await agent.openSession(sessionId);
    const recalled = await finish(
      resumed.run({ prompt: 'What codeword did I ask you to remember?' })
    );
    expect(recalled.result.finalAnswer).toContain('ORBIT-731');
    const cancellation = resumed.run({
      prompt: 'Write a very long essay with at least 5000 words.'
    });
    cancellation.cancel();
    expect((await cancellation.result()).status).toBe('cancelled');
    await agent.dispose();
  }, 300_000);
});
