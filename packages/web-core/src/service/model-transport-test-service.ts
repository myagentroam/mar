import { ref } from 'vue';
import type { MarAgentModelTransportTestResult } from '@myagentroam/protocol';

export function createModelTransportTestService(
  testModel: (modelId: string, nodeId: string) => Promise<MarAgentModelTransportTestResult>,
  accept: (result: MarAgentModelTransportTestResult) => Promise<void>
) {
  const testingIds = ref<ReadonlySet<string>>(new Set());
  let sequence = 0;
  let disposed = false;

  function invalidate(): void {
    sequence += 1;
  }

  async function test(modelId: string, nodeId: string) {
    if (disposed || testingIds.value.has(modelId)) return undefined;
    const current = ++sequence;
    testingIds.value = new Set(testingIds.value).add(modelId);
    try {
      const result = await testModel(modelId, nodeId);
      if (disposed || current !== sequence) return;
      await accept(result);
    } catch (error) {
      if (disposed || current !== sequence) return undefined;
      throw error;
    } finally {
      if (!disposed) {
        const next = new Set(testingIds.value);
        next.delete(modelId);
        testingIds.value = next;
      }
    }
  }

  function dispose(): void {
    disposed = true;
    invalidate();
    testingIds.value = new Set();
  }

  return { testingIds: testingIds as Readonly<typeof testingIds>, test, invalidate, dispose };
}
