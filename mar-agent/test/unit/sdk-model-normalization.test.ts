import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAgentHost } from '../../src/host.js';
import { SecretValue, type AgentModelConfiguration } from '../../src/index.js';
import { createAgentWithAdapter } from '../../src/sdk/agent.js';
import { resolveAgentModels } from '../../src/sdk/model-runtime.js';

function model(apiKey = new SecretValue('test')): AgentModelConfiguration {
  return {
    id: 'chat',
    name: 'Chat',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.test',
    apiKey,
    modelId: 'chat',
    contextWindowTokens: 20_000,
    maxOutputTokens: 2_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['low'],
    titleGeneration: false,
    hostedWebSearch: false,
    enabled: true
  };
}

describe('SDK runtime model normalization', () => {
  it('preserves credential identity and resolves the default after projection', () => {
    const key = new SecretValue('secret');
    const provider = {
      acquire: async () => {
        throw new Error('unused');
      },
      invalidate: async () => {},
      close: async () => {}
    };
    const raw = {
      ...model(key),
      futureField: 'discard',
      responsesTransport: { transport: 'HTTP', httpVersion: '2', futureField: 'discard' }
    } as unknown as AgentModelConfiguration;
    const first = resolveAgentModels([raw]).models.get('chat')!;
    expect(first.apiKey).toBe(key);
    expect(first.defaultReasoningEffort).toBe('low');
    expect(first).not.toHaveProperty('futureField');
    expect(first.responsesTransport).toEqual({ transport: 'HTTP', httpVersion: '2' });
    const second = resolveAgentModels([
      { ...model(), apiKey: undefined, credentialProvider: provider } as AgentModelConfiguration
    ]);
    expect(second.models.get('chat')!.credentialProvider).toBe(provider);
    expect(second.credentialProviders.has(provider)).toBe(true);
  });

  it('validates both Agent creation and reconfiguration, projecting the adapter input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-sdk-model-normalization-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const host = new LocalAgentHost({ homeDirectory: home, workspace });
    const invalid = {
      ...model(),
      responsesTransport: { transport: 'INVALID' }
    } as unknown as AgentModelConfiguration;
    try {
      await expect(
        createAgentWithAdapter({ mode: 'normal', host, models: [invalid] })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
      const key = new SecretValue('secret');
      const raw = { ...model(key), futureField: 'discard' } as AgentModelConfiguration;
      let received: AgentModelConfiguration | undefined;
      const agent = await createAgentWithAdapter(
        {
          mode: 'normal',
          host,
          models: [raw]
        },
        (configuration) => {
          received = configuration;
          return {
            async *start() {
              yield { type: 'text.completed' as const, itemId: 'answer', text: 'done' };
              yield { type: 'completed' as const, reason: 'completed' as const };
            }
          };
        }
      );
      try {
        const session = await agent.createSession({ workspace });
        expect(await session.run({ prompt: 'Answer.' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(received?.apiKey).toBe(key);
        expect(received).not.toHaveProperty('futureField');
        await expect(agent.reconfigureModels({ models: [invalid] })).rejects.toMatchObject({
          code: 'MAR_AGENT_MODEL_CONFIG_INVALID'
        });
        expect(await session.run({ prompt: 'Still usable.' }).result()).toMatchObject({
          status: 'completed'
        });
      } finally {
        await agent.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
