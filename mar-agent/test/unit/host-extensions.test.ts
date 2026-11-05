import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalAgentHost, type HostSkill } from '../../src/host.js';
import { parseModelCatalog, type Agent } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { type ModelEvent } from '../../src/model/contracts.js';
import { loadAgentInstructions, loadAgentSkill } from '../../src/runtime/context/instructions.js';
import { directLocalProcessExecutor } from '../../src/host/local-process-executor.js';
import { createSubagentExtension } from '../../extensions/subagent/src/index.js';
import { waitForNewChild } from './support/subagent-wait.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-host-extensions-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  return { home, workspace };
}
const skill: HostSkill = {
  name: 'host-workflow',
  description: 'A host workflow.',
  requiredTools: ['host_action'],
  load: async () => 'Host workflow instructions.'
};
const tool = { name: 'host_action', description: 'Host action.', inputSchema: {} };

it('projects and enforces a model-specific Host directory within a shared execution binding', async () => {
  const paths = await fixture();
  const executeTool = vi.fn(async () => ({ content: 'ALLOWED' }));
  const host = new LocalAgentHost({ homeDirectory: paths.home, workspace: paths.workspace });
  const binding = host.bindExecutionExtensions({
    tools: [tool],
    executeTool,
    isToolAvailable: (_name: string, context: { modelId?: string }) =>
      context.modelId === 'child-model'
  });
  const root = {
    sessionId: 'root',
    executionId: 'root-execution',
    modelId: 'root-model',
    claimExecutionScope: true
  };
  const child = {
    sessionId: 'child',
    executionId: 'child-execution',
    modelId: 'child-model',
    executionScopeId: root.executionId
  };
  try {
    expect((await host.listExecutionExtensions(root)).tools).toEqual([]);
    expect((await host.listExecutionExtensions(child)).tools).toEqual([tool]);
    await expect(
      host.executeTool(
        { name: tool.name, arguments: {} },
        { ...root, mode: 'run', signal: new AbortController().signal }
      )
    ).rejects.toThrow();
    await expect(
      host.executeTool(
        { name: tool.name, arguments: {} },
        { ...child, mode: 'run', signal: new AbortController().signal }
      )
    ).resolves.toEqual({ content: 'ALLOWED' });
    expect(executeTool).toHaveBeenCalledOnce();
  } finally {
    host.unbindExecutionMcp(binding);
    await host.dispose();
  }
});

it('uses the selected child model for generic Host policies and tool execution', async () => {
  const paths = await fixture();
  const models = parseModelCatalog({
    version: 1,
    models: ['parent', 'child'].map((id) => ({
      id,
      name: id,
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      apiKey: 'unused',
      modelId: id,
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      conversationModel: true,
      subagentModel: true,
      hostedWebSearch: false,
      enabled: true
    }))
  }).models;
  const seen: string[] = [];
  const catalogs: Record<string, string[]> = {};
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    extensions: {
      tools: [tool],
      isToolAvailable: (_name, context) => context.modelId === 'child',
      executeTool: async (_call, context) => {
        seen.push(context.modelId!);
        return { content: 'CHILD_OK' };
      }
    }
  });
  const rounds = new Map<string, number>();
  const agent: Agent = await createMarAgent(
    {
      mode: 'normal',
      host,
      models,
      defaultModelId: 'parent',
      extensions: [createSubagentExtension({ agent: () => agent })]
    },
    (configuration) => ({
      configuration,
      async *start(request): AsyncIterable<ModelEvent> {
        catalogs[configuration.id] = request.tools.map((entry) => entry.name);
        const round = (rounds.get(configuration.id) ?? 0) + 1;
        rounds.set(configuration.id, round);
        if (round === 1) {
          yield {
            type: 'client_tool.call',
            callId: `${configuration.id}-call`,
            name: configuration.id === 'parent' ? 'agent_start' : tool.name,
            arguments:
              configuration.id === 'parent'
                ? {
                    title: 'Child task',
                    description: 'Child task',
                    prompt: 'Use the host action.',
                    role: 'general-purpose',
                    modelId: 'child'
                  }
                : {}
          };
          yield { type: 'completed', reason: 'tool_use' };
        } else if (configuration.id === 'parent' && round === 2) {
          const wait = waitForNewChild(request);
          if (!wait) throw new Error('Expected the external subagent start receipt.');
          yield wait;
          yield { type: 'completed', reason: 'tool_use' };
        } else {
          yield { type: 'text.completed', itemId: `${configuration.id}-answer`, text: 'Done' };
          yield { type: 'completed', reason: 'completed' };
        }
      }
    })
  );
  try {
    const session = await agent.createSession({
      workspace: paths.workspace,
      title: 'Model policies'
    });
    expect(await session.run({ prompt: 'Use the child.' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(catalogs['parent']).not.toContain(tool.name);
    expect(catalogs['child']).toContain(tool.name);
    expect(seen).toEqual(['child']);
  } finally {
    await agent.dispose();
  }
});

it('scopes process credentials to the originating execution without exposing them as extensions', async () => {
  const paths = await fixture();
  const observed: Array<string | undefined> = [];
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    processExecutor: {
      spawn: async (request) => {
        observed.push(request.environment['EXECUTION_TEST_TOKEN']);
        return directLocalProcessExecutor.spawn(request);
      }
    }
  });
  const context = {
    sessionId: 'session',
    executionId: 'first',
    mode: 'run' as const,
    signal: new AbortController().signal
  };
  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`;
  const invoke = (executionId: string) =>
    host.executeTool(
      { name: 'exec', arguments: { command, yieldMs: 1000 } },
      { ...context, executionId }
    );
  try {
    const environment = { EXECUTION_TEST_TOKEN: 'first-fixture' };
    const first = host.bindExecutionExtensions({ environment });
    environment.EXECUTION_TEST_TOKEN = 'mutated';
    const visible = await host.listExecutionExtensions({ ...context, claimExecutionScope: true });
    expect(visible).not.toHaveProperty('environment');
    await invoke('first');
    const second = host.bindExecutionExtensions({
      environment: { EXECUTION_TEST_TOKEN: 'second-fixture' }
    });
    await host.listExecutionExtensions({
      ...context,
      executionId: 'second',
      claimExecutionScope: true
    });
    await invoke('first');
    await invoke('second');
    host.unbindExecutionMcp(first);
    await invoke('first');
    await invoke('second');
    host.unbindExecutionMcp(second);
    await invoke('second');
    expect(observed).toEqual([
      'first-fixture',
      'first-fixture',
      'second-fixture',
      undefined,
      'second-fixture',
      undefined
    ]);
  } finally {
    await host.dispose();
  }
});

it('loads host skills lazily and filters them by the actual tool catalog', async () => {
  const paths = await fixture();
  const load = vi.fn(skill.load);
  const hostSkills = [{ ...skill, load }];
  const hidden = await loadAgentInstructions({ ...paths, hostSkills });
  expect(hidden.skills.size).toBe(0);
  const context = await loadAgentInstructions({
    ...paths,
    hostSkills,
    availableTools: new Set([tool.name])
  });
  expect(context.skillCatalog).toContain('Host-provided');
  expect(context.skillCatalog).not.toContain('Host workflow instructions.');
  expect(load).not.toHaveBeenCalled();
  const content = await loadAgentSkill(context.skills.get(skill.name)!);
  expect(content).toContain('Host workflow instructions.');
  expect(content).not.toContain('Base directory for this skill:');
  expect(load).toHaveBeenCalledOnce();
});

it('rechecks the frozen MCP binding after an asynchronous Host policy hook', async () => {
  const paths = await fixture();
  const definition = {
    name: 'mcp__fixture__read',
    description: 'Read fixture.',
    inputSchema: { type: 'object', properties: {} }
  };
  let revision = 'v1';
  const callMcp = vi.fn(async () => ({ content: 'unexpected' }));
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    callMcp,
    mcpCatalog: () => ({
      revision,
      servers: [{ id: 'fixture', name: 'Fixture' }],
      tools: [
        {
          definition,
          serverId: 'fixture',
          rawName: 'read',
          sourceIdentity: 'fixture:actor',
          definitionRevision: revision,
          lifetime: 'session',
          exposure: 'deferred'
        }
      ]
    }),
    beforeToolExecute: async () => {
      await Promise.resolve();
      revision = 'v2';
    }
  });
  try {
    await expect(
      host.callMcpTool({ name: definition.name, arguments: {} }, new AbortController().signal, {
        sessionId: 'session',
        executionId: 'execution',
        expectedTool: { sourceIdentity: 'fixture:actor', definitionRevision: 'v1' }
      })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED' });
    expect(callMcp).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it('preserves file overrides and rejects duplicate host names', async () => {
  const paths = await fixture();
  const directory = join(paths.workspace, '.agents', 'skills', skill.name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    '---\ndescription: Workspace workflow\n---\nLocal instructions.'
  );
  const context = await loadAgentInstructions({
    ...paths,
    hostSkills: [skill],
    availableTools: new Set([tool.name])
  });
  expect(await loadAgentSkill(context.skills.get(skill.name)!)).toContain('Local instructions.');
  await expect(
    loadAgentInstructions({
      ...paths,
      hostSkills: [skill, skill]
    })
  ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
});

it('uses one execution binding for extensions and MCP without leaking into later executions', async () => {
  const paths = await fixture();
  const beforeToolExecute = vi.fn();
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    beforeToolExecute
  });
  const executeTool = vi.fn(async () => ({ content: 'first' }));
  const binding = host.bindExecutionExtensions({ tools: [tool], skills: [skill], executeTool });
  const catalog = { sessionId: 'session', executionId: 'first', claimExecutionScope: true };
  expect((await host.listExecutionExtensions(catalog)).skills).toEqual([skill]);
  const context = {
    sessionId: 'session',
    executionId: 'first',
    mode: 'run' as const,
    signal: new AbortController().signal
  };
  expect(await host.executeTool({ name: tool.name, arguments: {} }, context)).toEqual({
    content: 'first'
  });
  expect(beforeToolExecute).toHaveBeenCalledOnce();
  host.unbindExecutionMcp(binding);
  const next = host.bindExecutionExtensions({
    tools: [tool],
    executeTool: async () => ({ content: 'second' })
  });
  await host.listExecutionExtensions({ ...catalog, executionId: 'second' });
  await expect(host.executeTool({ name: tool.name, arguments: {} }, context)).rejects.toThrow();
  expect(executeTool).toHaveBeenCalledOnce();
  expect(
    await host.executeTool(
      { name: tool.name, arguments: {} },
      { ...context, executionId: 'second' }
    )
  ).toEqual({ content: 'second' });
  host.unbindExecutionMcp(next);
  await host.dispose();
});

it('injects a generic tool and forwards its call context', async () => {
  const paths = await fixture();
  const executeTool = vi.fn(async () => ({ content: 'HOST_EXTENSION_OK' }));
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    extensions: { tools: [tool], executeTool }
  });
  const context = {
    mode: 'run' as const,
    signal: new AbortController().signal,
    sessionId: 'session',
    executionId: 'execution'
  };
  try {
    await expect(host.listExecutionExtensions(context)).resolves.toMatchObject({ tools: [tool] });
    await expect(
      host.executeTool({ name: tool.name, arguments: { value: 'input' } }, context)
    ).resolves.toEqual({ content: 'HOST_EXTENSION_OK' });
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      { name: tool.name, arguments: { value: 'input' } },
      context
    );
  } finally {
    await host.dispose();
  }
});

it('does not invoke a cancelled Host extension', async () => {
  const paths = await fixture();
  const executeTool = vi.fn(async () => ({ content: 'unexpected' }));
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    extensions: { tools: [tool], executeTool }
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      host.executeTool(
        { name: tool.name, arguments: {} },
        {
          mode: 'run',
          signal: controller.signal,
          sessionId: 'session',
          executionId: 'execution'
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeTool).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it('revokes execution-scoped extension access when its binding is unbound', async () => {
  const paths = await fixture();
  const executeTool = vi.fn(async () => ({ content: 'BOUND' }));
  const host = new LocalAgentHost({ homeDirectory: paths.home, workspace: paths.workspace });
  const binding = host.bindExecutionExtensions({ tools: [tool], executeTool });
  const context = {
    mode: 'run' as const,
    signal: new AbortController().signal,
    sessionId: 'session',
    executionId: 'execution'
  };
  try {
    await host.listExecutionExtensions({ ...context, claimExecutionScope: true });
    await expect(host.executeTool({ name: tool.name, arguments: {} }, context)).resolves.toEqual({
      content: 'BOUND'
    });
    host.unbindExecutionMcp(binding);
    await expect(host.executeTool({ name: tool.name, arguments: {} }, context)).rejects.toThrow();
    expect(executeTool).toHaveBeenCalledOnce();
  } finally {
    await host.dispose();
  }
});

it('does not execute a host tool when the local hook rejects it', async () => {
  const paths = await fixture();
  const executeTool = vi.fn(async () => ({ content: 'never' }));
  const host = new LocalAgentHost({
    homeDirectory: paths.home,
    workspace: paths.workspace,
    beforeToolExecute: () => {
      throw new Error('rejected');
    },
    extensions: { tools: [tool], executeTool }
  });
  try {
    await expect(
      host.executeTool(
        { name: tool.name, arguments: {} },
        {
          sessionId: 's',
          executionId: 'e',
          mode: 'run',
          signal: new AbortController().signal
        }
      )
    ).rejects.toThrow('rejected');
    expect(executeTool).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
  }
});

it.each([
  { useResourceUrl: false, codeMode: false },
  { useResourceUrl: true, codeMode: false },
  { useResourceUrl: true, codeMode: true }
])(
  'keeps image snapshots batch-scoped and accepts generic host artifacts (%j)',
  async ({ useResourceUrl, codeMode }) => {
    const paths = await fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    const seen: number[] = [];
    const imageTool = { ...tool, allowedCallers: ['direct', 'programmatic'] as const };
    const model = parseModelCatalog({
      version: 1,
      models: [
        {
          id: 'test',
          name: 'Test',
          protocol: 'ANTHROPIC_MESSAGES',
          baseUrl: 'https://example.test',
          apiKey: 'unused',
          modelId: 'test',
          contextWindowTokens: 200_000,
          maxOutputTokens: 4096,
          inputCapabilities: ['TEXT', 'IMAGE'],
          outputCapabilities: ['TEXT'],
          reasoningEfforts: [],
          useResourceUrl,
          codeMode,
          hostedWebSearch: false,
          enabled: true
        }
      ]
    }).models[0]!;
    let round = 0;
    const host = new LocalAgentHost({
      homeDirectory: paths.home,
      workspace: paths.workspace,
      ...(useResourceUrl
        ? {
            publishModelResource: async () => ({
              url: 'https://images.example.test/fixed.png',
              urlExpiresAt: 1
            })
          }
        : {}),
      extensions: {
        tools: [imageTool],
        executeTool: async (_call, context) => {
          seen.push(context.recentImages?.length ?? 0);
          // The handler cannot mutate the Runtime's copy.
          expect(context.recentImages?.[0]?.data[0]).toBe(0x89);
          context.recentImages?.[0]?.data.fill(0);
          return {
            content: 'Observed.',
            images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }],
            artifacts: [
              {
                kind: 'image',
                name: 'result.png',
                fileName: 'result.png',
                mimeType: 'image/png',
                byteSize: png.length,
                sha256: 'a'.repeat(64)
              }
            ]
          };
        }
      }
    });
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [model]
      },
      (configuration) => ({
        configuration,
        async *start(): AsyncIterable<ModelEvent> {
          round++;
          if (round <= 2) {
            if (codeMode) {
              yield {
                type: 'client_tool.call',
                callId: `code-${round}`,
                name: 'code_exec',
                inputMode: 'freeform',
                arguments: Array.from(
                  { length: round === 1 ? 2 : 1 },
                  (_, i) => `observe.result(await tools.host_action({sample:"${round}-${i}"}));`
                ).join('\n')
              };
            } else
              for (let i = 0; i < (round === 1 ? 2 : 1); i++)
                yield {
                  type: 'client_tool.call',
                  callId: `${round}-${i}`,
                  name: tool.name,
                  arguments: { sample: `${round}-${i}` }
                };
            yield { type: 'completed', reason: 'tool_use' };
          } else {
            yield { type: 'text.completed', itemId: 'answer', text: 'Done' };
            yield { type: 'completed', reason: 'completed' };
          }
        }
      })
    );
    try {
      const session = await agent.createSession({
        workspace: paths.workspace,
        title: 'Image snapshots'
      });
      expect(
        await session
          .run({
            prompt: 'Inspect',
            images: [
              { name: 'input.png', mimeType: 'image/png', dataBase64: png.toString('base64') }
            ]
          })
          .result()
      ).toMatchObject({ status: 'completed' });
      expect(seen).toEqual([1, 1, 3]);
      expect(host.events.filter((event) => event.type === 'tool.failed')).toEqual([]);
      expect(
        host.events.filter(
          (event) =>
            event.type === 'tool.completed' &&
            event.toolName === tool.name &&
            event.artifacts?.length === 1
        )
      ).toHaveLength(3);
      host.bindExecutionExtensions({ tools: [{ ...tool, name: 'read' }] });
      expect(await session.run({ prompt: 'Reject the conflicting tool.' }).result()).toMatchObject({
        status: 'failed'
      });
      expect(round).toBe(3);
    } finally {
      await agent.dispose();
    }
  }
);
