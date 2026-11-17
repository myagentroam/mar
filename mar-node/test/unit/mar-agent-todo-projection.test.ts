import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../../mar-agent/src/host.js';
import {
  SecretValue,
  openAgentSessionCatalog,
  type AgentEvent,
  type AgentModelConfiguration
} from '../../../mar-agent/src/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/src/sdk/agent.js';
import type { ModelAdapter, ModelEvent } from '../../../mar-agent/src/model/contracts.js';
import type { NodeAgentSession } from '../../src/database.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';

describe('MAR Agent Todo projection', () => {
  it.each([
    ['OPENAI_RESPONSES', false],
    ['OPENAI_RESPONSES', true],
    ['ANTHROPIC_MESSAGES', false],
    ['ANTHROPIC_MESSAGES', true]
  ] as const)(
    'projects only native Todo updates in live and Catalog history (%s, Code Mode=%s)',
    async (protocol, codeMode) => {
      const root = await mkdtemp(join(tmpdir(), 'mar-todo-projection-'));
      const workspace = join(root, 'workspace');
      const home = join(root, 'home');
      await mkdir(workspace);
      const items = [{ id: 'verify', step: 'Verify the projection', status: 'in_progress' }];
      const inputs = [
        { action: 'read', items: null },
        { action: 'write', items },
        { action: 'read' },
        { action: 'write', items: [] },
        { action: 'read' }
      ];
      const model: AgentModelConfiguration = {
        id: 'todo-projection',
        name: 'Todo projection',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test'),
        modelId: 'projection',
        contextWindowTokens: 100_000,
        maxOutputTokens: 1_000,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: [],
        hostedWebSearch: false,
        titleGeneration: false,
        codeMode,
        enabled: true
      };
      let round = 0;
      const adapter: ModelAdapter = {
        configuration: model,
        async *start(): AsyncIterable<ModelEvent> {
          const input = inputs[round++];
          if (input) {
            // Do not observe the nested result: the update must remain independently visible.
            const code = `await tools.todo(${JSON.stringify(input)});`;
            yield {
              type: 'client_tool.call',
              callId: `call-${round}`,
              name: codeMode ? 'code_exec' : 'todo',
              arguments: codeMode ? (protocol === 'OPENAI_RESPONSES' ? code : { code }) : input
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [model]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Todo projection' });
        const execution = session.run({ prompt: 'Update and clear the checklist.' });
        const events: AgentEvent[] = [];
        for await (const event of execution) events.push(event);
        await expect(execution.result()).resolves.toMatchObject({ status: 'completed' });
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        const updates = events.filter((event) => event.type === 'todo.updated');
        expect(updates).toEqual([
          expect.objectContaining({ revision: 1, items }),
          expect.objectContaining({ revision: 2, items: [] })
        ]);
        const normalizer = new MarAgentConversationNormalizer();
        const live = new Map(
          events.flatMap((event) => normalizer.normalize(event)).map((item) => [item.itemId, item])
        );
        const liveTodos = [...live.values()].filter((item) => item.kind === 'todo_list');
        const expected = updates.map((event) =>
          expect.objectContaining({
            itemId: `mar-agent-todo-list:${event.eventId}`,
            status: 'COMPLETED',
            payload: {
              items: event.items.map((item) => ({
                id: item.id,
                text: item.step,
                status: item.status.toUpperCase()
              }))
            }
          })
        );
        expect(liveTodos).toEqual(expected);
        if (codeMode) {
          expect([...live.values()].filter((item) => item.kind === 'tool_call')).toEqual([]);
        } else {
          expect([...live.values()].filter((item) => item.kind === 'tool_call')).toHaveLength(5);
        }
        const catalog = await openAgentSessionCatalog({ homeDirectory: home });
        try {
          const history = await catalog.history(session.id, { limit: 200 });
          const turns = projectMarAgentHistory(
            { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
            history.entries
          );
          const historyTodos = turns
            .flatMap((turn) => turn.items)
            .filter((item) => item.kind === 'todo_list');
          expect(
            historyTodos.map(({ id, status, payload }) => ({ itemId: id, status, payload }))
          ).toEqual(expected);
          expect(historyTodos.map((item) => item.id)).toEqual(liveTodos.map((item) => item.itemId));
        } finally {
          await catalog.close();
        }
      } finally {
        await agent.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
