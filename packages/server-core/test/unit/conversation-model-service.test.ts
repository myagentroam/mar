import { describe, expect, it, vi } from 'vitest';
import type { MarAgentModelSummary } from '@myagentroam/protocol';
import { MarAgentModelService } from '../../src/mar-agent-model-service.js';

describe('Conversation model directory', () => {
  it('filters purpose before name deduplication without narrowing the auxiliary catalog', async () => {
    const execute = vi.fn(async () => [[], []]);
    const service = new MarAgentModelService({ raw: { execute } } as never);
    const base = {
      name: 'Shared name',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://example.test',
      modelId: 'upstream',
      contextWindowTokens: 200000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: [],
      defaultReasoningEffort: 'medium',
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      enabled: true,
      sortOrder: 0,
      access: 'RESTRICTED'
    } as const;
    const values = [
      { ...base, id: 'auxiliary', conversationModel: false },
      { ...base, id: 'conversation', conversationModel: true },
      { ...base, id: 'legacy', name: 'Legacy' },
      { ...base, id: 'disabled', name: 'Disabled', enabled: false }
    ] as unknown as MarAgentModelSummary[];
    vi.spyOn(service, 'list').mockResolvedValue(values);
    expect((await service.listForUser(7)).map((model) => model.id)).toEqual([
      'conversation',
      'legacy'
    ]);
    expect((await service.listManagedForUser(7)).map((model) => model.id)).toEqual(
      values.map((model) => model.id)
    );
    const stored = [
      { ...values[0], credential: { type: 'INLINE_API_KEY', value: 'key' } },
      { ...values[1], credential: { type: 'INLINE_API_KEY', value: 'key' } }
    ];
    vi.spyOn(service, 'storedConfigurations').mockResolvedValue(stored as never);
    expect((await service.storedConfigurationsForUser(7)).map((model) => model.id)).toEqual([
      'auxiliary',
      'conversation'
    ]);
  });

  it('refuses an explicitly selected auxiliary conversation model at the legacy delivery boundary', async () => {
    const service = new MarAgentModelService({} as never);
    vi.spyOn(service, 'runtime').mockResolvedValue({
      enabled: true,
      conversationModel: false
    } as never);
    await expect(service.runtimeForUser(7, 'auxiliary')).rejects.toThrow(
      'MAR_AGENT_MODEL_DISABLED'
    );
  });
});
