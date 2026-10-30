import { describe, expect, it, vi } from 'vitest';
import { runnerProfileSchema } from '../../../packages/protocol/src/index.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';
import { RunnerService } from '../../src/service/runner-service.js';

const capabilities = {
  platform: 'linux' as const,
  architecture: 'x64',
  nodeVersion: process.version,
  codex: { available: false },
  claudeCode: { available: false },
  marAgent: { available: true }
};
function model(id: string) {
  return {
    id,
    name: id,
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.test',
    modelId: id,
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    enabled: true,
    conversationModel: true,
    subagentModel: true,
    hostedWebSearch: false,
    sortOrder: 0
  };
}

describe('MAR Agent child model profile', () => {
  it('uses request resources for admission and defaults regardless of display catalog changes', () => {
    const runner = new MarAgentRunner();
    const authorized = runner.prepareExecutionContext({ marAgentModels: [model('allowed')] });
    for (const display of [undefined, [model('other')], [model('allowed')]]) {
      runner.configureModels(display);
      expect(() => runner.assertChildModel('allowed', authorized)).not.toThrow();
      expect(runner.defaultConfiguration(undefined, undefined, authorized)).toMatchObject({
        modelId: 'allowed',
        effort: 'high'
      });
      expect(() => runner.assertChildModel('allowed', runner.prepareExecutionContext({}))).toThrow(
        'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE'
      );
    }
  });

  it.each([
    { enabled: false },
    { conversationModel: false },
    { subagentModel: false },
    { id: 'unauthorized' }
  ])('does not let a display catalog authorize rejected resources %j', (change) => {
    const runner = new MarAgentRunner();
    const allowed = model('allowed');
    runner.configureModels([allowed]);
    const context = runner.prepareExecutionContext({ marAgentModels: [{ ...allowed, ...change }] });
    expect(() => runner.assertChildModel('allowed', context)).toThrow(
      'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE'
    );
  });

  it('does not fall back to catalog permissions when a selected runtime model is invalid or revoked', () => {
    const runner = new MarAgentRunner();
    const allowed = model('allowed');
    for (const selected of [{ id: 'allowed' }, { ...allowed, subagentModel: false }]) {
      const context = runner.prepareExecutionContext({
        marAgentModel: selected,
        marAgentModels: [allowed]
      });
      expect(() => runner.assertChildModel('allowed', context)).toThrow(
        'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE'
      );
    }
  });

  it('uses the authorized catalog default rather than inheriting the parent selection', () => {
    const runner = new MarAgentRunner();
    const parent = model('parent-selection');
    const target = {
      ...model('target-default'),
      reasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium'
    };
    const context = runner.prepareExecutionContext({
      marAgentModel: parent,
      marAgentModels: [target, parent]
    });
    runner.configureModels([parent]);
    expect(runner.defaultConfiguration(undefined, undefined, context)).toMatchObject({
      modelId: 'target-default',
      effort: 'medium'
    });
    expect(() => runner.assertChildModel('target-default', context)).toThrow(
      'MAR_AGENT_SUBAGENT_MODEL_UNAVAILABLE'
    );
    expect(() => runner.assertChildModel('parent-selection', context)).not.toThrow();
  });

  it.each([true, false])(
    'keeps overlapping Profile queries isolated when availability starts as %s',
    async (initiallyAvailable) => {
      const runner = new MarAgentRunner();
      const registry = new RunnerRegistry([runner]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(registry, 'refreshProfiles').mockImplementation(async () => {
        await gate;
        return registry.profiles(capabilities);
      });
      const service = new RunnerService(
        () => ({ getRunnerDefaults: () => [] }) as never,
        () => ({ ...capabilities, marAgent: { available: initiallyAvailable } }),
        registry,
        {} as never
      );
      const list = service.operations()['runner.profiles.list']!;
      const first = list({ marAgentModels: [model('first')] });
      const empty = await list({ waitForRefresh: false });
      expect(empty).toMatchObject({
        profiles: initiallyAvailable ? [expect.objectContaining({ models: [] })] : []
      });
      const second = list({ marAgentModels: [model('second')] });
      release();
      expect(await first).toMatchObject({
        profiles: [expect.objectContaining({ models: [expect.objectContaining({ id: 'first' })] })]
      });
      expect(await second).toMatchObject({
        profiles: [expect.objectContaining({ models: [expect.objectContaining({ id: 'second' })] })]
      });
    }
  );

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
