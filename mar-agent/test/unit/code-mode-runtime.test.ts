import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest
} from '../../src/model/contracts.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { startResponsesWebSocketServer } from './support/responses-transport-servers.js';
import { effectiveInstructions } from './support/model-context.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/tools/registry.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-code-mode-sdk-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  await writeFile(join(workspace, 'input.txt'), 'hello\n');
  return { home, workspace };
}
const code = `
  const input = await tools.read({ reads: [{ path: "input.txt" }] });
  if (!input.data.results[0].text.includes("hello")) throw new Error("Wrong input");
  const patch = await tools.apply_patch("*** Begin Patch\\n*** Add File: output.txt\\n+done\\n*** Update File: input.txt\\n@@\\n hello\\n*** End Patch");
  observe.text({ read: true, files: patch.data.files.length });
`;
function observedJSON(content: string) {
  const envelope = JSON.parse(content);
  const observation = envelope.observations?.at(-1);
  return observation
    ? JSON.parse(observation.type === 'tool_result' ? observation.content : observation.value)
    : envelope;
}
const model: AgentModelConfiguration = {
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
  codeMode: true,
  responsesPreviousResponseId: true,
  hostedWebSearch: false,
  enabled: true
};
function response(id: string, items: unknown[]) {
  return [
    { type: 'response.created', response: { id } },
    ...items.map((item) => ({ type: 'response.output_item.done', item })),
    {
      type: 'response.completed',
      response: { id, output: items, usage: { input_tokens: 100, output_tokens: 10 } }
    }
  ];
}
const callItem = {
  type: 'custom_tool_call',
  id: 'item-code',
  call_id: 'call-code',
  name: 'code_exec',
  input: code
};
const answer = {
  type: 'message',
  id: 'answer',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text: 'done' }]
};

describe('Code Mode SDK and protocol integration', () => {
  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'keeps new code execution available after an expired cell wait under %s',
    async (protocol) => {
      const { home, workspace } = await fixture();
      const configuration = {
        ...model,
        protocol,
        responsesPreviousResponseId: protocol === 'OPENAI_RESPONSES'
      };
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          expect(request.tools.find((tool) => tool.name === 'code_exec')).toBeDefined();
          const wait = request.tools.find((tool) => tool.name === 'code_exec_wait');
          expect(wait?.description).toContain('It cannot start new work; use code_exec for that');
          expect(wait?.description).toContain(
            'A missing cellId does not mean code_exec is unavailable'
          );
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec_wait',
              callId: 'expired-wait',
              arguments: { cellId: 'expired-cell', yieldMs: 0 }
            };
          } else if (requests.length === 2) {
            expect(
              request.messages.find(
                (message) => message.role === 'tool' && message.callId === 'expired-wait'
              )?.content
            ).toContain('MAR_AGENT_CODE_CELL_NOT_FOUND');
            const source = 'observe.text("fresh work");';
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'fresh-cell',
              arguments: protocol === 'ANTHROPIC_MESSAGES' ? { code: source } : source
            };
          } else {
            expect(
              request.messages.find(
                (message) => message.role === 'tool' && message.callId === 'fresh-cell'
              )?.content
            ).toContain('fresh work');
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
            return;
          }
          yield { type: 'completed', reason: 'tool_use' };
        }
      };
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Expired cell recovery' });
        expect((await session.run({ prompt: 'Continue with new work.' }).result()).status).toBe(
          'completed'
        );
        expect(requests).toHaveLength(3);
        expect(requests[1]!.tools).toEqual(requests[0]!.tools);
        expect(requests[2]!.tools).toEqual(requests[0]!.tools);
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each([
    { protocol: 'OPENAI_RESPONSES' as const, caller: 'direct' },
    { protocol: 'ANTHROPIC_MESSAGES' as const, caller: 'direct' },
    { protocol: 'OPENAI_RESPONSES' as const, caller: 'programmatic' },
    { protocol: 'ANTHROPIC_MESSAGES' as const, caller: 'programmatic' }
  ])(
    'starts in a cell and controls the process through $caller exec_wait for $protocol',
    async ({ caller, ...overrides }) => {
      const { home, workspace } = await fixture();
      const configuration = {
        ...model,
        ...overrides,
        responsesPreviousResponseId: overrides.protocol === 'OPENAI_RESPONSES'
      };
      const requests: ModelRequest[] = [];
      const encode = (code: string) =>
        overrides.protocol === 'ANTHROPIC_MESSAGES' ? { code } : code;
      let processId: string | undefined;
      const command = `${JSON.stringify(process.execPath)} -e "process.stdin.once('data', d => { process.stdout.write(d); process.exit(0); })"`;
      const source = `const started = await tools.exec(${JSON.stringify({ command, yieldMs: 0 })}); observe.text({ ...started.data, exitCode: started.data.exitCode });`;
      const adapter: ModelAdapter = {
        configuration,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          const previous = request.messages.findLast((message) => message.role === 'tool');
          const result = previous ? observedJSON(previous.content) : undefined;
          if (result?.processId) processId = result.processId;
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'start-cell',
              arguments: overrides.protocol === 'ANTHROPIC_MESSAGES' ? { code: source } : source
            };
          } else if (requests.length === 2) {
            expect(result).toMatchObject({ status: 'running', processId });
            yield {
              type: 'client_tool.call',
              name: caller === 'direct' ? 'exec_wait' : 'code_exec',
              callId: 'write-process',
              arguments:
                caller === 'direct'
                  ? { processId, action: 'write', data: 'PROGRAMMATIC_WAIT_OK\n' }
                  : encode(
                      `observe.text((await tools.exec_wait(${JSON.stringify({ processId, action: 'write', data: 'PROGRAMMATIC_WAIT_OK\n' })})).data);`
                    )
            };
          } else if (result?.status === 'running' && requests.length < 8) {
            yield {
              type: 'client_tool.call',
              name: caller === 'direct' ? 'exec_wait' : 'code_exec',
              callId: `wait-${requests.length}`,
              arguments:
                caller === 'direct'
                  ? { processId }
                  : encode(
                      `observe.text((await tools.exec_wait(${JSON.stringify({ processId })})).data);`
                    )
            };
          } else {
            expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
            return;
          }
          yield { type: 'completed', reason: 'tool_use' };
        }
      };
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({
          workspace,
          title: `${caller} process control`
        });
        const run = session.run({
          prompt: `Start a process through Code Mode, then write stdin and wait through ${caller} calls.`
        });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            toolName: 'exec_wait',
            data: expect.objectContaining({
              status: 'completed',
              waitOutcome: 'completion',
              exitCode: 0,
              processId,
              stdout: expect.stringContaining('PROGRAMMATIC_WAIT_OK')
            })
          })
        );
        for (const request of requests) {
          expect(request.tools.some((tool) => tool.name === 'exec_wait')).toBe(true);
          expect(request.tools.some((tool) => tool.name === 'exec')).toBe(false);
          const description = request.tools.find((tool) => tool.name === 'code_exec')!.description;
          expect(description).toContain('"name":"exec_wait"');
          expect(description).toContain('"name":"exec"');
          expect(description).toContain("follow exec_wait's calling guidance");
          expect(description).toContain('Omitted means no process timeout');
        }
        expect(
          events.filter((event) => event.type === 'tool.started' && event.toolName === 'code_exec')
        ).toHaveLength(caller === 'direct' ? 1 : requests.length - 1);
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each(
    [
      { protocol: 'OPENAI_RESPONSES' as const },
      { protocol: 'ANTHROPIC_MESSAGES' as const }
    ].flatMap((configuration) => [false, true].map((emitText) => ({ ...configuration, emitText })))
  )(
    'loads Skills directly and forwards pixels without Base64 text for $protocol emitText=$emitText',
    async (overrides) => {
      const { home, workspace } = await fixture();
      const png = {
        mimeType: 'image/png',
        dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      };
      await writeFile(join(workspace, 'image.png'), Buffer.from(png.dataBase64, 'base64'));
      const configuration = {
        ...model,
        ...overrides,
        responsesPreviousResponseId: overrides.protocol === 'OPENAI_RESPONSES',
        inputCapabilities: ['TEXT', 'IMAGE'] as const
      };
      const requests: ModelRequest[] = [];
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      await mkdir(join(workspace, '.agents', 'skills', 'inspection'), { recursive: true });
      await writeFile(
        join(workspace, '.agents', 'skills', 'inspection', 'SKILL.md'),
        '---\nname: inspection\ndescription: Inspect images\n---\nInspect the image pixels before answering.\n'
      );
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [configuration]
        },
        () => ({
          configuration,
          async *start(request): AsyncIterable<ModelEvent> {
            requests.push(request);
            if (requests.length === 1) {
              yield {
                type: 'client_tool.call',
                name: 'skill',
                callId: 'load-skill',
                arguments: { name: 'inspection' }
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else if (requests.length === 2) {
              const source = `const r=await tools.view_image({path:"image.png"}); ${overrides.emitText ? 'observe.result(r);' : 'observe.image(r.images[0]);'}`;
              yield {
                type: 'client_tool.call',
                name: 'code_exec',
                callId: 'view-pixels',
                arguments: overrides.protocol === 'ANTHROPIC_MESSAGES' ? { code: source } : source
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield { type: 'text.completed', itemId: 'answer', text: 'done' };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({
          workspace,
          title: 'Direct Skill and image output'
        });
        expect(
          (
            await session
              .run({ prompt: 'Load the inspection skill, then inspect the image.' })
              .result()
          ).status
        ).toBe('completed');
        expect(
          BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'skill')?.allowedCallers
        ).toEqual(['direct']);
        expect(requests[0]!.tools.find((tool) => tool.name === 'skill')).toBeDefined();
        expect(requests[0]!.tools.find((tool) => tool.name === 'skill')).not.toHaveProperty(
          'allowedCallers'
        );
        expect(
          requests[0]!.tools.find((tool) => tool.name === 'code_exec')!.description
        ).not.toContain('"name":"skill"');
        expect(
          requests[1]!.messages.find(
            (message) => message.callId === 'load-skill' && message.role === 'tool'
          )!.content
        ).toContain('Inspect the image pixels before answering.');
        const imageResult = requests[2]!.messages.find(
          (message) => message.callId === 'view-pixels' && message.role === 'tool'
        )!;
        expect(imageResult.content).not.toContain(png.dataBase64);
        expect(imageResult).not.toHaveProperty('observations');
        expect(imageResult.contentParts?.some((part) => part.type === 'image')).toBe(true);
        const store = await JsonlSessionStore.open(home);
        try {
          const record = (await store.read(session.id)).find(
            (item) =>
              item.type === 'model.context' &&
              (item.payload as { callId?: string }).callId === 'view-pixels' &&
              (item.payload as { role?: string }).role === 'tool'
          );
          expect(record?.payload.observations).toEqual([
            expect.objectContaining(
              overrides.emitText
                ? {
                    type: 'tool_result',
                    source: expect.objectContaining({ toolName: 'view_image' })
                  }
                : { type: 'value', format: 'image' }
            )
          ]);
        } finally {
          await store.close();
        }
        expect(imageResult.images).toEqual([
          {
            ...png,
            resourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
            resourceInputVersion: 1,
            byteSize: Buffer.from(png.dataBase64, 'base64').length
          }
        ]);
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each(
    ['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'].flatMap((protocol) =>
      ['direct', 'cell', 'caught'].map((caller) => ({
        protocol: protocol as 'OPENAI_RESPONSES' | 'ANTHROPIC_MESSAGES',
        caller
      }))
    )
  )(
    'returns incomplete-image errors without pixels through $caller for $protocol',
    async ({ protocol, caller }) => {
      const { home, workspace } = await fixture();
      await writeFile(join(workspace, 'unfinished.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
      const configuration = {
        ...model,
        protocol,
        responsesPreviousResponseId: protocol === 'OPENAI_RESPONSES',
        codeMode: caller !== 'direct',
        inputCapabilities: ['TEXT', 'IMAGE'] as const
      };
      const requests: ModelRequest[] = [];
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [configuration]
        },
        () => ({
          configuration,
          async *start(request): AsyncIterable<ModelEvent> {
            requests.push(request);
            if (requests.length === 1) {
              let source =
                'const result = await tools.view_image({path:"unfinished.png"}); observe.result(result);';
              if (caller === 'caught')
                source = `try { ${source} } catch (error) { observe.result(error); }`;
              yield {
                type: 'client_tool.call',
                callId: 'unfinished-image',
                name: caller === 'direct' ? 'view_image' : 'code_exec',
                arguments:
                  caller === 'direct'
                    ? { path: 'unfinished.png' }
                    : protocol === 'ANTHROPIC_MESSAGES'
                      ? { code: source }
                      : source
              };
              yield { type: 'completed', reason: 'tool_use' };
            } else {
              yield {
                type: 'text.completed',
                itemId: 'answer',
                text: 'Wait for the writer to finish.'
              };
              yield { type: 'completed', reason: 'completed' };
            }
          }
        })
      );
      try {
        const session = await agent.createSession({
          workspace,
          title: 'Incomplete image recovery'
        });
        expect((await session.run({ prompt: 'Inspect the image.' }).result()).status).toBe(
          'completed'
        );
        const result = requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'unfinished-image'
        )!;
        expect(result.content).toContain('MAR_AGENT_IMAGE_INCOMPLETE');
        expect(result.content).toContain('writer');
        expect(result.images?.length ?? 0).toBe(0);
        expect(requests[1]!.messages.every((message) => !message.images?.length)).toBe(true);
      } finally {
        await agent.dispose();
      }
    }
  );

  it.each([true, false])(
    'preserves the cached prefix without resource refresh after Host recreation with enumeration=%s',
    async (enumeratesResources) => {
      const { home, workspace } = await fixture();
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration: model,
        async *start(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'old-cell',
              arguments: 'observe.text("previous work");'
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: `answer-${requests.length}`, text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const create = () => {
        const host = new LocalAgentHost({ homeDirectory: home, workspace });
        if (!enumeratesResources)
          Object.defineProperty(host, 'listSessionResources', { value: undefined });
        return createMarAgent(
          {
            mode: 'normal',
            host,
            models: [model]
          },
          () => adapter
        );
      };
      let agent = await create();
      try {
        const session = await agent.createSession({ workspace, title: 'Expired resources' });
        await session.run({ prompt: 'Produce a cell.' }).result();
        await agent.dispose();
        agent = await create();
        const reopened = await agent.openSession(session.id);
        await reopened.run({ prompt: 'Continue after Host recreation.' }).result();
        await reopened.run({ prompt: 'Continue without resource changes.' }).result();
        for (const request of requests.slice(2)) {
          expect(JSON.stringify(request.messages)).not.toContain(
            'No retained processes, code cells or subagents remain.'
          );
          expect(JSON.stringify(request.messages)).not.toContain('# Retained Session resources');
        }
        expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual(
          requests[1]!.messages
        );
        expect(requests[3]!.messages.slice(0, requests[2]!.messages.length)).toEqual(
          requests[2]!.messages
        );
        for (const request of requests.slice(1)) {
          expect(request.system).toBe(requests[0]!.system);
          expect(request.tools).toEqual(requests[0]!.tools);
          expect(request.promptCacheKey).toBe(session.id);
        }
      } finally {
        await agent.dispose();
      }
    }
  );

  it('delivers already emitted output after a later tool failure without marking the cell successful', async () => {
    const { home, workspace } = await fixture();
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'client_tool.call',
            name: 'code_exec',
            callId: 'partial-cell',
            arguments:
              'observe.text((await tools.read({reads:[{path:"input.txt"}]})).data.results[0].text); await tools.exec({action:"poll",processId:"missing-process"});'
          };
          yield { type: 'completed', reason: 'tool_use' };
        } else {
          yield { type: 'text.completed', itemId: 'done', text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Partial cell output' });
      const run = session.run({ prompt: 'Read then attempt an invalid exec input.' });
      const events = [];
      for await (const event of run) events.push(event);
      expect((await run.result()).status).toBe('completed');
      const result = requests[1]!.messages.find(
        (message) => message.role === 'tool' && message.callId === 'partial-cell'
      )!;
      expect(JSON.parse(result.content)).toMatchObject({
        status: 'failed',
        observations: [{ type: 'value', format: 'text', value: 'hello\n' }],
        error: { code: 'MAR_AGENT_TOOL_INPUT_INVALID' }
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          callId: 'partial-cell',
          code: 'MAR_AGENT_TOOL_INPUT_INVALID'
        })
      );
      expect(
        events.some((event) => event.type === 'tool.completed' && event.callId === 'partial-cell')
      ).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  it.each([{ protocol: 'OPENAI_RESPONSES' }, { protocol: 'ANTHROPIC_MESSAGES' }] as const)(
    'preserves compiler errors through Runtime, persistence, and restart: $protocol',
    async (overrides) => {
      const { home, workspace } = await fixture();
      const configuration = {
        ...model,
        ...overrides,
        responsesPreviousResponseId: overrides.protocol === 'OPENAI_RESPONSES'
      };
      const source =
        'observe.result(await tools.read({reads:[{path:"input.txt"}]})); await tools.exec({command": "echo harmless"});';
      const requests: ModelRequest[] = [];
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'syntax-cell',
              arguments: overrides.protocol === 'ANTHROPIC_MESSAGES' ? { code: source } : source
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: `done-${requests.length}`, text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const create = () =>
        createMarAgent(
          {
            mode: 'normal',
            host: new LocalAgentHost({ homeDirectory: home, workspace }),
            models: [configuration]
          },
          () => adapter
        );
      let agent = await create();
      try {
        const session = await agent.createSession({ workspace, title: 'Compiler error replay' });
        const run = session.run({ prompt: 'Attempt a malformed Code Mode script.' });
        const events = [];
        for await (const event of run) events.push(event);
        expect((await run.result()).status).toBe('completed');
        expect(
          events.filter((event) => event.type === 'tool.started').map((event) => event.toolName)
        ).toEqual(['code_exec']);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.failed',
            callId: 'syntax-cell',
            code: 'MAR_AGENT_CODE_SYNTAX_ERROR'
          })
        );
        const toolResult = requests[1]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'syntax-cell'
        )!;
        expect(JSON.parse(toolResult.content)).toMatchObject({
          status: 'failed',
          observations: [],
          error: {
            code: 'MAR_AGENT_CODE_SYNTAX_ERROR',
            message: expect.stringMatching(
              /Line 1, column \d+\. No tools were executed\.[\s\S]*\^/u
            )
          }
        });
        const diagnostic = JSON.parse(toolResult.content).error.message;
        expect(diagnostic).toContain('command": "echo harmless"');
        expect(diagnostic).not.toContain('MAR_AGENT_CODE_SYNTAX_ERROR:');
        expect(diagnostic).not.toContain('code-mode.js');
        const store = await JsonlSessionStore.open(home);
        try {
          const records = await store.read(session.id);
          expect(records).toContainEqual(
            expect.objectContaining({
              type: 'tool.failed',
              payload: expect.objectContaining({ code: 'MAR_AGENT_CODE_SYNTAX_ERROR' })
            })
          );
          const canonical = records.find(
            (record) =>
              record.type === 'model.context' &&
              (record.payload as { role?: string }).role === 'tool' &&
              (record.payload as { callId?: string }).callId === 'syntax-cell'
          )!;
          expect(canonical.payload).toMatchObject({ calls: [], observations: [] });
        } finally {
          await store.close();
        }
        await agent.dispose();
        agent = await create();
        await (
          await agent.openSession(session.id)
        )
          .run({ prompt: 'Continue from persisted history.' })
          .result();
        expect(
          requests[2]!.messages.find(
            (message) => message.role === 'tool' && message.callId === 'syntax-cell'
          )?.content
        ).toBe(toolResult.content);
      } finally {
        await agent.dispose();
      }
    }
  );

  it('refreshes persisted Todo state between Executions when no cell is still running', async () => {
    const { home, workspace } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        requests.push(request);
        if (requests.length === 1 || requests.length === 3) {
          yield {
            type: 'client_tool.call',
            name: 'code_exec',
            callId: `todo-${requests.length}`,
            arguments:
              requests.length === 1
                ? 'observe.text(await tools.todo_write({items:[{id:"one",step:"Initial",status:"pending"}]}));'
                : 'observe.text(await tools.todo_read());'
          };
          yield { type: 'completed', reason: 'tool_use' };
        } else {
          yield { type: 'text.completed', itemId: 'done', text: 'done' };
          yield { type: 'completed', reason: 'completed' };
        }
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Todo restore' });
      expect((await session.run({ prompt: 'Write the task.' }).result()).status).toBe('completed');
      const store = await JsonlSessionStore.open(home);
      try {
        const release = await store.acquireSessionLease(session.id);
        try {
          await store.append(session.id, {
            type: 'todo.updated',
            payload: {
              revision: 2,
              items: [{ id: 'restored', step: 'Restored', status: 'completed' }]
            }
          });
        } finally {
          await release();
        }
      } finally {
        await store.close();
      }
      expect((await session.run({ prompt: 'Read current tasks.' }).result()).status).toBe(
        'completed'
      );
      expect(
        requests[3]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'todo-3'
        )!.content
      ).toContain('Restored');
    } finally {
      await agent.dispose();
    }
  });

  it.each([{ protocol: 'OPENAI_RESPONSES' as const }, { protocol: 'ANTHROPIC_MESSAGES' as const }])(
    'retains a yielded cell across Executions with frozen tool identity for $protocol',
    async (overrides) => {
      const { home, workspace } = await fixture();
      const host = new LocalAgentHost({ homeDirectory: home, workspace });
      const nestedEntered = Promise.withResolvers<void>();
      const releaseNested = Promise.withResolvers<void>();
      const executeTool = host.executeTool.bind(host);
      host.executeTool = async (call, context) => {
        if (call.name === 'apply_patch') {
          nestedEntered.resolve();
          await releaseNested.promise;
        }
        return executeTool(call, context);
      };
      const requests: ModelRequest[] = [];
      let cellId = '';
      const configuration = {
        ...model,
        ...overrides,
        responsesPreviousResponseId: overrides.protocol === 'OPENAI_RESPONSES'
      };
      const source =
        'observe.text("phase-one"); await cell.yield_control(); ' +
        'await tools.apply_patch("*** Begin Patch\\n*** Add File: background.txt\\n+background\\n*** End Patch"); state.set("done", true); observe.text("phase-two");';
      const adapter: ModelAdapter = {
        configuration,
        async *start(request) {
          requests.push(request);
          const index = requests.length;
          if (index === 1 || index === 3 || index === 4) {
            const code = index === 1 ? source : 'observe.text(state.get("done"));';
            yield {
              type: 'client_tool.call',
              name: index === 3 ? 'code_exec_wait' : 'code_exec',
              callId: `cell-${index}`,
              arguments:
                index === 3
                  ? { cellId }
                  : configuration.protocol === 'ANTHROPIC_MESSAGES'
                    ? { code }
                    : code
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: `answer-${index}`, text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host,
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Retained cells' });
        const first = session.run({ prompt: 'Start background work.' });
        expect((await first.result()).status).toBe('completed');
        await nestedEntered.promise;
        cellId = (await host.listSessionResources(session.id)).codeCells![0]!.cellId;
        expect(
          requests[1]!.messages.find(
            (message) => message.role === 'tool' && message.callId === 'cell-1'
          )!.content
        ).toContain('phase-one');
        releaseNested.resolve();
        await expect
          .poll(async () => readFile(join(workspace, 'background.txt'), 'utf8'))
          .toBe('background\n');
        await expect
          .poll(async () => (await host.listSessionResources(session.id)).codeCells![0]!.status)
          .toBe('completed');
        const second = session.run({
          prompt: 'Collect the existing cell and its committed state.'
        });
        expect((await second.result()).status).toBe('completed');
        expect(JSON.stringify(requests[2]!.messages)).toContain(cellId);
        const result = requests[3]!.messages.find(
          (message) => message.role === 'tool' && message.callId === 'cell-3'
        )!;
        expect(JSON.parse(result.content)).toMatchObject({
          status: 'completed',
          observations: [{ type: 'value', format: 'text', value: 'phase-two' }],
          cached: false
        });
        expect(
          observedJSON(
            requests[4]!.messages.find(
              (message) => message.role === 'tool' && message.callId === 'cell-4'
            )!.content
          )
        ).toBe(true);
        const store = await JsonlSessionStore.open(home);
        try {
          const records = await store.read(session.id);
          const nested = records.find(
            (record) =>
              record.type === 'tool.completed' &&
              (record.payload as { toolName?: string }).toolName === 'apply_patch'
          );
          expect(nested).toMatchObject({
            executionId: first.executionId,
            payload: { parentCallId: 'cell-1' }
          });
          expect(
            records.some(
              (record) =>
                record.type === 'code.cell.completed' &&
                (record.payload as { cellId?: string }).cellId === cellId
            )
          ).toBe(true);
          expect(new Set(records.map((record) => record.sequence)).size).toBe(records.length);
        } finally {
          await store.close();
        }
      } finally {
        releaseNested.resolve();
        await agent.dispose();
      }
    }
  );

  it.each([{ protocol: 'OPENAI_RESPONSES' as const }, { protocol: 'ANTHROPIC_MESSAGES' as const }])(
    'projects dual patch exposure and executes both entry points for $protocol',
    async (overrides) => {
      const { home, workspace } = await fixture();
      const requests: ModelRequest[] = [];
      const directText =
        [
          'const value = `hello ${name}`;',
          'const path = "C:\\temp\\file";',
          '"double" and unescaped multiline text'
        ]
          .join('\n')
          .repeat(80) + '\n';
      const configuration = {
        ...model,
        ...overrides,
        responsesPreviousResponseId: overrides.protocol === 'OPENAI_RESPONSES'
      };
      const adapter: ModelAdapter = {
        configuration,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          if (requests.length === 1) {
            yield {
              type: 'client_tool.call',
              name: 'apply_patch',
              callId: 'compatible-direct',
              arguments:
                '*** Begin Patch\n*** Add File: direct.txt\n' +
                directText
                  .trimEnd()
                  .split('\n')
                  .map((line) => '+' + line)
                  .join('\n') +
                '\n*** End Patch'
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else if (requests.length === 2) {
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'only-cell',
              arguments: overrides.protocol === 'ANTHROPIC_MESSAGES' ? { code } : code
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      const agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [configuration]
        },
        () => adapter
      );
      try {
        const session = await agent.createSession({ workspace, title: 'Code Mode Only' });
        const execution = session.run({ prompt: 'Read and patch using Code Mode.' });
        const events = [];
        for await (const event of execution) events.push(event);
        expect((await execution.result()).status).toBe('completed');
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'tool.completed',
            callId: 'compatible-direct'
          })
        );
        expect(events.filter((event) => event.type === 'tool.failed')).toEqual([]);
        expect(await readFile(join(workspace, 'direct.txt'), 'utf8')).toBe(directText);
        expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('done\n');
        for (const request of requests) {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            'apply_patch',
            'code_exec',
            'code_exec_wait',
            'exec_wait',
            'sleep'
          ]);
          expect(effectiveInstructions(request)).toContain(
            'Available client tools: apply_patch, code_exec, code_exec_wait, exec_wait, sleep.'
          );
          expect(effectiveInstructions(request)).toContain('Code Mode Only');
          const onlyLine = /Code Mode Only: ([^.]+) are callable/.exec(
            effectiveInstructions(request)
          )?.[1];
          expect(onlyLine).toBeDefined();
          expect(onlyLine).not.toContain('apply_patch');
          expect(onlyLine).not.toContain('exec_wait');
          expect(effectiveInstructions(request)).toContain('Use read to batch');
          expect(effectiveInstructions(request)).not.toContain('# Subagents');
          const description = request.tools.find((tool) => tool.name === 'code_exec')!.description;
          expect(description).toContain('"name":"read"');
          expect(description).toContain('"inputSchema"');
          expect(description).not.toContain('other schemas are provided by their direct');
        }
      } finally {
        await agent.dispose();
      }
    }
  );

  it('keeps full cell output inside the tool while bounding model-visible history to 10000 tokens', async () => {
    const { home, workspace } = await fixture();
    const requests: ModelRequest[] = [];
    let calls = 0;
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request): AsyncIterable<ModelEvent> {
        requests.push(request);
        if (++calls === 1) {
          yield {
            type: 'client_tool.call',
            name: 'code_exec',
            callId: 'large-code-output',
            inputMode: 'freeform',
            arguments: `observe.text("x".repeat(80000));`
          };
          yield { type: 'completed', reason: 'tool_use' };
          return;
        }
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Bounded Code Mode output' });
      expect(await session.run({ prompt: 'Emit a large value.' }).result()).toMatchObject({
        status: 'completed'
      });
      const output = requests[1]?.messages.find(
        (message) => message.role === 'tool' && message.callId === 'large-code-output'
      )?.content;
      expect(output).toContain('Warning: truncated output (original token count: 20000)');
      expect(output).toContain('tokens of tool output omitted');
      expect(output).not.toBe('x'.repeat(80_000));
      const store = await JsonlSessionStore.open(home);
      try {
        const completed = (await store.read(session.id)).find(
          (record) =>
            record.type === 'tool.completed' &&
            (record.payload as { callId?: string }).callId === 'large-code-output'
        );
        expect(completed?.payload).toMatchObject({
          toolName: 'code_exec',
          truncated: true
        });
      } finally {
        await store.close();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('restores valid large code cells whose JSON escaping exceeds the ordinary record limit', async () => {
    const { home, workspace } = await fixture();
    const testModel = { ...model, contextWindowTokens: 2_000_000 };
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: testModel,
      async *start(request) {
        requests.push(request);
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const create = () =>
      createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [testModel]
        },
        () => adapter
      );
    let agent = await create();
    let id: string;
    try {
      id = (await agent.createSession({ workspace, title: 'Large code history' })).id;
    } finally {
      await agent.dispose();
    }
    const source = `/*${'"'.repeat(600_000)}*/ observe.text('done');`;
    const store = await JsonlSessionStore.open(home);
    try {
      await store.append(id!, { type: 'turn.user', payload: { prompt: 'Previous task.' } });
      for (const payload of [
        {
          role: 'tool_call',
          content: '',
          name: 'code_exec',
          callId: 'large',
          inputMode: 'freeform',
          arguments: source
        },
        {
          role: 'provider',
          provider: 'OPENAI_RESPONSES',
          providerModelId: model.id,
          content: '',
          item: {
            type: 'custom_tool_call',
            id: 'large-item',
            call_id: 'large',
            name: 'code_exec',
            input: source
          }
        },
        { role: 'tool', callId: 'large', content: 'done' }
      ])
        await store.append(id!, { type: 'model.context', payload });
    } finally {
      await store.close();
    }
    agent = await create();
    try {
      const session = await agent.openSession(id!);
      expect(
        (await session.run({ prompt: 'Continue without repeating completed work.' }).result())
          .status
      ).toBe('completed');
      const messages = requests.at(-1)!.messages;
      expect(messages.find((message) => message.role === 'tool_call')?.arguments).toBe(source);
      expect(messages.find((message) => message.role === 'provider')?.item?.input).toBe(source);
      expect(messages.find((message) => message.role === 'tool')?.callId).toBe('large');
    } finally {
      await agent.dispose();
    }
  });

  it('does not advertise Code Mode when the Host omits code.execute', async () => {
    const { home, workspace } = await fixture();
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const describe = host.describe.bind(host);
    host.describe = async () => {
      const description = await describe();
      return {
        ...description,
        capabilities: description.capabilities.filter((capability) => capability !== 'code.execute')
      };
    };
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      configuration: model,
      async *start(request) {
        requests.push(request);
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'No Code Mode' });
      expect((await session.run({ prompt: 'Hello.' }).result()).status).toBe('completed');
      expect(requests[0]?.tools.some((tool) => tool.name === 'code_exec')).toBe(false);
      expect(requests[0]?.tools.some((tool) => tool.name === 'exec')).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('does not advertise Code Mode when the selected model leaves it disabled', async () => {
    const { home, workspace } = await fixture();
    const requests: ModelRequest[] = [];
    const disabledModel = { ...model, codeMode: false };
    const adapter: ModelAdapter = {
      configuration: disabledModel,
      async *start(request) {
        requests.push(request);
        yield { type: 'text.completed', itemId: 'answer', text: 'done' };
        yield { type: 'completed', reason: 'completed' };
      }
    };
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [disabledModel]
      },
      () => adapter
    );
    try {
      const session = await agent.createSession({ workspace, title: 'Disabled Code Mode' });
      expect((await session.run({ prompt: 'Hello.' }).result()).status).toBe('completed');
      expect(requests[0]?.tools.some((tool) => tool.name === 'code_exec')).toBe(false);
      expect(requests[0]?.tools.some((tool) => tool.name === 'exec')).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it.each(
    [false, true].flatMap((codeMode) => [false, true].map((complete) => ({ codeMode, complete })))
  )(
    'preserves image results and durable WS diagnostics for codeMode=$codeMode complete=$complete',
    async ({ codeMode, complete }) => {
      const { home, workspace } = await fixture();
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      );
      await writeFile(join(workspace, 'image.png'), complete ? png : png.subarray(0, 8));
      const toolCall = codeMode
        ? {
            ...callItem,
            input:
              'const results = await Promise.all([tools.view_image({path:"image.png"}), tools.view_image({path:"image.png"})]); for (const result of results) observe.result(result);'
          }
        : {
            type: 'function_call',
            id: 'item-image',
            call_id: 'call-image',
            name: 'view_image',
            arguments: JSON.stringify({ path: 'image.png' })
          };
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [response('first', [toolCall]), response('second', [answer])],
        maxClientFrameBytes: 1_048_576
      });
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [
          {
            ...model,
            codeMode,
            inputCapabilities: ['TEXT', 'IMAGE'],
            baseUrl: server.baseUrl,
            responsesTransport: { transport: 'WEBSOCKET' }
          }
        ]
      });
      let id = '';
      const imageCount = complete ? (codeMode ? 2 : 1) : 0;
      try {
        const session = await agent.createSession({
          workspace,
          title: 'Image WebSocket integration'
        });
        id = session.id;
        expect(await session.run({ prompt: 'Inspect the image.' }).result()).toMatchObject({
          status: 'completed',
          finalAnswer: 'done'
        });
        expect(server.requests).toHaveLength(2);
        expect(server.connections()).toBe(1);
        const body = server.requests[1] as { input: Array<{ type: string; output?: unknown }> };
        const output = body.input.find(
          (item) => item.type === (codeMode ? 'custom_tool_call_output' : 'function_call_output')
        )!.output;
        const images = Array.isArray(output)
          ? output.filter((item) => item.type === 'input_image')
          : [];
        expect(images).toHaveLength(imageCount);
        for (const image of images)
          expect(image.image_url).toBe(`data:image/png;base64,${png.toString('base64')}`);
        if (!complete) expect(JSON.stringify(output)).toContain('MAR_AGENT_IMAGE_INCOMPLETE');
      } finally {
        await agent.dispose();
        await new Promise<void>((resolve, reject) =>
          server.server.close((error) => (error ? reject(error) : resolve()))
        );
      }
      const store = await JsonlSessionStore.open(home);
      try {
        const records = await store.read(id);
        const terminal = records.findLast(
          (record) =>
            record.type === 'model.attempt' &&
            (record.payload as { state?: string }).state === 'SUCCEEDED'
        )!;
        expect(terminal.payload).toMatchObject({
          imageCount,
          imageBytes: imageCount * png.length,
          webSocketPhase: 'RECEIVE',
          continuation: true,
          requestBytes: Buffer.byteLength(JSON.stringify(server.requests[1]))
        });
        const diagnostic = terminal.payload as {
          requestFrameCount: number;
          sentFrameCount: number;
        };
        expect(diagnostic.requestFrameCount).toBeGreaterThan(0);
        expect(diagnostic.sentFrameCount).toBe(diagnostic.requestFrameCount);
        expect(JSON.stringify(records)).not.toContain(png.toString('base64'));
        expect(JSON.stringify(records)).not.toContain('test-key');
      } finally {
        await store.close();
      }
    }
  );

  it.each(['STANDARD'] as const)(
    'executes Code Mode through %s WS and preserves incremental continuation',
    async (_encoding) => {
      const { home, workspace } = await fixture();
      const server = await startResponsesWebSocketServer([], {
        responsesByRequest: [response('first', [callItem]), response('second', [answer])]
      });
      const agent = await createMarAgent({
        mode: 'normal',
        host: new LocalAgentHost({ homeDirectory: home, workspace }),
        models: [
          {
            ...model,
            baseUrl: server.baseUrl,
            responsesTransport: { transport: 'WEBSOCKET' }
          }
        ]
      });
      let id = '';
      try {
        const session = await agent.createSession({ workspace, title: 'Code Mode' });
        id = session.id;
        const execution = session.run({
          prompt: 'Read input and create output.'
        });
        const events = [];
        for await (const event of execution) events.push(event);
        expect(await execution.result()).toMatchObject({
          status: 'completed',
          finalAnswer: 'done'
        });
        expect(events.filter((e) => e.type === 'tool.started').map((e) => e.toolName)).toEqual([
          'code_exec',
          'read',
          'apply_patch'
        ]);
        for (const event of events) {
          if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue;
          if (event.callId === 'call-code') expect(event).not.toHaveProperty('parentCallId');
          else expect(event).toHaveProperty('parentCallId', 'call-code');
        }
        const wire = JSON.stringify(server.requests[0]);
        expect(wire).toContain('Programmatic tools');
        expect(wire).toContain('callableNames');
        expect(wire).not.toContain('ToolResults');
        expect(wire).not.toContain('"outputSchema":');
        expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('done\n');
        expect(server.connections()).toBe(1);
        expect(server.requests).toHaveLength(2);
        expect(server.requests.at(-1)).toMatchObject({
          previous_response_id: 'first',
          input: [
            {
              type: 'custom_tool_call_output',
              call_id: 'call-code',
              output: [
                { type: 'input_text', text: expect.stringContaining('"status":"completed"') },
                {
                  type: 'input_text',
                  text: '{"type":"value","format":"json"}\n{"read":true,"files":1}'
                }
              ]
            }
          ]
        });
      } finally {
        await agent.dispose();
        await new Promise<void>((resolve, reject) =>
          server.server.close((error) => (error ? reject(error) : resolve()))
        );
      }
      const store = await JsonlSessionStore.open(home);
      try {
        const records = await store.read(id);
        const calls = records.filter(
          (r) => r.type === 'model.context' && (r.payload as { role?: string }).role === 'tool_call'
        );
        expect(calls.map((r) => (r.payload as { name: string }).name)).toEqual(['code_exec']);
        expect(records.filter((r) => r.type === 'tool.started').map((r) => r.payload)).toEqual([
          expect.not.objectContaining({ parentCallId: expect.anything() }),
          expect.objectContaining({ toolName: 'read', parentCallId: 'call-code' }),
          expect.objectContaining({ toolName: 'apply_patch', parentCallId: 'call-code' })
        ]);
      } finally {
        await store.close();
      }
    }
  );

  it('uses Anthropic JSON code input and keeps tool_result immediately after tool_use', async () => {
    const { home, workspace } = await fixture();
    const bodies: Array<{ readonly tools: unknown; readonly messages: unknown[] }> = [];
    const server = createServer((request, result) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        bodies.push(JSON.parse(body) as { readonly tools: unknown; readonly messages: unknown[] });
        const first = bodies.length === 1;
        const events = [
          {
            type: 'message_start',
            message: { id: `m-${bodies.length}`, usage: { input_tokens: 100, output_tokens: 0 } }
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: first
              ? { type: 'tool_use', id: 'call-code', name: 'code_exec', input: { code } }
              : { type: 'text', text: 'done' }
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: 10 }
          },
          { type: 'message_stop' }
        ];
        result.writeHead(200, { 'content-type': 'text/event-stream' });
        result.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server');
    const agent = await createMarAgent({
      mode: 'normal',
      host: new LocalAgentHost({ homeDirectory: home, workspace }),
      models: [
        {
          ...model,
          protocol: 'ANTHROPIC_MESSAGES',
          responsesPreviousResponseId: false,
          baseUrl: `http://127.0.0.1:${address.port}`
        }
      ]
    });
    try {
      const session = await agent.createSession({ workspace, title: 'Anthropic Code Mode' });
      expect(await session.run({ prompt: 'Read and patch.' }).result()).toMatchObject({
        status: 'completed',
        finalAnswer: 'done'
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]!.tools).toContainEqual(
        expect.objectContaining({
          name: 'code_exec',
          input_schema: expect.objectContaining({ required: ['code'] })
        })
      );
      expect(bodies[1]!.messages.slice(-2)).toMatchObject([
        { role: 'assistant', content: [{ type: 'tool_use', name: 'code_exec', input: { code } }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-code',
              content: [
                { type: 'text', text: expect.stringContaining('"status":"completed"') },
                { type: 'text', text: '{"type":"value","format":"json"}\n{"read":true,"files":1}' }
              ]
            }
          ]
        }
      ]);
      expect(await readFile(join(workspace, 'output.txt'), 'utf8')).toBe('done\n');
    } finally {
      await agent.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
    'preserves %s child Code Mode and private native evidence through the external extension',
    async (protocol) => {
      const { home, workspace } = await fixture();
      const requests: ModelRequest[] = [];
      const testModel = { ...model, protocol, responsesPreviousResponseId: false };
      const nativeItem =
        protocol === 'ANTHROPIC_MESSAGES'
          ? { type: 'thinking', thinking: '', signature: 'CHILD_PRIVATE_SIGNATURE' }
          : {
              type: 'reasoning',
              id: 'child-reasoning',
              encrypted_content: 'CHILD_PRIVATE_SIGNATURE'
            };
      const adapter: ModelAdapter = {
        configuration: testModel,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          const child = request.messages.some(
            (message) =>
              message.role === 'user' && message.content.includes('Read input and patch output.')
          );
          const results = request.messages.filter((message) => message.role === 'tool');
          if (child && results.length === 0) {
            yield {
              type: 'response.item',
              provider: protocol,
              ...(protocol === 'ANTHROPIC_MESSAGES' ? { contextKind: 'private' as const } : {}),
              item: nativeItem
            };
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: 'child-code',
              arguments: code,
              inputMode: 'freeform'
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else if (!child && results.length < 5) {
            const controls = ['agent_start', 'agent_wait', 'agent_send', 'agent_stop'];
            for (const name of controls) {
              expect(
                request.tools.find((tool) => tool.name === 'code_exec')!.description
              ).toContain(`"${name}"`);
            }
            const name = ['agent_start', 'agent_wait', 'agent_send', 'agent_wait', 'agent_stop'][
              results.length
            ]!;
            const agentId = results.length ? observedJSON(results[0]!.content).agentId : undefined;
            const input =
              name === 'agent_start'
                ? {
                    description: 'Read and patch',
                    title: 'Read and patch',
                    prompt: 'Read input and patch output.',
                    role: 'general-purpose'
                  }
                : name === 'agent_send'
                  ? { agentId, content: 'Confirm the completed patch.' }
                  : { agentId };
            yield {
              type: 'client_tool.call',
              name: 'code_exec',
              callId: `parent-${name}-${results.length}`,
              inputMode: 'freeform',
              arguments: `const result = await tools.${name}(${JSON.stringify(input)}); observe.text(JSON.stringify(result.data));`
            };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield {
              type: 'text.completed',
              itemId: child ? 'child-answer' : 'parent-answer',
              text: 'done'
            };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      };
      let agent!: Awaited<ReturnType<typeof createMarAgent>>;
      agent = await createMarAgent(
        {
          mode: 'normal',
          host: new LocalAgentHost({ homeDirectory: home, workspace }),
          models: [testModel],
          extensions: [createSubagentExtension({ agent: () => agent })]
        },
        () => adapter
      );
      try {
        await agent.reconfigureModels({ models: [{ ...testModel, subagentModel: true }] });
        const session = await agent.createSession({ workspace, title: 'Subagent Code Mode' });
        const parentResult = await session.run({ prompt: 'Delegate.' }).result();
        expect(parentResult.status, JSON.stringify(parentResult)).toBe('completed');
        const child = requests
          .filter((r) =>
            r.messages.some(
              (message) =>
                message.role === 'user' && message.content.includes('Read input and patch output.')
            )
          )
          .at(-1)!;
        expect(child.messages).toContainEqual({
          role: 'provider',
          provider: protocol,
          providerModelId: model.id,
          ...(protocol === 'ANTHROPIC_MESSAGES' ? { contextKind: 'private' } : {}),
          content: '',
          item: nativeItem
        });
        expect(child.messages.filter((m) => m.role === 'tool').map((m) => m.callId)).toEqual([
          'child-code'
        ]);
        const childCodeModeDescription = child.tools.find(
          (tool) => tool.name === 'code_exec'
        )?.description;
        expect(childCodeModeDescription).toContain('Programmatic tools');
        expect(childCodeModeDescription).toContain('callableNames');
        expect(childCodeModeDescription).not.toContain('ToolResults');
        expect(childCodeModeDescription).toContain('"agent_start"');
        expect(child.messages).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Confirm the completed patch.')
          })
        );
        const parent = requests.at(-1)!;
        expect(JSON.stringify(parent.messages)).not.toContain('CHILD_PRIVATE_SIGNATURE');
        expect(
          parent.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.name)
        ).toEqual(['code_exec', 'code_exec', 'code_exec', 'code_exec', 'code_exec']);
        const task = observedJSON(
          parent.messages.find((m) => m.role === 'tool' && m.callId === 'parent-agent_wait-1')!
            .content
        );
        expect(task.agentId).toEqual(expect.any(String));
        expect(task).not.toHaveProperty('taskId');
        expect(task.status).toBe('completed');
        expect(task.changedFiles).toContain('output.txt');
        expect(task).not.toHaveProperty('evidence');
        expect(task).not.toHaveProperty('verification');
        expect(task.summary ?? task.latestMessage?.text).toBe('done');
        const store = await JsonlSessionStore.open(home);
        const records = await store.read(task.agentId);
        const read = records.find(
          (record) => record.type === 'tool.completed' && record.payload.toolName === 'read'
        );
        expect(read?.payload).toMatchObject({
          data: {
            results: [expect.objectContaining({ path: expect.stringContaining('input.txt') })]
          }
        });
      } finally {
        await agent.dispose();
      }
    }
  );
});
