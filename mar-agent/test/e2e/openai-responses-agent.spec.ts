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
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { type ModelAdapter, type ModelRequest } from '../../src/model/contracts.js';
import { createE2eWebExtensions } from '../support/web-fetch.js';

const enabled = process.env.MAR_AGENT_REAL_E2E === '1';
const directories: string[] = [];
const loadModel = async () => {
  const catalog = parseModelCatalog(JSON.parse(await readFile('.e2e/models.local.json', 'utf8')));
  const model = catalog.models.find((candidate) => candidate.id === 'gpt-5.6-luna');
  if (!model) throw new Error('MAR_AGENT_E2E_RESPONSES_MODEL_MISSING');
  return model;
};
async function finish(handle: ExecutionHandle) {
  const events: AgentEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, result: await handle.result() };
}
const internalGuidancePattern =
  /\b(?:rollout budget|budget|thresholds?|remaining (?:amount|tokens?)|weighted tokens?)\b/iu;
function visibleText(events: readonly AgentEvent[]): string {
  return events
    .flatMap((event) =>
      event.type === 'message.delta' || event.type === 'message.completed'
        ? [event.type === 'message.delta' ? event.delta : event.text]
        : []
    )
    .join('\n');
}
function captureRequests(model: AgentModelConfiguration, requests: ModelRequest[]): ModelAdapter {
  const delegate = new OpenAiResponsesAdapter(model);
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

describe.runIf(enabled)('OpenAI Responses Agent E2E', () => {
  it('asks for unresolved user-owned product decisions before finalizing a Plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-plan-question-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await Promise.all([
      writeFile(
        join(workspace, 'README.md'),
        '# Draft service\n\nThis TypeScript service stores drafts in memory. It has no deletion or retention policy.\n'
      ),
      writeFile(
        join(workspace, 'src', 'draft-store.ts'),
        [
          'export interface Draft {',
          '  id: string;',
          '  body: string;',
          '}',
          '',
          'export class DraftStore {',
          '  readonly #drafts = new Map<string, Draft>();',
          '',
          '  save(draft: Draft) {',
          '    this.#drafts.set(draft.id, draft);',
          '  }',
          '',
          '  get(id: string) {',
          '    return this.#drafts.get(id);',
          '  }',
          '}',
          ''
        ].join('\n')
      )
    ]);
    const model = await loadModel();
    const requests: ModelRequest[] = [];
    const adapter = captureRequests(model, requests);
    const questions: { readonly question: string; readonly options: readonly unknown[] }[][] = [];
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({
          homeDirectory: home,
          workspace,
          question: async (request) => {
            questions.push(request.questions);
            return Object.fromEntries(
              request.questions.map((question) => [
                question.id,
                question.options[0]?.label ?? 'Use the recommended option'
              ])
            );
          }
        }),
        models: [model],
        defaultModelId: model.id
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace,
        title: 'Responses Plan question'
      });
      const plan = await finish(
        session.plan({
          prompt:
            'Plan a "delete draft" feature for this TypeScript draft service. The product has not decided whether deletion should permanently remove a draft or move it to a recoverable 30-day trash. Inspect the existing project first, then provide an implementation-ready plan.',
          modelId: model.id,
          reasoningEffort: 'high'
        })
      );

      expect(plan.result, plan.result.errorCode).toMatchObject({ status: 'completed' });
      expect(questions.length).toBeGreaterThanOrEqual(1);
      expect(questions.flat().length).toBeGreaterThanOrEqual(1);
      expect(questions.flat().every((question) => question.options.length >= 2)).toBe(true);
      expect(JSON.stringify(questions)).toMatch(/delete|deletion|permanent|trash/iu);
      expect(plan.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'user_input.requested' }),
          expect.objectContaining({ type: 'user_input.resolved' }),
          expect.objectContaining({ type: 'plan.completed' })
        ])
      );
      expect(
        requests.every((request) => request.tools.some((tool) => tool.name === 'question'))
      ).toBe(true);
    } finally {
      await agent.dispose();
    }
  }, 240_000);

  it('asks about an unresolved public packaging boundary instead of silently choosing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-plan-packaging-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await Promise.all([
      mkdir(join(workspace, 'packages', 'agent', 'src'), { recursive: true }),
      mkdir(join(workspace, 'packages', 'node', 'src'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(workspace, 'README.md'),
        [
          '# Agent workspace',
          '',
          '`packages/agent` contains the runtime, SDK, and optional infrastructure.',
          '`packages/node` currently owns a Linux sandbox executor.',
          'The repository does not define whether optional infrastructure uses package subpaths or separate packages.',
          ''
        ].join('\n')
      ),
      writeFile(
        join(workspace, 'packages', 'agent', 'package.json'),
        JSON.stringify(
          {
            name: '@example/agent',
            type: 'module',
            exports: { '.': './dist/index.js' }
          },
          null,
          2
        )
      ),
      writeFile(
        join(workspace, 'packages', 'node', 'src', 'linux-sandbox.ts'),
        'export class LinuxSandboxExecutor {}\n'
      )
    ]);
    const model = await loadModel();
    const questions: { readonly question: string; readonly options: readonly unknown[] }[][] = [];
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace,
        question: async (request) => {
          questions.push(request.questions);
          return Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              question.options[0]?.label ?? 'Use the recommended option'
            ])
          );
        }
      }),
      models: [model],
      defaultModelId: model.id
    });
    try {
      const session = await agent.createSession({
        workspace,
        title: 'Responses Plan packaging question'
      });
      const plan = await finish(
        session.plan({
          prompt:
            'Plan moving the Linux sandbox from the Node package into the Agent infrastructure domain without integrating it into the Agent runtime. External applications must be able to use the sandbox with or without the Agent. Inspect the project and produce an implementation-ready plan.',
          modelId: model.id,
          reasoningEffort: 'high'
        })
      );

      expect(plan.result, plan.result.errorCode).toMatchObject({ status: 'completed' });
      expect(questions.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(questions)).toMatch(/package|subpath|export|publish/iu);
      const completedPlan = plan.events.find((event) => event.type === 'plan.completed');
      expect(completedPlan).toBeDefined();
      if (completedPlan?.type !== 'plan.completed') throw new Error('PLAN_MISSING');
      expect(completedPlan.text).toMatch(/sandbox/iu);
      expect(completedPlan.text).toMatch(/runtime/iu);
      expect(completedPlan.text).toMatch(/verif|test/iu);
    } finally {
      await agent.dispose();
    }
  }, 240_000);

  it('uses the standard Responses path, client tools, and tool-free compact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'fact.txt'), 'LUNA_TOOL_OK\n');
    const model = await loadModel();
    const requests: ModelRequest[] = [];
    const adapter = captureRequests(model, requests);
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace,
        title: 'Responses tools and compact'
      });
      const execution = await finish(
        session.run({
          prompt:
            'Use the read tool to read fact.txt, then include its exact content in your answer.',
          modelId: model.id,
          reasoningEffort: 'high'
        })
      );
      expect(
        execution.result,
        `${execution.result.errorCode ?? ''}:${execution.events
          .filter((event) => event.type === 'tool.failed')
          .map((event) => (event.type === 'tool.failed' ? event.toolName : ''))
          .join(',')}`
      ).toMatchObject({ status: 'completed' });
      expect(execution.result.finalAnswer).toContain('LUNA_TOOL_OK');
      expect(execution.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool.completed', toolName: 'read' }),
          expect.objectContaining({ type: 'usage.updated' })
        ])
      );
      const compact = await finish(
        session.compact({ prompt: 'Preserve the verified LUNA_TOOL_OK fact.' })
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
    } finally {
      await agent.dispose();
    }
  }, 180_000);

  it('continues real model tool work without cumulative token finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-stage-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writeFile(join(workspace, 'marker.txt'), 'NATURAL_STAGE_OK\n'),
      writeFile(join(workspace, 'optional.txt'), 'OPTIONAL_EXPLORATION\n')
    ]);
    const model = await loadModel();
    const requests: ModelRequest[] = [];
    const adapter = captureRequests(model, requests);
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace,
        title: 'Natural staged completion'
      });
      const execution = await finish(
        session.run({
          prompt:
            'Use read only for marker.txt, then report its exact content and a concise summary. No other investigation is needed.',
          modelId: model.id,
          reasoningEffort: 'low'
        })
      );

      expect(execution.result, execution.result.errorCode).toMatchObject({
        status: 'completed'
      });
      expect(execution.result.finalAnswer).toContain('NATURAL_STAGE_OK');
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const request of requests) {
        expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
        expect(request.tools).toEqual(requests[0]?.tools);
        expect(request.allowTools).toBeUndefined();
      }
      expect(
        execution.events.filter(
          (event) => event.type === 'tool.completed' && event.toolName === 'read'
        )
      ).toHaveLength(1);
      expect(visibleText(execution.events)).not.toMatch(internalGuidancePattern);
    } finally {
      await agent.dispose();
    }
  }, 180_000);

  it('completes real parent and child tool work without cumulative token finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-subagent-stage-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'marker.txt'), 'SUBAGENT_STAGE_OK\n');
    const model = await loadModel();
    const requests: ModelRequest[] = [];
    const adapter = captureRequests(model, requests);
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model],
        defaultModelId: model.id
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({
        workspace,
        title: 'Subagent staged completion'
      });
      const execution = await finish(
        session.run({
          prompt:
            'Use agent_start with role explore and a prompt asking the subagent to read marker.txt and report its exact content. Do not read the file yourself. Use agent_wait to wait for completion, then provide the verified marker and a concise summary.',
          modelId: model.id,
          reasoningEffort: 'low'
        })
      );

      expect(execution.result, execution.result.errorCode).toMatchObject({
        status: 'completed'
      });
      const childRequests = requests.filter((request) =>
        JSON.stringify(request.messages).includes('You are a non-recursive subagent.')
      );
      const parentRequests = requests.filter(
        (request) => !JSON.stringify(request.messages).includes('You are a non-recursive subagent.')
      );
      expect(childRequests.length).toBeGreaterThanOrEqual(2);
      expect(parentRequests.length).toBeGreaterThanOrEqual(2);
      for (const group of [parentRequests, childRequests]) {
        expect(group[0]?.tools.length).toBeGreaterThan(0);
        for (const request of group) {
          expect(JSON.stringify(request.messages)).not.toContain('execution_guidance');
          expect(request.tools).toEqual(group[0]?.tools);
          expect(request.allowTools).toBeUndefined();
        }
      }
      expect(execution.result.finalAnswer).toContain('SUBAGENT_STAGE_OK');
      expect(execution.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'subagent.completed', status: 'completed' }),
          expect.objectContaining({ type: 'tool.completed', toolName: 'agent_start' })
        ])
      );
      expect(execution.result.finalAnswer.trim().length).toBeGreaterThan(0);
      expect(visibleText(execution.events)).not.toMatch(internalGuidancePattern);
    } finally {
      await agent.dispose();
    }
  }, 180_000);

  it('combines real hosted web search with Host-provided web fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-agent-responses-web-'));
    directories.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const model = await loadModel();
    expect(model.hostedWebSearch).toBe(true);
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({
        homeDirectory: home,
        workspace,
        extensions: createE2eWebExtensions()
      }),
      models: [model],
      defaultModelId: model.id
    });
    try {
      const session = await agent.createSession({ workspace });
      const execution = await finish(
        session.run({
          prompt:
            'Use hosted web search to find the official OpenAI Responses API web search documentation. Then you must call the client web_fetch tool with mode http for https://developers.openai.com/api/docs/guides/tools-web-search and report one concrete detail from the fetched page.',
          modelId: model.id,
          reasoningEffort: 'high'
        })
      );
      expect(execution.result, execution.result.errorCode).toMatchObject({ status: 'completed' });
      expect(execution.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool.completed',
            toolName: 'web_search'
          }),
          expect.objectContaining({
            type: 'tool.completed',
            toolName: 'web_fetch'
          })
        ])
      );
    } finally {
      await agent.dispose();
    }
  }, 240_000);
});
