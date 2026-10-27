import { expect, it, vi } from 'vitest';
import { createExecutionModelRequest } from '../../src/sdk/execution-model-request.js';

it('rejects a transformed tool contract that differs from the captured binding', async () => {
  const binding = {
    definition: { name: 'read', description: 'original', inputSchema: { type: 'object' } }
  };
  const transform = createExecutionModelRequest({
    sessionId: 's',
    executionId: 'e',
    modelId: 'm',
    source: 'user',
    compact: false,
    autoPermission: false,
    turn: { resetContinuation: vi.fn() },
    host: {},
    hooks: {
      hasInterceptors: () => true,
      invoke: async (_name: unknown, view: { tools: unknown[] }) => ({
        ...view,
        tools: [{ name: 'read', description: 'changed', inputSchema: { type: 'string' } }]
      })
    },
    operation: (run: (call: unknown) => unknown) => run({}),
    capture: () => new Map([['read', binding]]),
    usageFailed: () => {}
  } as never);
  await expect(
    transform({ system: '', messages: [], tools: [binding.definition] } as never)
  ).rejects.toMatchObject({ code: 'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID' });
});
