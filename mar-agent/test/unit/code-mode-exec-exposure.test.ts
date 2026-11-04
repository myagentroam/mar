import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { type ModelAdapter, type ModelRequest } from '../../src/model/contracts.js';
import { effectiveInstructions } from './support/model-context.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Code Mode exec exposure', () => {
  it.each([
    { protocol: 'OPENAI_RESPONSES' as const, caller: 'direct' },
    { protocol: 'ANTHROPIC_MESSAGES' as const, caller: 'direct' },
    { protocol: 'OPENAI_RESPONSES' as const, caller: 'programmatic' },
    { protocol: 'ANTHROPIC_MESSAGES' as const, caller: 'programmatic' }
  ])(
    'advertises both entries and executes $caller exec for $protocol',
    async ({ protocol, caller }) => {
      const home = await mkdtemp(join(tmpdir(), 'mar-exec-exposure-'));
      roots.push(home);
      const workspace = join(home, 'workspace');
      await mkdir(join(workspace, '.git'), { recursive: true });
      const configuration: AgentModelConfiguration = {
        id: 'coding',
        name: 'Coding',
        modelId: 'test',
        protocol,
        baseUrl: 'https://example.test',
        apiKey: new SecretValue('test-key'),
        contextWindowTokens: 200_000,
        maxOutputTokens: 4096,
        inputCapabilities: ['TEXT'],
        outputCapabilities: ['TEXT'],
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        codeMode: true,
        responsesPreviousResponseId: protocol === 'OPENAI_RESPONSES',
        hostedWebSearch: false,
        enabled: true
      };
      const input = {
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('EXEC_ENTRY_OK')"`
      };
      const code = `observe.result(await tools.exec(${JSON.stringify(input)}));`;
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: caller === 'direct' ? 'exec' : 'code_exec',
              callId: 'run-command',
              arguments:
                caller === 'direct' ? input : protocol === 'ANTHROPIC_MESSAGES' ? { code } : code
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
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Exec dual exposure' });
        const run = session.run({ prompt: 'Run the command.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            toolName: 'exec',
            data: expect.objectContaining({
              status: 'completed',
              exitCode: 0,
              stdout: 'EXEC_ENTRY_OK'
            })
          })
        );
        expect(requests).toHaveLength(2);
        expect(
          requests[1]!.messages.findLast((message) => message.role === 'tool')?.content
        ).toContain('EXEC_ENTRY_OK');
        for (const request of requests) {
          expect(request.tools.some((tool) => tool.name === 'exec')).toBe(true);
          const description = request.tools.find((tool) => tool.name === 'code_exec')!.description;
          const marker = 'Programmatic tools: ';
          const directory = JSON.parse(
            description.slice(description.lastIndexOf(marker) + marker.length)
          );
          expect(directory.callableNames).toContain('exec');
          expect(
            directory.tools.find((tool: { name: string }) => tool.name === 'exec').description
          ).toContain('Call directly or as tools.exec');
          const only = /Code Mode Only: ([^.]+) are callable/.exec(
            effectiveInstructions(request)
          )?.[1];
          expect(only).toBeDefined();
          expect(only!.split(', ')).not.toContain('exec');
        }
      } finally {
        await agent.dispose();
      }
    }
  );
});
