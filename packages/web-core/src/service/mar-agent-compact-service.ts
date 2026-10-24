import {
  marAgentCompactConfigurationSchema,
  type MarAgentCompactConfiguration,
  type MarAgentModelSummary
} from '@myagentroam/protocol';

/** The authority is deployment-wide; its UI belongs to MAR Agent management. */
export function createMarAgentCompactService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const path = '/api/admin/mar-agent/compact';
  return {
    async load(signal: AbortSignal) {
      const [settings, directory] = await Promise.all([
        request<{ configuration: unknown }>(path, { signal }),
        request<{ models: MarAgentModelSummary[] }>('/api/admin/mar-agent/models', { signal })
      ]);
      return {
        configuration: marAgentCompactConfigurationSchema.parse(settings.configuration),
        models: directory.models
      };
    },
    async save(configuration: MarAgentCompactConfiguration, signal: AbortSignal) {
      const response = await request<{ configuration: unknown }>(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(marAgentCompactConfigurationSchema.parse(configuration)),
        signal
      });
      return marAgentCompactConfigurationSchema.parse(response.configuration);
    }
  };
}
