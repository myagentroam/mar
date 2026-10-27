import { describe, expect, it } from 'vitest';
import { prepareModelConfiguration } from '../../src/model/request-configuration.js';
import type { ModelMessage } from '../../src/model/contracts.js';

const model = {
  id: 'main',
  protocol: 'OPENAI_RESPONSES' as const,
  responsesConfigurationUpdates: true
};

describe('Model request configuration policy', () => {
  it('keeps the initial effort while appending only changed same-model native configuration', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'first' }];
    const first = prepareModelConfiguration(model, 'high', { baselineEffort: undefined, messages });
    expect(first.requestReasoningEffort).toBe('high');
    expect(first.updates).toEqual([]);
    const low = prepareModelConfiguration(model, 'low', { baselineEffort: 'high', messages });
    expect(low.requestReasoningEffort).toBe('high');
    expect(low.updates).toEqual([
      {
        role: 'provider',
        content: '',
        provider: 'OPENAI_RESPONSES',
        providerModelId: 'main',
        item: { type: 'configuration_update', reasoning: { effort: 'low' } }
      }
    ]);
    expect(messages).toEqual([{ role: 'user', content: 'first' }]);
    const history = [
      ...messages,
      ...low.updates,
      {
        ...low.updates[0]!,
        providerModelId: 'other',
        item: { type: 'configuration_update', reasoning: { effort: 'high' } }
      },
      {
        ...low.updates[0]!,
        item: { type: 'configuration_update', reasoning: { effort: 'invalid' } }
      }
    ];
    expect(
      prepareModelConfiguration(model, 'low', { baselineEffort: 'high', messages: history }).updates
    ).toEqual([]);
    expect(
      prepareModelConfiguration(model, 'high', { baselineEffort: 'high', messages: history })
        .updates
    ).toHaveLength(1);
    expect(
      prepareModelConfiguration(model, 'low', { baselineEffort: undefined, messages: history })
    ).toMatchObject({
      requestReasoningEffort: 'low',
      updates: []
    });
  });

  it.each([
    { ...model, responsesConfigurationUpdates: false },
    { ...model, protocol: 'ANTHROPIC_MESSAGES' as const }
  ])(
    'does not generate native updates for $protocol with updates=$responsesConfigurationUpdates',
    (configuration) => {
      expect(
        prepareModelConfiguration(configuration, 'low', { baselineEffort: 'high', messages: [] })
      ).toEqual({
        updates: [],
        contextProjection: {
          modelProtocol: configuration.protocol,
          responsesConfigurationUpdates: false
        }
      });
      // Preserve the established post-checkpoint request effort even for protocols without native updates.
      expect(
        prepareModelConfiguration(configuration, 'low', { checkpointAdopted: true })
      ).toMatchObject({
        requestReasoningEffort: 'low',
        updates: []
      });
    }
  );

  it('resets request effort after checkpoint adoption without generating a configuration message', () => {
    expect(prepareModelConfiguration(model, 'low', { checkpointAdopted: true })).toEqual({
      requestReasoningEffort: 'low',
      updates: [],
      contextProjection: { modelProtocol: 'OPENAI_RESPONSES', responsesConfigurationUpdates: true }
    });
  });
});
