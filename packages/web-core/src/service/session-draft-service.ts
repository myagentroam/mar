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

export type DraftPane = 'main' | 'aside';

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

type ComposerDraft = Pick<DraftSlot, 'input' | 'skillTokens' | 'references'>;

export function createSessionDraftService(options: {
  readonly target: Readonly<Ref<DraftTarget | undefined>>;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) {
  const storage = options.storage ?? sessionStorage;

  function keyFor(target: DraftTarget | undefined, pane: DraftPane = 'main'): string | undefined {
    return target === undefined
      ? undefined
      : pane === 'main'
        ? `mar.workbench.draft.${target.nodeId}.${target.workspaceId}`
        : `mar.workbench.aside-draft.${JSON.stringify([target.nodeId, target.workspaceId])}`;
  }
  const key = () => keyFor(options.target.value);
  const legacyKeyFor = (target: DraftTarget) =>
    target.kind === 'session'
      ? `mar.workbench.session-draft.${JSON.stringify([target.nodeId, target.workspaceId, target.sessionId])}`
      : keyFor(target)!;

  const composers = new Map<string, ComposerDraft>();
  const migratedComposers = new Set<string>();
  const queueEdits = new Map<string, Ref<QueueEditDraft | undefined>>();
  const slots = new Map<string, DraftSlot>();
  const empty = new Map<DraftPane, DraftSlot>();

  function createComposer(): ComposerDraft {
    return { input: ref(''), skillTokens: ref([]), references: ref([]) };
  }

  function forTarget(target: DraftTarget, pane: DraftPane = 'main'): DraftSlot {
    const storageKey = keyFor(target, pane)!;
    const queueKey = `mar.workbench.queue-edit.${JSON.stringify([
      target.nodeId,
      target.workspaceId,
      target.kind,
      target.kind === 'session' ? target.sessionId : null
    ])}`;
    const slotKey = `${queueKey}.${pane}`;
    let slot = slots.get(slotKey);
    if (slot === undefined) {
      let composer = composers.get(storageKey);
      if (composer === undefined) {
        composer = createComposer();
        composers.set(storageKey, composer);
        restoreInto(storageKey, composer);
      }
      migrateLegacyComposer(target, pane, storageKey, composer);
      const existingQueueEdit = queueEdits.get(queueKey);
      const queueEdit = existingQueueEdit ?? ref<QueueEditDraft>();
      const restoreQueue = () => {
        let recovered = false;
        try {
          const stored = storage.getItem(queueKey);
          const legacy =
            stored === null
              ? (JSON.parse(storage.getItem(legacyKeyFor(target)) ?? 'null') as {
                  queueEdit?: unknown;
                } | null)
              : undefined;
          queueEdit.value = parseQueueEdit(
            stored === null ? legacy?.queueEdit : JSON.parse(stored)
          );
          recovered = stored === null && queueEdit.value !== undefined;
        } catch {
          queueEdit.value = undefined;
        }
        if (recovered) {
          try {
            storage.setItem(queueKey, JSON.stringify(queueEdit.value));
          } catch {
            // Keep the recovered edit in memory even if its new storage key cannot be written.
          }
        }
      };
      if (existingQueueEdit === undefined) {
        queueEdits.set(queueKey, queueEdit);
        restoreQueue();
      }
      slot = {
        ...composer,
        queueEdit,
        restore: () => {
          restoreInto(storageKey, composer);
          restoreQueue();
        },
        persist: () => {
          persistSlot(storageKey, composer);
          try {
            if (queueEdit.value !== undefined)
              storage.setItem(queueKey, JSON.stringify(queueEdit.value));
            else if (storage.getItem(queueKey) !== null) storage.setItem(queueKey, 'null');
          } catch {
            // Queue editing remains available in memory when storage is unavailable.
          }
        }
      };
      slots.set(slotKey, slot);
    }
    return slot;
  }

  function bindTarget(target: Readonly<Ref<DraftTarget | undefined>>, pane: DraftPane = 'main') {
    const current = () => {
      if (target.value !== undefined) return forTarget(target.value, pane);
      let slot = empty.get(pane);
      if (slot === undefined) {
        slot = { ...createComposer(), queueEdit: ref(), restore: () => {}, persist: () => {} };
        empty.set(pane, slot);
      }
      return slot;
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

  function migrateLegacyComposer(
    target: DraftTarget,
    pane: DraftPane,
    storageKey: string,
    slot: ComposerDraft
  ) {
    if (pane !== 'main' || target.kind !== 'session' || migratedComposers.has(storageKey)) return;
    try {
      if (
        storage.getItem(storageKey) === null &&
        slot.input.value.length === 0 &&
        slot.skillTokens.value.length === 0 &&
        slot.references.value.length === 0
      ) {
        const legacy = storage.getItem(legacyKeyFor(target));
        if (legacy !== null) restoreInto(storageKey, slot, legacy);
      }
      // Write migration state with its text atomically; a later clear must retain that state.
      migratedComposers.add(storageKey);
      persistSlot(storageKey, slot);
    } catch {
      // Existing legacy keys remain intact when storage is unavailable.
    }
  }

  function restoreInto(storageKey: string, slot: ComposerDraft, storedValue?: string): void {
    const { input, skillTokens, references } = slot;
    try {
      const stored = storedValue ?? storage.getItem(storageKey);
      if (stored === null) {
        input.value = '';
        skillTokens.value = [];
        references.value = [];
        return;
      }
      try {
        const parsed = JSON.parse(stored) as {
          input?: unknown;
          skillTokens?: unknown;
          references?: unknown;
          sessionDraftsMigrated?: unknown;
        };
        if (parsed.sessionDraftsMigrated === true) migratedComposers.add(storageKey);
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
      }
    } catch {
      input.value = '';
      skillTokens.value = [];
      references.value = [];
    }
  }

  function persistSlot(storageKey: string, slot: ComposerDraft): void {
    const { input, skillTokens, references } = slot;
    try {
      if (
        input.value.length === 0 &&
        skillTokens.value.length === 0 &&
        references.value.length === 0 &&
        !migratedComposers.has(storageKey)
      )
        storage.removeItem(storageKey);
      else
        storage.setItem(
          storageKey,
          JSON.stringify({
            input: input.value,
            skillTokens: skillTokens.value,
            references: references.value,
            ...(migratedComposers.has(storageKey) ? { sessionDraftsMigrated: true } : {})
          })
        );
    } catch {
      // Drafts are a local convenience only.
    }
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
    forTarget
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
