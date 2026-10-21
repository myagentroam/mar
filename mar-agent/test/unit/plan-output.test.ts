import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { type ModelEvent } from '../../src/agent-core/model/contracts.js';
import { splitPlanOutput, PlanOutputPrefix } from '../../src/agent-core/runtime/plan-output.js';
import { openMarAgentSessionCatalog } from '../../src/agent-core/session/catalog.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const model: MarAgentModelConfiguration = {
  id: 'test',
  name: 'Test',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://example.test',
  apiKey: new SecretValue('test'),
  modelId: 'test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  responsesPreviousResponseId: false,
  enabled: true
};

describe('explicit Plan output boundary', () => {
  it.each([
    'No, this proposes a new protocol, and the current code has no such command.',
    '## Plan\nThis is only a discussion, not an implementation-ready proposal.',
    '<proposed_plan>\nunfinished',
    '<proposed_plan>\n \n</proposed_plan>',
    'Use <proposed_plan> as an example.',
    '```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```',
    '~~~xml\n<proposed_plan>\nexample\n</proposed_plan>\n~~~'
  ])('keeps ordinary or incomplete text as a message: %s', (text) => {
    expect(splitPlanOutput(text)).toEqual([{ kind: 'message', text }]);
  });

  it('preserves ordered mixed content and fenced code inside a plan', () => {
    expect(
      splitPlanOutput('Before\n<proposed_plan>\n# Plan\n```ts\nx()\n```\n</proposed_plan>\nAfter')
    ).toEqual([
      { kind: 'message', text: 'Before\n' },
      { kind: 'plan', text: '# Plan\n```ts\nx()\n```' },
      { kind: 'message', text: 'After' }
    ]);
  });

  it('streams prose but withholds a delimiter split across chunks', () => {
    const prefix = new PlanOutputPrefix();
    expect(prefix.push('ordinary Q&A')).toBe('ordinary Q&A');
    expect(prefix.push('\n<pro')).toBe('\n');
    expect(prefix.push('posed_plan>\n# Plan')).toBe('');
  });

  it('keeps multiple explicit plans ordered and accepts CRLF delimiters', () => {
    expect(
      splitPlanOutput(
        '<proposed_plan>\r\nOne\r\n</proposed_plan>\r\nBetween\n<proposed_plan>\nTwo\n</proposed_plan>'
      )
    ).toEqual([
      { kind: 'plan', text: 'One' },
      { kind: 'message', text: 'Between\n' },
      { kind: 'plan', text: 'Two' }
    ]);
  });

  it.each([
    '<proposed_plan> is only an inline example.\nMore prose.',
    '```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```\nMore prose.',
    '~~~xml\n<proposed_plan>\nexample\n</proposed_plan>\n~~~\nMore prose.'
  ])('does not stop streaming ordinary examples: %s', (text) => {
    const prefix = new PlanOutputPrefix();
    expect(Array.from(text, (character) => prefix.push(character)).join('')).toBe(text);
  });

  it.each(['final_answer', 'commentary', undefined] as const)(
    'classifies by explicit boundary, not phase %s, with identical persisted events',
    async (phase) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-plan-output-'));
      homes.push(home);
      const ordinary =
        'No, this proposes a new protocol, and the current code has no such command.';
      const text =
        'Confirmed.\n<proposed_plan>\n# Implementation plan\nModify and verify.\n</proposed_plan>\nAdditional notes.';
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace: home }),
        models: [model],
        adapterFactory: () => ({
          configuration: model,
          async *start(): AsyncIterable<ModelEvent> {
            for (const [itemId, body] of [
              ['ordinary', ordinary],
              ['mixed', text]
            ]) {
              for (const delta of body!)
                yield {
                  type: 'text.delta',
                  itemId: itemId!,
                  phase: phase ?? 'final_answer',
                  delta
                };
              yield { type: 'text.completed', itemId: itemId!, phase, text: body! };
            }
            if (phase === 'commentary')
              yield {
                type: 'text.completed',
                itemId: 'final',
                phase: 'final_answer',
                text: 'Done.'
              };
            yield { type: 'completed', reason: 'completed' };
          }
        })
      });
      try {
        const session = await agent.createSession({ workspace: home, title: 'Plan test' });
        const execution = session.plan({ prompt: 'Discuss the protocol' });
        const events = [];
        for await (const event of execution) events.push(event);
        expect((await execution.result()).status).toBe('completed');
        const completed = events.filter(
          (event) => event.type === 'message.completed' || event.type === 'plan.completed'
        );
        expect(completed.map((event) => [event.type, event.text])).toEqual([
          ['message.completed', ordinary],
          ['message.completed', 'Confirmed.\n'],
          ['plan.completed', '# Implementation plan\nModify and verify.'],
          ['message.completed', 'Additional notes.'],
          ...(phase === 'commentary' ? [['message.completed', 'Done.']] : [])
        ]);
        expect(new Set(completed.map((event) => event.itemId)).size).toBe(completed.length);
        expect(
          events
            .filter((event) => event.type === 'message.delta')
            .map((event) => event.delta)
            .join('')
        ).not.toContain('<proposed_plan>');
        const catalog = await openMarAgentSessionCatalog({ homeDirectory: home });
        try {
          const history = await catalog.history(session.id, { limit: 100 });
          expect(
            history.entries
              .filter((entry) => entry.kind === 'event')
              .map((entry) => entry.event)
              .filter(
                (event) => event.type === 'message.completed' || event.type === 'plan.completed'
              )
          ).toEqual(completed);
        } finally {
          await catalog.close();
        }
        const run = session.run({ prompt: 'normal mode' });
        const runEvents = [];
        for await (const event of run) runEvents.push(event);
        expect((await run.result()).status).toBe('completed');
        expect(runEvents.some((event) => event.type === 'plan.completed')).toBe(false);
        expect(runEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'message.completed', itemId: 'mixed', text })
          ])
        );
      } finally {
        await agent.dispose();
      }
    }
  );
});
