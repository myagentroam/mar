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

  it('uses ordinary tools without exposing retired Todo tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-todo-retired-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'sample.ts'), 'export const value = 1;\n');
    const catalog = await loadCatalog();
    const model = catalog.models.find((candidate) => candidate.id === 'coding')!;
    const requests: ModelRequest[] = [];
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => captureRequests(model, requests)
    );
    try {
      const session = await agent.createSession({ workspace });
      const execution = await finish(
        session.run({
          prompt:
            'Use read to inspect sample.ts, verify its exported value, and report the result.',
          modelId: model.id
        })
      );
      expect(execution.result, execution.result.errorCode).toMatchObject({ status: 'completed' });
      expect(execution.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool.completed', toolName: 'read' })
        ])
      );
      expect(execution.events.some((event) => event.type === 'todo.updated')).toBe(false);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.tools.map((tool) => tool.name)).not.toContain('todo_read');
        expect(request.tools.map((tool) => tool.name)).not.toContain('todo_write');
      }
    } finally {
      await agent.dispose();
    }
  }, 60_000);

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
    const initial = await finish(
      session.run({
        prompt: 'Reply WORKFLOW_READY.'
      })
    );
    expect(initial.result.errorCode).toBeUndefined();
    expect(initial.result).toMatchObject({ status: 'completed' });
    expect(initial.events.some((event) => event.type === 'todo.updated')).toBe(false);
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
    const inspected = await finish(
      session.run({
        prompt: 'Use read to inspect sample.ts, then summarize its contents.'
      })
    );
    expect(inspected.result.status).toBe('completed');
    expect(
      inspected.events.some((event) => event.type === 'tool.completed' && event.toolName === 'read')
    ).toBe(true);
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
