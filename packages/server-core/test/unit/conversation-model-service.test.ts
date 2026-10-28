import { describe, expect, it, vi } from 'vitest';
import { MarAgentModelService } from '../../src/mar-agent-model-service.js';

describe('Conversation model directory', () => {
  it('filters purpose before name deduplication without narrowing the auxiliary catalog', async () => {
    const base = {
      name: 'Shared name',
      protocol: 'ANTHROPIC_MESSAGES',
      base_url: 'https://example.test',
      model_id: 'upstream',
      context_window_tokens: 200000,
      max_output_tokens: 4096,
      input_capabilities: ['TEXT'],
      output_capabilities: ['TEXT'],
      reasoning_efforts: [],
      default_reasoning_effort: 'medium',
      title_generation: 0,
      code_mode: 0,
      conversation_model: 1,
      enabled: 1,
      sort_order: 0,
      owner_type: 'PERSONAL',
      owner_user_id: 7,
      created_by: 7,
      last_tested_at: null,
      last_test_status: 'UNVERIFIED',
      last_test_code: null,
      credential: { type: 'INLINE_API_KEY', value: 'test-only' },
      model_settings: { version: 1 }
    } as const;
    const rows = [
      { ...base, id: 'auxiliary', conversation_model: 0 },
      { ...base, id: 'conversation' },
      { ...base, id: 'duplicate' },
      // The v25 migration gives existing models the conversation-purpose default.
      { ...base, id: 'legacy', name: 'Legacy' },
      { ...base, id: 'disabled', name: 'Disabled', enabled: 0 },
      { ...base, id: 'forbidden', name: 'Forbidden' }
    ];
    const execute = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      if (sql.startsWith('SELECT id,owner_type,owner_user_id,created_by')) {
        return [
          rows.filter(
            (row) =>
              (!sql.includes('enabled=1') || row.enabled === 1) &&
              (!sql.includes('conversation_model=1') || row.conversation_model === 1)
          ),
          []
        ];
      }
      if (sql.startsWith('SELECT model.id,') || sql.startsWith('SELECT model.*,')) {
        const selected = rows.filter((row) => parameters.includes(row.id));
        expect(selected.some((row) => row.id === 'forbidden')).toBe(false);
        return [
          selected.filter(
            (row) =>
              (!sql.includes('model.enabled=1') || row.enabled === 1) &&
              (!sql.includes('model.conversation_model=1') || row.conversation_model === 1)
          ),
          []
        ];
      }
      if (
        sql.startsWith('SELECT setting_key,setting_value FROM system_settings') ||
        sql.startsWith('SELECT model_id,sort_order FROM user_mar_agent_model_orders')
      )
        return [[], []];
      throw new Error(`Unexpected directory query: ${sql}`);
    });
    const canUseModel = vi.fn(async (_userId: number, id: string) => id !== 'forbidden');
    const service = new MarAgentModelService({ raw: { execute } } as never, undefined, undefined, {
      canUseModel,
      canManageModel: canUseModel
    });
    const conversation = await service.listForUser(7);
    expect(conversation.map((model) => model.id)).toEqual(['conversation', 'legacy']);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE enabled=1 AND conversation_model=1')
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('model.enabled=1 AND model.conversation_model=1'),
      ['conversation', 'duplicate', 'legacy']
    );
    for (const model of conversation) expect(model).not.toHaveProperty('credential');
    expect((await service.listManagedForUser(7)).map((model) => model.id)).toEqual([
      'auxiliary',
      'conversation',
      'duplicate',
      'legacy',
      'disabled'
    ]);
    expect((await service.storedConfigurationsForUser(7)).map((model) => model.id)).toEqual([
      'auxiliary',
      'conversation',
      'duplicate',
      'legacy'
    ]);
    expect(canUseModel).toHaveBeenCalledWith(7, 'forbidden');
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
