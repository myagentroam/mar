import { describe, expect, it } from 'vitest';
import { runtimeModelPayload } from '../../src/run-model-payload.js';
import { hostedRuntimeModels } from '../../src/hosted-conversation-context.js';

describe('legacy model delivery without Node capability evidence', () => {
  it.each(['selected', 'catalog'])(
    'refuses a SOCKS5 proxy on the %s model without capability evidence',
    async (location) => {
      const direct = { id: 'direct', contextGcMode: 'auto' };
      const proxied = { id: 'proxied', socks5Url: 'socks5://proxy.invalid:1080' };
      const models = {
        runtimeForUser: async () => (location === 'selected' ? proxied : direct),
        runtimeConfigurationsForUser: async () =>
          location === 'catalog' ? [direct, proxied] : [direct]
      };
      await expect(
        runtimeModelPayload({
          userId: 1,
          nodeId: 'node',
          workspaceId: 'workspace',
          selectedModelId: 'direct',
          marAgentModels: models as never
        })
      ).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED');
      await expect(
        hostedRuntimeModels({
          userId: 1,
          nodeId: 'node',
          workspaceId: 'workspace',
          selectedModelId: 'direct',
          models: models as never
        })
      ).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED');
    }
  );
  it.each([undefined, 'auto', 'off', 'with_thought'] as const)(
    'permits only Automatic GC without capability evidence: %s',
    async (contextGcMode) => {
      const selected = contextGcMode === undefined ? { id: 'm' } : { id: 'm', contextGcMode };
      const models = {
        runtimeForUser: async () => selected,
        runtimeConfigurationsForUser: async () => [selected]
      };
      const workspace = runtimeModelPayload({
        userId: 1,
        nodeId: 'node',
        workspaceId: 'workspace',
        selectedModelId: 'm',
        marAgentModels: models as never
      });
      const hosted = hostedRuntimeModels({
        userId: 1,
        nodeId: 'node',
        workspaceId: 'workspace',
        selectedModelId: 'm',
        models: models as never
      });
      if (contextGcMode !== 'auto') {
        await Promise.all([
          expect(workspace).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED'),
          expect(hosted).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED')
        ]);
      } else {
        await expect(workspace).resolves.toMatchObject({ marAgentModel: selected });
        await expect(hosted).resolves.toMatchObject({ model: selected });
      }
    }
  );
});
