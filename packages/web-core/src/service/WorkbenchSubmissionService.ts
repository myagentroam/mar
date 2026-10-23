import { ref } from 'vue';

const SUBMISSION_TIMEOUT_MS = 5_000;

export function sessionSubmissionContext(sessionId: string | undefined): string {
  return `session:${sessionId === undefined || sessionId.startsWith('draft:') ? 'draft' : sessionId}`;
}

export function createWorkbenchSubmissionService() {
  const pending = ref(false);
  const context = ref<string>();
  let sequence = 0;

  function begin(nextContext?: string, onTimeout?: () => void): (() => boolean) | undefined {
    if (pending.value) return undefined;
    const current = ++sequence;
    pending.value = true;
    context.value = nextContext;
    const timeout = setTimeout(() => {
      if (sequence !== current) return;
      pending.value = false;
      context.value = undefined;
      onTimeout?.();
    }, SUBMISSION_TIMEOUT_MS);
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

  return { pending, context, begin };
}
