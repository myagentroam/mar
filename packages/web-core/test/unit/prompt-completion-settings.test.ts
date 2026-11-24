import { expect, it } from 'vitest';
import PromptCompletionSettings from '../../src/view/settings/PromptCompletionSettings.vue?unit-render';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

// @test-covers packages/web-core/src/view/settings/PromptCompletionSettings.vue
it('orders prompt completion reasoning options without using display order as the model fallback', async () => {
  const request = async <T>(path: string): Promise<T> =>
    (path.endsWith('/models')
      ? {
          models: [
            { id: 'current', name: 'Current model', enabled: true, reasoningEfforts: ['high'] },
            {
              id: 'other',
              name: 'Other model',
              enabled: true,
              reasoningEfforts: ['ultra', 'low', 'max']
            }
          ]
        }
      : { configuration: { enabled: true, modelId: 'current', reasoningEffort: 'high' } }) as T;
  const view = renderComponent(PromptCompletionSettings, { request, writable: true });
  try {
    await flushComponent();
    const model = view.findAll('MarSelect')[0]!;
    await trigger(model, 'onUpdate:modelValue', 'other');
    await trigger(model, 'onChange', 'other');

    const reasoning = view.findAll('MarSelect')[1]!;
    expect(
      reasoning.children
        .filter((option) => option.type === 'MarOption')
        .map((option) => option.props.value)
    ).toEqual(['low', 'max', 'ultra']);
    expect(reasoning.props.modelValue).toBe('ultra');
  } finally {
    view.unmount();
  }
});
