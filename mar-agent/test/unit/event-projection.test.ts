import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import type { ModelEvent, ModelRequest } from '../../src/model/contracts.js';
import { publicHostedToolEvents } from '../../src/runtime/event-projection.js';
import { AGENT_EXECUTION_POLICY } from '../../src/runtime/execution-policy.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';

const limit = AGENT_EXECUTION_POLICY.toolEventSummaryCharacters;
const marker = '... [tool event summary truncated]';
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('tool event summary projection', () => {
  it.each([0, limit - 1, limit, limit + 1])(
    'marks only summaries exceeding the character budget (%s characters)',
    (length) => {
      const output = 'x'.repeat(length);
      const events = publicHostedToolEvents({
        type: 'hosted_tool',
        itemId: 'hosted',
        kind: 'WEB_FETCH',
        status: 'COMPLETED',
        summary: {},
        output
      });
      expect(events[1]).toMatchObject({
        type: 'tool.completed',
        summary: length <= limit ? output : output.slice(0, limit - marker.length) + marker,
        truncated: length > limit
      });
      if (events[1]?.type === 'tool.completed')
        expect(events[1].summary.length).toBeLessThanOrEqual(limit);
    }
  );

  it('does not label upstream truncation as summary truncation', () => {
    expect(
      publicHostedToolEvents({
        type: 'hosted_tool',
        itemId: 'hosted',
        kind: 'WEB_FETCH',
        status: 'COMPLETED',
        summary: {},
        output: 'partial upstream output',
        truncated: true
      })[1]
    ).toMatchObject({ summary: 'partial upstream output', truncated: true });
  });

  it('keeps the marker within the budget without splitting a Unicode character', () => {
    const prefix = 'x'.repeat(limit - marker.length - 1);
    const events = publicHostedToolEvents({
      type: 'hosted_tool',
      itemId: 'hosted',
      kind: 'WEB_FETCH',
      status: 'FAILED',
      summary: {},
      output: prefix + '😀' + 'x'.repeat(marker.length)
    });
    expect(events[1]).toMatchObject({
      type: 'tool.failed',
      message: prefix + marker,
      truncated: true
    });
  });

  it.each([false, true])(
    'marks live and durable event summaries without clipping model results (Code Mode: %s)',
    async (codeMode) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-event-summary-'));
      homes.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const requests: ModelRequest[] = [];
      const configuration: AgentModelConfiguration = {
        id: 'fake',
        name: 'Fake',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        modelId: 'fake',
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        titleGeneration: false,
        codeMode,
        hostedWebSearch: false,
        enabled: true
      };
      const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(2500))"`;
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => ({
          configuration,
          async *start(request): AsyncIterable<ModelEvent> {
            requests.push(request);
            if (requests.length === 1) {
              yield {
                type: 'client_tool.call',
                callId: 'summary-call',
                name: codeMode ? 'code_exec' : 'exec',
                arguments: codeMode
                  ? `observe.result(await tools.exec(${JSON.stringify({ command, login: false })}));`
                  : { command, login: false },
                ...(codeMode ? { inputMode: 'freeform' as const } : {})
              };
              yield { type: 'completed', reason: 'tool_use' };
              return;
            }
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        })
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Summary truncation' });
        const run = session.run({ prompt: 'Read the full tool result.' });
        const completions = [];
        for await (const event of run) if (event.type === 'tool.completed') completions.push(event);
        expect(await run.result()).toMatchObject({ status: 'completed', finalAnswer: 'done' });
        expect(completions).toHaveLength(codeMode ? 2 : 1);
        for (const event of completions) {
          expect(event.summary).toContain(marker);
          expect(event.summary.length).toBeLessThanOrEqual(limit);
          expect(event.truncated).toBe(true);
        }
        expect(completions.find((event) => event.toolName === 'exec')?.data).toMatchObject({
          stdout: 'x'.repeat(2500),
          exitCode: 0,
          truncated: false,
          stdoutDroppedBytes: 0
        });
        const result = requests[1]?.messages.find((message) => message.role === 'tool');
        expect(result?.content).not.toContain(marker);
        expect(result?.content).toContain('x'.repeat(2500));
        const body = JSON.parse(result!.content);
        if (codeMode) {
          expect(body).toMatchObject({ truncated: false, outputDroppedBytes: 0 });
          expect(result?.contentParts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('x'.repeat(2500))
              })
            ])
          );
        } else expect(body).toMatchObject({ stdout: 'x'.repeat(2500), exitCode: 0 });

        const store = await JsonlSessionStore.open(home);
        try {
          const records = await store.read(session.id);
          if (codeMode) {
            const context = records.find(
              (record) =>
                record.type === 'model.context' &&
                record.payload.callId === 'summary-call' &&
                record.payload.role === 'tool'
            );
            expect(context?.payload.observations).toMatchObject([{ result: { truncated: false } }]);
          }
          const durable = records.filter((record) => record.type === 'tool.completed');
          expect(durable).toHaveLength(completions.length);
          expect(durable.map((record) => (record.payload as { summary: string }).summary)).toEqual(
            completions.map((event) => event.summary)
          );
        } finally {
          await store.close();
        }
      } finally {
        await agent.dispose();
      }
    }
  );
});
