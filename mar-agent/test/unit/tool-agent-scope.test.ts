import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNewChild } from './support/subagent-wait.js';
import { LocalAgentHost, SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { createMarAgentWithAdapter as createMarAgent } from '../../src/agent-core/sdk/agent.js';
import { type ModelEvent, type ModelRequest } from '../../src/agent-core/model/contracts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tool Agent scope', () => {
  it('keeps ROOT_ONLY MCP tools and their host skills out of Subagent catalogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-tool-agent-scope-'));
    roots.push(root);
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const requests: ModelRequest[] = [];
    let parentCalls = 0;
    let childCalls = 0;
    const invokeHidden = vi.fn(async () => ({ content: 'unexpected' }));
    const model: MarAgentModelConfiguration = {
      id: 'image',
      name: 'Image model',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('test'),
      modelId: 'image-model',
      contextWindowTokens: 100_000,
      maxOutputTokens: 2_000,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low'],
      enabled: true
    };
    const host = new LocalAgentHost({
      homeDirectory: home,
      workspace,
      extensions: {
        tools: [
          {
            name: 'host_root_action',
            description: 'Root action',
            inputSchema: {},
            agentScope: 'ROOT_ONLY'
          }
        ],
        executeTool: invokeHidden,
        skills: [
          {
            name: 'root-workflow',
            description: 'Root workflow',
            requiredTools: ['mcp__root__action'],
            load: async () => 'Root guidance'
          }
        ]
      },
      mcpTools: [
        {
          name: 'mcp__root__action',
          description: 'Root action',
          inputSchema: { type: 'object' },
          agentScope: 'ROOT_ONLY'
        }
      ],
      callMcp: invokeHidden
    });
    const agent = await createMarAgent({
      mode: 'normal',
      host,
      models: [model],
      adapterFactory: (configuration) => ({
        configuration,
        async *start(request): AsyncIterable<ModelEvent> {
          requests.push(request);
          const child = request.system.includes('non-recursive subagent');
          if (child) {
            if (childCalls++ === 0) {
              for (const name of ['mcp__root__action', 'host_root_action'])
                yield { type: 'client_tool.call', callId: name, name, arguments: {} };
              yield { type: 'completed', reason: 'tool_use' };
              return;
            }
            yield {
              type: 'text.completed',
              itemId: 'child-answer',
              phase: 'final_answer',
              text: 'child done'
            };
            yield { type: 'completed', reason: 'completed' };
            return;
          }
          parentCalls++;
          if (parentCalls === 1) {
            yield {
              type: 'client_tool.call',
              callId: 'discover-root',
              name: 'tool_search',
              arguments: { query: 'mcp__root__action', limit: 1 }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          if (parentCalls === 2) {
            yield {
              type: 'client_tool.call',
              callId: 'start-child',
              name: 'agent_start',
              arguments: {
                description: 'Check child tools',
                prompt: 'Inspect available tools.',
                role: 'explore'
              }
            };
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          const wait = waitForNewChild(request);
          if (wait) {
            yield wait;
            yield { type: 'completed', reason: 'tool_use' };
            return;
          }
          yield {
            type: 'text.completed',
            itemId: 'parent-answer',
            phase: 'final_answer',
            text: 'done'
          };
          yield { type: 'completed', reason: 'completed' };
        }
      })
    });

    try {
      const session = await agent.createSession({ workspace, title: 'scope' });
      await expect(session.run({ prompt: 'start child' }).result()).resolves.toMatchObject({
        status: 'completed'
      });
      const parent = requests.find(
        (request) =>
          !request.system.includes('non-recursive subagent') &&
          request.tools.some((tool) => tool.name === 'mcp__root__action')
      );
      const child = requests.find((request) => request.system.includes('non-recursive subagent'));
      expect(parent?.tools.map((tool) => tool.name)).toContain('mcp__root__action');
      expect(parent?.system).toContain('root-workflow');
      expect(child?.tools.map((tool) => tool.name)).not.toContain('mcp__root__action');
      expect(child?.system).not.toContain('root-workflow');
      expect(child?.tools.map((tool) => tool.name)).not.toContain('host_root_action');
      expect(invokeHidden).not.toHaveBeenCalled();
    } finally {
      await agent.dispose();
    }
  });
});
