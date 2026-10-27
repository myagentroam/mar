import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAgentInstructions, loadAgentSkill } from '../../src/runtime/context/instructions.js';
import { executeRegisteredTool } from '../../src/tools/runtime.js';
import type { ToolRuntimeContext } from '../../src/tools/runtime-context.js';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter as createMarAgent } from '../../src/sdk/agent.js';
import { type ModelEvent, type ModelRequest } from '../../src/model/contracts.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mar-builtin-skills-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  return { home, workspace, hostSkills: [hostSkill] };
}

const availableTools = new Set(['host_action', 'view_image']);
const hostSkill = {
  name: 'host-workflow',
  description: 'Host action workflow',
  requiredTools: ['host_action'],
  load: async () => '## Host workflow\nOnly when the user requests host_action.'
};
const hostExtensions = {
  tools: [{ name: 'host_action', description: 'Host action', inputSchema: {} }],
  skills: [hostSkill],
  executeTool: async () => ({ content: 'Action complete' })
};

function latestTaskMessage(request: ModelRequest) {
  return request.messages
    .filter((message) => !(message.role === 'user' && message.contextKind === 'contextual'))
    .at(-1);
}

function skillCatalog(request: ModelRequest) {
  const message = request.messages.findLast(
    (message) => message.role === 'user' && message.contextualBlock?.id === 'core:skill-catalog'
  );
  return message?.role === 'user' && message.contextualBlock?.operation === 'replace'
    ? message.content
    : '';
}

describe('Host-provided skills', () => {
  it('projects host defaults from the selected model without automatically loading or invoking them', async () => {
    const paths = await fixture();
    const provider = {
      acquire: vi.fn(async () => ({
        revision: 1,
        expiresAt: Date.now() + 60_000,
        bearer: new SecretValue('unused-image-token')
      })),
      invalidate: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const imageModel: AgentModelConfiguration = {
      id: 'image',
      name: 'Image',
      modelId: 'test-image',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      credentialProvider: provider,
      enabled: true,
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['medium'],
      hostedWebSearch: false,
      codeMode: true
    };
    const { credentialProvider, ...common } = imageModel;
    void credentialProvider;
    const textModel: AgentModelConfiguration = {
      ...common,
      id: 'text',
      inputCapabilities: ['TEXT'],
      apiKey: new SecretValue('unused-text-key')
    };
    const requests: ModelRequest[] = [];
    const host = new LocalAgentHost({
      homeDirectory: paths.home,
      workspace: paths.workspace
    });
    let binding = host.bindExecutionExtensions(hostExtensions);
    const agent = await createMarAgent(
      {
        mode: 'normal',
        host,
        models: [imageModel, textModel]
      },
      (configuration) => ({
        configuration,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          const last = latestTaskMessage(request);
          if (last?.role === 'user' && last.content === 'Load the image skill directly.') {
            yield {
              type: 'client_tool.call',
              callId: 'load-skill-directly',
              name: 'skill',
              arguments: { name: 'host-workflow' }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          yield { type: 'text.completed', itemId: 'answer', text: 'No image operation requested.' };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    );
    try {
      const session = await agent.createSession({
        workspace: paths.workspace,
        title: 'Capabilities'
      });
      await expect(
        session.run({ modelId: 'image', prompt: 'Explain what a PNG is.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(skillCatalog(requests[0]!)).toContain('host-workflow');
      expect(skillCatalog(requests[0]!)).not.toContain('## Host workflow');
      expect(requests[0]?.tools.map((tool) => tool.name)).toContain('skill');
      expect(requests[0]?.tools.map((tool) => tool.name)).toContain('host_action');
      host.unbindExecutionMcp(binding);
      await expect(
        session.run({ modelId: 'text', prompt: 'Continue the explanation.' }).result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(skillCatalog(requests[1]!)).toBe('');
      expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain('skill');
      expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain('host_action');
      expect(host.events.filter((event) => event.type === 'tool.started')).toEqual([]);
      expect(provider.acquire).not.toHaveBeenCalled();
      binding = host.bindExecutionExtensions(hostExtensions);
      await expect(
        session
          .run({
            modelId: 'image',
            prompt: 'Load the image skill directly.'
          })
          .result()
      ).resolves.toMatchObject({ status: 'completed' });
      expect(requests.at(-1)?.messages.at(-1)?.content).toContain('## Host workflow');
      expect(
        host.events.some((event) => event.type === 'tool.completed' && event.toolName === 'skill')
      ).toBe(true);
      expect(
        host.events.some(
          (event) => event.type === 'tool.started' && event.toolName === 'host_action'
        )
      ).toBe(false);
      expect(provider.acquire).not.toHaveBeenCalled();
    } finally {
      await agent.dispose();
    }
  });

  it('retains loaded guidance across executions and restart while allowing an explicit refresh', async () => {
    const paths = await fixture();
    let revision = 1;
    const load = vi.fn(async () => `## Host workflow\nRevision ${revision}: use host_action.`);
    const requests: ModelRequest[] = [];
    const create = async () => {
      const host = new LocalAgentHost({ homeDirectory: paths.home, workspace: paths.workspace });
      host.bindExecutionExtensions({
        ...hostExtensions,
        skills: [{ ...hostSkill, load }]
      });
      return createMarAgent(
        {
          mode: 'normal',
          host,
          models: [
            {
              id: 'test',
              name: 'Test',
              modelId: 'test-model',
              protocol: 'OPENAI_RESPONSES',
              baseUrl: 'https://example.test',
              apiKey: new SecretValue('unused'),
              enabled: true,
              contextWindowTokens: 200_000,
              maxOutputTokens: 4096,
              inputCapabilities: ['TEXT'],
              outputCapabilities: ['TEXT'],
              reasoningEfforts: ['medium'],
              hostedWebSearch: false
            }
          ]
        },
        (configuration) => ({
          configuration,
          async *start(request): AsyncIterable<ModelEvent> {
            requests.push(request);
            const last = latestTaskMessage(request);
            if (last?.role === 'user' && /^(Load|Refresh) the workflow\.$/u.test(last.content)) {
              yield {
                type: 'client_tool.call',
                callId: `load-revision-${revision}`,
                name: 'skill',
                arguments: { name: 'host-workflow' }
              };
              yield { type: 'completed', reason: 'tool_use' };
              return;
            }
            yield { type: 'text.completed', itemId: 'answer', text: 'Ready.' };
            yield { type: 'completed', reason: 'completed' };
          }
        })
      );
    };
    const bodies = (request: ModelRequest) =>
      request.messages.flatMap((message) =>
        message.role === 'tool' && message.name === 'skill' ? [message.content] : []
      );
    let agent = await create();
    try {
      let session = await agent.createSession({ workspace: paths.workspace, title: 'Skill reuse' });
      const run = (prompt: string) =>
        expect(session.run({ prompt }).result()).resolves.toMatchObject({ status: 'completed' });
      await run('Load the workflow.');
      expect(load).toHaveBeenCalledTimes(1);
      await run('Continue using the workflow.');
      expect(bodies(requests.at(-1)!)).toHaveLength(1);
      expect(bodies(requests.at(-1)!)[0]).toContain('Revision 1');
      expect(load).toHaveBeenCalledTimes(1);

      const sessionId = session.id;
      await agent.dispose();
      agent = await create();
      session = await agent.openSession(sessionId);
      await run('Continue after restart.');
      expect(bodies(requests.at(-1)!)).toHaveLength(1);
      expect(bodies(requests.at(-1)!)[0]).toContain('Revision 1');
      expect(load).toHaveBeenCalledTimes(1);

      revision = 2;
      await run('Refresh the workflow.');
      expect(load).toHaveBeenCalledTimes(2);
      expect(bodies(requests.at(-1)!)).toHaveLength(2);
      expect(bodies(requests.at(-1)!).at(-1)).toContain('Revision 2');
    } finally {
      await agent.dispose();
    }
  });

  it('advertises only capability-matched metadata and loads portable guidance on demand', async () => {
    const paths = await fixture();
    const hidden = await loadAgentInstructions(paths);
    expect(hidden.skills.size).toBe(0);
    const partial = await loadAgentInstructions({
      ...paths,
      availableTools: new Set(['host_action'])
    });
    expect(partial.skills.has('host-workflow')).toBe(true);
    const context = await loadAgentInstructions({ ...paths, availableTools });
    expect(context.skillCatalog).toContain('host-workflow');
    expect(context.skillCatalog).toContain('Host-provided');
    expect(context.skillCatalog).not.toContain('## Host workflow');
    const content = await loadAgentSkill(context.skills.get('host-workflow')!);
    expect(content).toContain('## Host workflow');
    expect(content).toContain('host_action');
    expect(content).toContain('user requests');
    expect(content).not.toMatch(
      /CODEX_HOME|image_gen\.py|\/workspace\/output|@exec|generatedImage\(/u
    );
    expect(content).not.toContain('Base directory for this skill:');
    expect(await readdir(paths.home)).toEqual([]);
    expect(await readdir(paths.workspace)).toEqual([]);
  });

  it('uses Workspace then user overrides without changing file-skill loading', async () => {
    const paths = await fixture();
    const userDirectory = join(paths.home, '.agents', 'skills', 'host-workflow');
    const workspaceDirectory = join(paths.workspace, '.agents', 'skills', 'host-workflow');
    await mkdir(userDirectory, { recursive: true });
    await writeFile(
      join(userDirectory, 'SKILL.md'),
      '---\nname: host-workflow\ndescription: User image workflow\n---\nUser guidance.'
    );
    let context = await loadAgentInstructions({ ...paths, availableTools });
    expect(context.skillCatalog).toContain('User image workflow');
    expect(await loadAgentSkill(context.skills.get('host-workflow')!)).toContain('User guidance.');
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(
      join(workspaceDirectory, 'SKILL.md'),
      '---\nname: host-workflow\ndescription: Workspace image workflow\n---\nWorkspace guidance.'
    );
    context = await loadAgentInstructions({ ...paths, availableTools });
    expect(context.skills.size).toBe(1);
    expect(context.skillCatalog).toContain('Workspace image workflow');
    expect(await loadAgentSkill(context.skills.get('host-workflow')!)).toContain(
      'Workspace guidance.'
    );
  });

  it('uses the same skill entry point and does not add a runtime image prerequisite', async () => {
    const paths = await fixture();
    const { skills } = await loadAgentInstructions({ ...paths, availableTools });
    const host = { executeTool: vi.fn(async () => ({ content: 'action' })) };
    const context = {
      skills,
      host,
      signal: new AbortController().signal
    } as unknown as ToolRuntimeContext;
    // Loading guidance is not a runtime authorization gate.
    await expect(
      executeRegisteredTool('host_action', { prompt: 'A tree' }, 'before', context)
    ).resolves.toEqual({ content: 'action' });
    expect(host.executeTool).toHaveBeenCalledOnce();
    await expect(
      executeRegisteredTool('skill', { name: 'imagegen' }, 'unknown', context)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    const result = await executeRegisteredTool('skill', { name: 'host-workflow' }, 'load', context);
    expect(result.data).toMatchObject({ name: 'host-workflow', source: 'Host-provided' });
    expect(result.content).toContain('## Host workflow');
    await expect(
      executeRegisteredTool('host_action', { prompt: 'A tree' }, 'after', context)
    ).resolves.toEqual({ content: 'action' });
  });

  it('reports failed or cancelled loads without returning guidance', async () => {
    const paths = await fixture();
    const directory = join(paths.workspace, '.agents', 'skills', 'host-workflow');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'SKILL.md');
    await writeFile(file, 'description: Temporary override\nGuidance.');
    const { skills } = await loadAgentInstructions({ ...paths, availableTools });
    await rm(file);
    const context = {
      skills,
      signal: new AbortController().signal
    } as unknown as ToolRuntimeContext;
    await expect(
      executeRegisteredTool('skill', { name: 'host-workflow' }, 'missing', context)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    const builtin = await loadAgentInstructions({ ...paths, availableTools });
    const cancelled = AbortSignal.abort(new Error('cancelled'));
    await expect(
      executeRegisteredTool('skill', { name: 'host-workflow' }, 'cancelled', {
        ...context,
        skills: builtin.skills,
        signal: cancelled
      })
    ).rejects.toThrow('cancelled');
  });
});
