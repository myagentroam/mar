import { ref, watch, type Ref } from 'vue';
import { runPerformanceSchema, type RunPerformance } from '@myagentroam/protocol';

/** Performance survives only while the same Workspace session stays selected. */
export function createWorkbenchPerformanceService(options: {
  readonly view: Ref<string>;
  readonly nodeId: Ref<string | undefined>;
  readonly workspaceId: Ref<string | undefined>;
  readonly sessionId: Ref<string | undefined>;
}) {
  const current = ref<RunPerformance>();
  const stop = watch(
    [options.view, options.nodeId, options.workspaceId, options.sessionId],
    () => {
      current.value = undefined;
    },
    { flush: 'sync' }
  );

  function receive(sessionId: string, payload: unknown): void {
    if (options.view.value !== 'nodes' || sessionId !== options.sessionId.value) return;
    const parsed = runPerformanceSchema.safeParse(payload);
    if (parsed.success)
      current.value = {
        ...(current.value?.runId === parsed.data.runId ? current.value : {}),
        runId: parsed.data.runId,
        ...(parsed.data.latencyMs === undefined ? {} : { latencyMs: parsed.data.latencyMs }),
        ...(parsed.data.tokensPerSecond === undefined
          ? {}
          : { tokensPerSecond: parsed.data.tokensPerSecond })
      };
  }

  return { current, receive, dispose: stop };
}
