import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import type { ModelAdapter, ModelRequest } from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import type { ReadEventData } from '../../src/tools/contracts.js';

describe('read public events', () => {
  it.each([false, true])(
    'publishes and persists bounded associations (code mode %s)',
    async (codeMode) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-read-event-'));
      const workspace = join(home, 'workspace');
      await mkdir(workspace);
      const originalText = '  😀 content\r\n    indented\r\n';
      await writeFile(join(workspace, 'a.txt'), originalText);
      await writeFile(join(workspace, 'empty.txt'), '');
      const configuration: AgentModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        modelId: 'test',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        titleGeneration: false,
        hostedWebSearch: false,
        codeMode,
        enabled: true
      };
      let calls = 0;
      const requests: ModelRequest[] = [];
      const reads = { reads: [{ path: 'a.txt' }, { path: 'empty.txt' }, { path: 'missing.txt' }] };
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (calls++ === 0) {
            yield {
              type: 'client_tool.call',
              callId: 'call',
              name: codeMode ? 'code_exec' : 'read',
              arguments: codeMode
                ? `const result = await tools.read(${JSON.stringify(reads)}); observe.result(result); observe.text(JSON.stringify(result.data));`
                : reads
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'done', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createAgentWithAdapter(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Read' });
        const run = session.run({ prompt: 'Read files.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        const event = events.find(
          (entry) => entry.type === 'tool.completed' && entry.toolName === 'read'
        );
        expect(event?.type).toBe('tool.completed');
        if (!event || event.type !== 'tool.completed') throw new Error('Missing read event');
        const data = event.data as ReadEventData;
        const range = data.results[0]!.contentRange!;
        expect(event.summary.slice(range.start, range.end)).toBe(originalText);
        expect(data.results[1]!.contentRange).toEqual(
          expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) })
        );
        expect(data.results[1]!.contentRange!.start).toBe(data.results[1]!.contentRange!.end);
        expect(data.results[2]).toHaveProperty('error');
        expect(JSON.stringify(data)).not.toContain('😀 content');
        const modelOutput = requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'call'
        );
        expect(modelOutput?.content).toContain('mar_read_result');
        if (!codeMode) expect(modelOutput!.content).toContain('1\t  😀 content\n2\t    indented');
        else {
          const cell = JSON.parse(modelOutput!.content);
          const observation = cell.observations.find(
            (item: { type: string }) => item.type === 'value'
          );
          expect(JSON.parse(observation.value).results[0]).toMatchObject({ text: originalText });
        }
        const store = await JsonlSessionStore.open(home);
        try {
          const records = await store.read(session.id);
          const saved = records.find(
            (record) =>
              record.type === 'tool.completed' &&
              (record.payload as { toolName?: string }).toolName === 'read'
          );
          expect(saved?.payload).toMatchObject({ summary: event.summary, data });
        } finally {
          await store.close();
        }
      } finally {
        await agent.dispose();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
});
