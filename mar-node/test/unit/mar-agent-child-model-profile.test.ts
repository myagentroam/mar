import { describe, expect, it } from 'vitest';
import { runnerProfileSchema } from '../../../packages/protocol/src/index.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';

describe('MAR Agent child model profile', () => {
  it('projects only enabled conversation models and preserves their Subagent usage in the protocol', () => {
    const runner = new MarAgentRunner();
    const base = {
      name: 'Model',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://example.test',
      modelId: 'model',
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      enabled: true,
      sortOrder: 0
    };
    runner.configureModels([
      { ...base, id: 'conversation', conversationModel: true, subagentModel: false },
      { ...base, id: 'delegation', conversationModel: true, subagentModel: true },
      { ...base, id: 'not-conversation', conversationModel: false, subagentModel: true },
      { ...base, id: 'disabled', conversationModel: true, subagentModel: true, enabled: false }
    ]);
    const profile = runner.profile({
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: process.version,
      codex: { available: false },
      claudeCode: { available: false },
      marAgent: { available: true }
    });
    expect(profile).toBeDefined();
    expect(
      runnerProfileSchema
        .parse(profile)
        .models.map(({ id, subagentModel }) => ({ id, subagentModel }))
    ).toEqual([
      { id: 'conversation', subagentModel: false },
      { id: 'delegation', subagentModel: true }
    ]);
  });
});
