import { ref } from 'vue';

const SUBMISSION_TIMEOUT_MS = 5_000;

export function sessionSubmissionContext(sessionId: string | undefined): string {
  return `session:${sessionId === undefined || sessionId.startsWith('draft:') ? 'draft' : sessionId}`;
}

export function createWorkbenchSubmissionService() {
  const pending = ref(false);
  const context = ref<string>();
  let sequence = 0;

  function begin(
    nextContext?: string,
    onTimeout?: () => void,
    timeoutMs: number | null = SUBMISSION_TIMEOUT_MS
  ): (() => boolean) | undefined {
    if (pending.value) return undefined;
    const current = ++sequence;
    pending.value = true;
    context.value = nextContext;
    const timeout =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            if (sequence !== current) return;
            pending.value = false;
            context.value = undefined;
            onTimeout?.();
          }, timeoutMs);
    return () => {
      clearTimeout(timeout);
      const active = sequence === current && pending.value;
      if (active) {
        pending.value = false;
        context.value = undefined;
      }
      return active;
    };
  }

  function transferSession(previousId: string, nextId: string): void {
    if (context.value === sessionSubmissionContext(previousId))
      context.value = sessionSubmissionContext(nextId);
  }

  return { pending, context, begin, transferSession };
}
