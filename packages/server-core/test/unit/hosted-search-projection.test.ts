import { describe, expect, it } from 'vitest';
import {
  hostedRuntimeModels,
  hostedRuntimePayload
} from '../../src/hosted-conversation-context.js';

describe('hosted execution search projection', () => {
  it('propagates explicit unavailable while leaving legacy payloads unchanged', async () => {
    const base = {
      userId: 7,
      nodeId: 'node',
      models: {
        runtimeConfigurationsForUser: async () => [],
        runtimeForUser: async () => {
          throw new Error('unexpected model lookup');
        }
      }
    } as Parameters<typeof hostedRuntimeModels>[0];
    const unavailable = await hostedRuntimeModels({ ...base, searchBackendAvailable: false });
    expect(hostedRuntimePayload(unavailable)).toMatchObject({ __searchBackendAvailable: false });
    const legacy = await hostedRuntimeModels(base);
    expect(hostedRuntimePayload(legacy)).not.toHaveProperty('__searchBackendAvailable');
  });
});
