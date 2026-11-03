import { computed, ref, type Ref } from 'vue';
import type { ComposerSkillToken } from '../model/workbench.js';
import type { ComposerReference } from '@myagentroam/protocol';
import { normalizeComposerReferences } from './file-reference-service.js';
import {
  COMPOSER_SKILL_TOKEN_PLACEHOLDER,
  normalizeComposerSkillTokens
} from './composer-skill-token-service.js';

export type DraftTarget =
  | { readonly kind: 'workspace'; readonly nodeId: string; readonly workspaceId: string }
  | {
      readonly kind: 'session';
      readonly nodeId: string;
      readonly workspaceId: string;
      readonly sessionId: string;
    };

export interface QueueEditDraft {
  readonly queueItemId: string;
  readonly content: string;
  readonly tags: string;
  readonly origin: string;
}

export interface DraftSlot {
  readonly input: Ref<string>;
  readonly skillTokens: Ref<readonly ComposerSkillToken[]>;
  readonly references: Ref<readonly ComposerReference[]>;
  readonly queueEdit: Ref<QueueEditDraft | undefined>;
  readonly restore: () => void;
  readonly persist: () => void;
}

interface OwnedDraftSlot extends DraftSlot {
  readonly retarget: (target: DraftTarget) => void;
}

export function createSessionDraftService(options: {
  readonly target: Readonly<Ref<DraftTarget | undefined>>;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) {
  const storage = options.storage ?? sessionStorage;

  function keyFor(target: DraftTarget | undefined): string | undefined {
    return target === undefined
      ? undefined
      : target.kind === 'workspace'
        ? `mar.workbench.draft.${target.nodeId}.${target.workspaceId}`
        : `mar.workbench.session-draft.${JSON.stringify([target.nodeId, target.workspaceId, target.sessionId])}`;
  }
  const key = () => keyFor(options.target.value);

  function createSlot(
    initialTarget: DraftTarget | undefined,
    restoreAllowed = true
  ): OwnedDraftSlot {
    let target = initialTarget;
    const input = ref('');
    const skillTokens = ref<readonly ComposerSkillToken[]>([]);
    const references = ref<readonly ComposerReference[]>([]);
    const queueEdit = ref<QueueEditDraft>();
    return {
      input,
      skillTokens,
      references,
      queueEdit,
      restore: () => {
        if (restoreAllowed) restoreInto(target, { input, skillTokens, references, queueEdit });
      },
      persist: () => {
        if (persistSlot(target, { input, skillTokens, references, queueEdit }))
          restoreAllowed = true;
      },
      retarget: (next) => {
        target = { ...next };
      }
    };
  }
  const slots = new Map<string, OwnedDraftSlot>();
  const revision = ref(0);
  const empty = createSlot(undefined);

  function forTarget(target: DraftTarget): DraftSlot {
    const storageKey = keyFor(target)!;
    let slot = slots.get(storageKey);
    if (slot === undefined) {
      slot = createSlot({ ...target });
      slots.set(storageKey, slot);
      slot.restore();
    }
    return slot;
  }
  function bindTarget(target: Readonly<Ref<DraftTarget | undefined>>) {
    const current = () => {
      void revision.value;
      return target.value === undefined ? empty : forTarget(target.value);
    };
    return {
      slot: computed(() => current()),
      input: computed({
        get: () => current().input.value,
        set: (value) => (current().input.value = value)
      }),
      skillTokens: computed({
        get: () => current().skillTokens.value,
        set: (value) => (current().skillTokens.value = value)
      }),
      references: computed({
        get: () => current().references.value,
        set: (value) => (current().references.value = value)
      }),
      queueEdit: computed({
        get: () => current().queueEdit.value,
        set: (value) => (current().queueEdit.value = value)
      }),
      restore: () => current().restore(),
      persist: () => current().persist()
    };
  }
  const active = bindTarget(options.target);

  function restoreInto(
    target: DraftTarget | undefined,
    slot: Pick<DraftSlot, 'input' | 'skillTokens' | 'references' | 'queueEdit'>
  ): void {
    const { input, skillTokens, references, queueEdit } = slot;
    const storageKey = keyFor(target);
    if (storageKey === undefined) return;
    try {
      const stored = storage.getItem(storageKey);
      if (stored === null) {
        input.value = '';
        skillTokens.value = [];
        references.value = [];
        queueEdit.value = undefined;
        return;
      }
      try {
        const parsed = JSON.parse(stored) as {
          input?: unknown;
          skillTokens?: unknown;
          references?: unknown;
          queueEdit?: unknown;
        };
        queueEdit.value = parseQueueEdit(parsed.queueEdit);
        references.value = normalizeComposerReferences(parsed.references);
        const restoredInput = typeof parsed.input === 'string' ? parsed.input : '';
        const restoredTokens = normalizeComposerSkillTokens(parsed.skillTokens).map((token) => ({
          ...token,
          available: false
        }));
        const placeholderCount = [...restoredInput].filter(
          (character) => character === COMPOSER_SKILL_TOKEN_PLACEHOLDER
        ).length;
        skillTokens.value =
          placeholderCount > 0 ? restoredTokens.slice(0, placeholderCount) : restoredTokens;
        input.value = restoredInput.replaceAll(COMPOSER_SKILL_TOKEN_PLACEHOLDER, '');
      } catch {
        input.value = stored;
        skillTokens.value = [];
        references.value = [];
        queueEdit.value = undefined;
      }
    } catch {
      input.value = '';
      skillTokens.value = [];
      references.value = [];
      queueEdit.value = undefined;
    }
  }

  function persistSlot(
    target: DraftTarget | undefined,
    slot: Pick<DraftSlot, 'input' | 'skillTokens' | 'references' | 'queueEdit'>
  ): boolean {
    const { input, skillTokens, references, queueEdit } = slot;
    const storageKey = keyFor(target);
    if (storageKey === undefined) return false;
    try {
      if (
        input.value.length === 0 &&
        skillTokens.value.length === 0 &&
        references.value.length === 0 &&
        queueEdit.value === undefined
      )
        storage.removeItem(storageKey);
      else
        storage.setItem(
          storageKey,
          JSON.stringify({
            input: input.value,
            skillTokens: skillTokens.value,
            references: references.value,
            queueEdit: queueEdit.value
          })
        );
      return true;
    } catch {
      // Drafts are a local convenience only.
      return false;
    }
  }

  function moveDraft(from: DraftTarget, to: DraftTarget, expected: DraftSlot): boolean {
    if (
      from.kind !== 'workspace' ||
      to.kind !== 'session' ||
      from.nodeId !== to.nodeId ||
      from.workspaceId !== to.workspaceId
    )
      return false;
    const fromKey = keyFor(from)!;
    const toKey = keyFor(to)!;
    const slot = slots.get(fromKey);
    if (slot === undefined || slot !== expected || slots.has(toKey)) return false;
    try {
      if (storage.getItem(toKey) !== null) return false;
    } catch {
      // In-memory ownership remains usable when storage is unavailable.
    }
    // A best-effort storage write can fail; never reopen the old stored source in this page.
    slots.set(fromKey, createSlot({ ...from }, false));
    slots.set(toKey, slot);
    slot.retarget(to);
    if (persistSlot(to, slot)) {
      try {
        storage.removeItem(fromKey);
      } catch {
        /* Storage is optional. */
      }
    }
    revision.value += 1;
    return true;
  }

  return {
    ...active,
    key,
    restoreFor: (target: DraftTarget | undefined) => {
      if (target !== undefined) forTarget(target).restore();
    },
    persistFor: (target: DraftTarget | undefined) => {
      if (target !== undefined) forTarget(target).persist();
    },
    bindTarget,
    forTarget,
    moveDraft
  };
}

function parseQueueEdit(value: unknown): QueueEditDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const draft = value as Record<string, unknown>;
  return typeof draft.queueItemId === 'string' &&
    draft.queueItemId.length > 0 &&
    typeof draft.content === 'string' &&
    typeof draft.tags === 'string' &&
    typeof draft.origin === 'string'
    ? {
        queueItemId: draft.queueItemId,
        content: draft.content,
        tags: draft.tags,
        origin: draft.origin
      }
    : undefined;
}
