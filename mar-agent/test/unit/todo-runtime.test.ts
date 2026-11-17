import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentEvent, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { Agent } from '../../src/sdk/types.js';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

type ModelScript = (
  request: ModelRequest,
  index: number,
  signal: AbortSignal
) => readonly ModelEvent[] | Promise<readonly ModelEvent[]>;

class FakeModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];

  constructor(
    readonly configuration: AgentModelConfiguration,
    private readonly script: ModelScript
  ) {}

  async *start(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.push(request) - 1;
    yield* await this.script(request, index, signal);
  }
}

const modelConfiguration = (codeMode = false): AgentModelConfiguration => ({
  id: 'todo-test',
  name: 'Todo test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test-key'),
  modelId: 'todo-test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  titleGeneration: false,
  codeMode,
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
});

const roots: string[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function toolCall(name: string, callId: string, args: unknown): readonly ModelEvent[] {
  return [
    { type: 'client_tool.call', name, callId, arguments: args },
    { type: 'completed', reason: 'tool_use' }
  ];
}

const answer = (): readonly ModelEvent[] => [
  { type: 'text.completed', itemId: 'answer', text: 'done' },
  { type: 'completed', reason: 'completed' }
];

async function createFixture(script: ModelScript, codeMode = false) {
  const home = await mkdtemp(join(tmpdir(), 'mar-agent-todo-runtime-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const configuration = modelConfiguration(codeMode);
  const adapter = new FakeModelAdapter(configuration, script);
  const agent = await createAgent(home, workspace, adapter);
  const session = await agent.createSession({ workspace, title: 'Todo runtime' });
  return { home, workspace, configuration, adapter, agent, session };
}

async function createAgent(
  home: string,
  workspace: string,
  adapter: FakeModelAdapter
): Promise<Agent> {
  const agent = await createAgentWithAdapter(
    {
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [adapter.configuration]
    },
    () => adapter
  );
  agents.push(agent);
  return agent;
}

function toolResult(request: ModelRequest, callId: string) {
  return request.messages.find((message) => message.role === 'tool' && message.callId === callId);
}

function expectTodoTool(request: ModelRequest) {
  const names = request.tools.map((tool) => tool.name);
  expect(names).toContain('todo');
  expect(names).not.toContain('todo_read');
  expect(names).not.toContain('todo_write');
}

describe('SDK todo runtime', () => {
  it.each([false, true])(
    'applies input compatibility before Todo validation (Code Mode=%s)',
    async (codeMode) => {
      const items = [{ id: 'verify', step: 'Verify the change', status: 'pending' }];
      const inputs = [
        {
          action: 'write',
          unknown: 'PRIVATE_EXTRA_VALUE',
          items: [{ ...items[0], unknown: 'PRIVATE_EXTRA_VALUE' }]
        },
        { action: 'read', items: null, unknown: true },
        { action: 'write', items: [{ ...items[0], status: 'invalid' }], unknown: true }
      ];
      const { session } = await createFixture((_request, index) => {
        const input = inputs[index];
        if (!input) return answer();
        return codeMode
          ? toolCall('code_exec', `compat-${index}`, {
              code: `observe.result(await tools.todo(${JSON.stringify(input)}));`
            })
          : toolCall('todo', `compat-${index}`, input);
      }, codeMode);
      const execution = session.run({ prompt: 'Track and validate the checklist.' });
      const events: AgentEvent[] = [];
      for await (const event of execution) events.push(event);
      expect((await execution.result()).status).toBe('completed');
      expect(events.filter((event) => event.type === 'todo.updated')).toMatchObject([
        { revision: 1, items }
      ]);
      const results = events
        .filter((event) => event.type === 'tool.completed')
        .filter((event) => event.toolName === 'todo');
      expect(results.map((event) => event.data)).toEqual([
        { revision: 1, items },
        { revision: 1, items }
      ]);
      expect(
        events.filter((event) => event.type === 'tool.failed' && event.toolName === 'todo')
      ).toMatchObject([{ code: 'MAR_AGENT_TOOL_INPUT_INVALID' }]);
    }
  );

  it('writes and reads the complete checklist while rejecting items on read without publishing read events', async () => {
    const items = [
      { id: 'inspect', step: 'Inspect the change', status: 'completed' },
      { id: 'verify', step: 'Verify the change', status: 'in_progress' }
    ];
    const { adapter, session } = await createFixture((request, index) => {
      expectTodoTool(request);
      if (index === 0) return toolCall('todo', 'write', { action: 'write', items });
      if (index === 1) {
        expect(JSON.parse(toolResult(request, 'write')!.content)).toEqual({
          revision: 1,
          count: 2
        });
        return toolCall('todo', 'invalid-read', { action: 'read', items: [] });
      }
      if (index === 2) {
        expect(toolResult(request, 'invalid-read')).toMatchObject({ isError: true });
        return toolCall('todo', 'read', { action: 'read' });
      }
      expect(JSON.parse(toolResult(request, 'read')!.content)).toEqual({ revision: 1, items });
      return answer();
    });

    const execution = session.run({ prompt: 'Track the requested work.' });
    const events: AgentEvent[] = [];
    for await (const event of execution) events.push(event);

    expect((await execution.result()).status).toBe('completed');
    expect(adapter.requests).toHaveLength(4);
    expect(events.filter((event) => event.type === 'todo.updated')).toMatchObject([
      { type: 'todo.updated', revision: 1, items }
    ]);
    expect(
      events.filter((event) => event.type === 'tool.failed' && event.toolName === 'todo')
    ).toHaveLength(1);
  });

  it('restores a durable write after cancellation and increments its revision after reopening', async () => {
    const firstItems = [
      { id: 'inspect', step: 'Inspect the change', status: 'completed' },
      { id: 'implement', step: 'Implement the change', status: 'in_progress' }
    ];
    const fixture = await createFixture((_request, index, signal) => {
      if (index === 0)
        return toolCall('todo', 'cancel-write', { action: 'write', items: firstItems });
      return new Promise<readonly ModelEvent[]>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('Execution cancelled'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });

    const cancelledExecution = fixture.session.run({ prompt: 'Start and pause the work.' });
    const cancelledEvents: AgentEvent[] = [];
    for await (const event of cancelledExecution) {
      cancelledEvents.push(event);
      if (event.type === 'todo.updated') cancelledExecution.cancel();
    }
    expect((await cancelledExecution.result()).status).toBe('cancelled');
    expect(cancelledEvents.filter((event) => event.type === 'todo.updated')).toMatchObject([
      { type: 'todo.updated', revision: 1, items: firstItems }
    ]);

    await fixture.agent.dispose();
    const revisedItems = [
      firstItems[0]!,
      { id: 'implement', step: 'Implement the change', status: 'completed' },
      { id: 'verify', step: 'Verify the change', status: 'in_progress' }
    ];
    const reopenedAdapter = new FakeModelAdapter(fixture.configuration, (_request, index) => {
      if (index === 0) return toolCall('todo', 'restored-read', { action: 'read' });
      if (index === 1) {
        expect(JSON.parse(toolResult(_request, 'restored-read')!.content)).toEqual({
          revision: 1,
          items: firstItems
        });
        return toolCall('todo', 'restored-write', { action: 'write', items: revisedItems });
      }
      expect(JSON.parse(toolResult(_request, 'restored-write')!.content)).toEqual({
        revision: 2,
        count: 3
      });
      return answer();
    });
    const reopenedAgent = await createAgent(fixture.home, fixture.workspace, reopenedAdapter);
    const reopenedSession = await reopenedAgent.openSession(fixture.session.id);
    const reopenedExecution = reopenedSession.run({ prompt: 'Resume the checklist.' });
    const reopenedEvents: AgentEvent[] = [];
    for await (const event of reopenedExecution) reopenedEvents.push(event);

    expect((await reopenedExecution.result()).status).toBe('completed');
    expect(reopenedEvents.filter((event) => event.type === 'todo.updated')).toMatchObject([
      { type: 'todo.updated', revision: 2, items: revisedItems }
    ]);
  });

  it('keeps an unobserved Code Mode todo write in todo.updated and calls metadata', async () => {
    const items = [
      { id: 'inspect', step: 'Inspect the change', status: 'completed' },
      { id: 'verify', step: 'Verify the change', status: 'in_progress' }
    ];
    const code = `await tools.todo(${JSON.stringify({ action: 'write', items })});`;
    const { adapter, agent, home, session } = await createFixture((_request, index) => {
      if (index === 0) return toolCall('code_exec', 'code-write', { code });
      return answer();
    }, true);

    const execution = session.run({ prompt: 'Update the checklist from Code Mode.' });
    const events: AgentEvent[] = [];
    for await (const event of execution) events.push(event);

    expect((await execution.result()).status).toBe('completed');
    expect(adapter.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === 'todo.updated')).toMatchObject([
      { type: 'todo.updated', revision: 1, items }
    ]);

    await agent.dispose();
    const store = await JsonlSessionStore.open(home);
    try {
      const record = (await store.read(session.id)).find(
        (entry) =>
          entry.type === 'model.context' &&
          (entry.payload as { role?: string; callId?: string }).role === 'tool' &&
          (entry.payload as { callId?: string }).callId === 'code-write'
      );
      expect(record?.payload).toMatchObject({
        observations: [],
        calls: [
          expect.objectContaining({
            toolName: 'todo',
            input: { action: 'write', items },
            status: 'completed',
            result: expect.objectContaining({ data: { revision: 1, items } })
          })
        ]
      });
    } finally {
      await store.close();
    }
  });
});
