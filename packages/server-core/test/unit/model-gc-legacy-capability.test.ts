import { describe, expect, it } from 'vitest';
import { runtimeModelPayload } from '../../src/run-model-payload.js';
import { hostedRuntimeModels } from '../../src/hosted-conversation-context.js';

describe('legacy model delivery without Node capability evidence', () => {
  it.each([undefined, true, false])('rejects only a disabled GC setting: %s', async (gcEnabled) => {
    const selected = gcEnabled === undefined ? { id: 'm' } : { id: 'm', gcEnabled };
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
    if (gcEnabled === false) {
      await Promise.all([
        expect(workspace).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED'),
        expect(hosted).rejects.toThrow('CAPABILITY_VERSION_UNSUPPORTED')
      ]);
    } else {
      await expect(workspace).resolves.toMatchObject({ marAgentModel: selected });
      await expect(hosted).resolves.toMatchObject({ model: selected });
    }
  });
});
