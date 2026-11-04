import { computed, ref, shallowRef, type Ref } from 'vue';
import type { DraftTarget } from './session-draft-service.js';

const SUBMISSION_TIMEOUT_MS = 5_000;

export function sessionSubmissionContext(sessionId: string | undefined): string {
  return `session:${sessionId === undefined || sessionId.startsWith('draft:') ? 'draft' : sessionId}`;
}

export function createWorkbenchSubmissionService() {
  const owner = createWorkbenchSubmissionOwner();
  const slot = {};
  return {
    ...owner.bind(() => slot),
    transferSession: (previousId: string, nextId: string) =>
      owner.transfer(slot, slot, previousId, nextId)
  };
}

/** Admission follows the existing target slot, even when its Pane or Session identity changes. */
export function createWorkbenchSubmissionOwner() {
  interface Group {
    readonly slots: Set<object>;
    readonly tokens: Ref<Token[]>;
  }
  interface Token {
    group: Group;
    context: string | undefined;
    active: boolean;
    timeout?: ReturnType<typeof setTimeout> | undefined;
  }
  const groups = new WeakMap<object, Group>();
  const targets = new Map<string, object>();
  const targetKeys = new WeakMap<object, string>();
  function forTarget(target: DraftTarget): object {
    const key = JSON.stringify([
      target.nodeId,
      target.workspaceId,
      target.kind,
      target.kind === 'session' ? target.sessionId : null
    ]);
    let slot = targets.get(key);
    if (slot === undefined) {
      slot = {};
      targets.set(key, slot);
      targetKeys.set(slot, key);
    }
    return slot;
  }
  const revision = ref(0);
  const emptySlot = {};
  function groupFor(slot: object): Group {
    let group = groups.get(slot);
    if (group === undefined) {
      group = { slots: new Set([slot]), tokens: shallowRef([]) };
      groups.set(slot, group);
    }
    return group;
  }
  function bind(slot: () => object | undefined) {
    const group = computed(() => {
      void revision.value;
      return groupFor(slot() ?? emptySlot);
    });
    function begin(
      context?: string,
      onTimeout?: () => void,
      timeoutMs: number | null = SUBMISSION_TIMEOUT_MS
    ) {
      const current = group.value;
      if (current.tokens.value.length !== 0) return undefined;
      const token: Token = { group: current, context, active: true };
      function finish(): boolean {
        if (!token.active) return false;
        token.active = false;
        clearTimeout(token.timeout);
        token.group.tokens.value = token.group.tokens.value.filter((item) => item !== token);
        return true;
      }
      current.tokens.value = [...current.tokens.value, token];
      if (timeoutMs !== null)
        token.timeout = setTimeout(() => {
          if (finish()) onTimeout?.();
        }, timeoutMs);
      return finish;
    }
    return {
      pending: computed(() => group.value.tokens.value.length !== 0),
      context: computed(
        () => group.value.tokens.value.find((token) => token.context !== undefined)?.context
      ),
      begin
    };
  }
  function transfer(
    from: object,
    to: object,
    previousId: string,
    nextId: string,
    releaseSource = false
  ): void {
    const source = groups.get(from);
    if (source === undefined) return;
    const target = groups.get(to) ?? source;
    for (const token of source.tokens.value) {
      if (token.context === sessionSubmissionContext(previousId))
        token.context = sessionSubmissionContext(nextId);
      token.group = target;
    }
    if (target !== source) {
      target.tokens.value = [...target.tokens.value, ...source.tokens.value];
      for (const slot of source.slots) {
        groups.set(slot, target);
        target.slots.add(slot);
      }
    } else target.tokens.value = [...target.tokens.value];
    groups.set(to, target);
    target.slots.add(to);
    if (releaseSource && from !== to) {
      groups.delete(from);
      target.slots.delete(from);
      // Retire this source identity so a late reply cannot claim a newer Workspace submission.
      const key = targetKeys.get(from);
      if (key !== undefined && targets.get(key) === from) targets.delete(key);
    }
    revision.value += 1;
  }
  return { bind, transfer, forTarget };
}
