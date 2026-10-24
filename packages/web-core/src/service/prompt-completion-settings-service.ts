import {
  promptCompletionConfigurationSchema,
  type PromptCompletionConfiguration,
  type MarAgentModelSummary
} from '@myagentroam/protocol';

/** The authority is deployment-wide; its UI belongs to MAR Agent management. */
export function createPromptCompletionSettingsService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const path = '/api/admin/mar-agent/prompt-completion';
  return {
    async load(signal: AbortSignal) {
      const [settings, directory] = await Promise.all([
        request<{ configuration: unknown }>(path, { signal }),
        request<{ models: MarAgentModelSummary[] }>('/api/admin/mar-agent/models', { signal })
      ]);
      return {
        configuration: promptCompletionConfigurationSchema.parse(settings.configuration),
        models: directory.models
      };
    },
    async save(configuration: PromptCompletionConfiguration, signal: AbortSignal) {
      const response = await request<{ configuration: unknown }>(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(promptCompletionConfigurationSchema.parse(configuration)),
        signal
      });
      return promptCompletionConfigurationSchema.parse(response.configuration);
    }
  };
}
