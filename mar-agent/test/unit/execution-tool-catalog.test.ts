import { expect, it } from 'vitest';
import { initializeExecutionToolCatalog } from '../../src/sdk/execution-tool-catalog.js';

it('rejects colliding host tool names before exposing Execution bindings', async () => {
  const tool = { name: 'duplicate', description: 'test', inputSchema: { type: 'object' } };
  await expect(
    initializeExecutionToolCatalog({
      host: { listExecutionExtensions: async () => ({ tools: [tool, tool] }) },
      context: { sessionId: 's', executionId: 'e', modelId: 'm' },
      models: new Map(),
      messages: [],
      supplemental: () => []
    } as never)
  ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
});
