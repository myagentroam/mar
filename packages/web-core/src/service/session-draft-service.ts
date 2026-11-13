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
  readonly persist: () => boolean | void;
  readonly retain: () => DraftSettlement;
}

export interface DraftSettlement {
  readonly settle: (change: () => void) => void;
  readonly release: () => void;
}

type ComposerDraft = Pick<DraftSlot, 'input' | 'skillTokens' | 'references'>;

interface DraftEntry {
  readonly target: DraftTarget;
  readonly pane: DraftPane;
  readonly storageKey: string;
  readonly queueKey: string;
  readonly slot: DraftSlot;
}

/** Owns tab-local Pane drafts and in-flight settlements, independently of the bounded slot LRU.
 * Ordinary release persists drafts; only retained submissions may settle after release.
 * Deletion and sign-out invalidate those submissions before discarding their ownership.
 */
export function createSessionDraftService(options: {
  readonly target: Readonly<Ref<DraftTarget | undefined>>;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
    Partial<Pick<Storage, 'length' | 'key'>>;
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
  const queueKeyFor = (target: DraftTarget) =>
    `mar.workbench.queue-edit.${JSON.stringify([
      target.nodeId,
      target.workspaceId,
      target.kind,
      target.kind === 'session' ? target.sessionId : null
    ])}`;

  const composers = new Map<string, ComposerDraft>();
  const migratedComposers = new Set<string>();
  const queueEdits = new Map<string, Ref<QueueEditDraft | undefined>>();
  const slots = new Map<string, DraftEntry>();
  const boundTargets: {
    readonly target: Readonly<Ref<DraftTarget | undefined>>;
    readonly pane: DraftPane;
  }[] = [];
  const empty = new Map<DraftPane, DraftSlot>();
  const retained = new Set<DraftEntry>();

  function releaseUnusedDrafts(): void {
    const entries = [...slots.values(), ...retained];
    const composerKeys = new Set(entries.map((entry) => entry.storageKey));
    const queueKeys = new Set(entries.map((entry) => entry.queueKey));
    for (const key of composers.keys())
      if (!composerKeys.has(key)) {
        composers.delete(key);
        migratedComposers.delete(key);
      }
    for (const key of queueEdits.keys()) if (!queueKeys.has(key)) queueEdits.delete(key);
  }

  function releaseWhere(matches: (target: DraftTarget, pane: DraftPane) => boolean): boolean {
    let saved = true;
    for (const [id, entry] of slots) {
      if (!matches(entry.target, entry.pane)) continue;
      if (entry.slot.persist() === false) saved = false;
      else slots.delete(id);
    }
    releaseUnusedDrafts();
    return saved;
  }

  function trim(): void {
    if (slots.size <= 64) return;
    releaseWhere(
      (target, pane) =>
        slots.size > 64 &&
        !boundTargets.some((binding) => {
          const current = binding.target.value;
          return (
            binding.pane === pane &&
            current?.nodeId === target.nodeId &&
            current.workspaceId === target.workspaceId &&
            current.kind === target.kind &&
            (current.kind !== 'session' ||
              (target.kind === 'session' && current.sessionId === target.sessionId))
          );
        })
    );
  }

  function createComposer(): ComposerDraft {
    return { input: ref(''), skillTokens: ref([]), references: ref([]) };
  }

  function forTarget(target: DraftTarget, pane: DraftPane = 'main'): DraftSlot {
    const storageKey = keyFor(target, pane)!;
    const queueKey = queueKeyFor(target);
    const slotKey = `${queueKey}.${pane}`;
    let slot = slots.get(slotKey)?.slot;
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
        retain: () => {
          const entry = slots.get(slotKey);
          if (entry === undefined || entry.slot !== slot)
            return { settle: () => {}, release: () => {} };
          // Each request owns an independent lease, even when it captures the same slot.
          const lease = { ...entry };
          retained.add(lease);
          return {
            settle: (change) => {
              if (!retained.has(lease)) return;
              change();
              // Rejoin the normal bounded owner before writing; never authorize old-slot persist.
              forTarget(target, pane).persist();
            },
            release: () => {
              retained.delete(lease);
              releaseUnusedDrafts();
            }
          };
        },
        restore: () => {
          if (slots.get(slotKey)?.slot !== slot) return;
          restoreInto(storageKey, composer);
          restoreQueue();
        },
        persist: () => {
          if (slots.get(slotKey)?.slot !== slot) return false;
          const saved = persistSlot(storageKey, composer);
          try {
            if (queueEdit.value !== undefined)
              storage.setItem(queueKey, JSON.stringify(queueEdit.value));
            else if (storage.getItem(queueKey) !== null) storage.setItem(queueKey, 'null');
            return saved;
          } catch {
            // Queue editing remains available in memory when storage is unavailable.
            return false;
          }
        }
      };
    }
    slots.delete(slotKey);
    slots.set(slotKey, { target, pane, storageKey, queueKey, slot });
    trim();
    return slot;
  }

  function bindTarget(target: Readonly<Ref<DraftTarget | undefined>>, pane: DraftPane = 'main') {
    if (!boundTargets.some((binding) => binding.target === target && binding.pane === pane))
      boundTargets.push({ target, pane });
    const current = () => {
      if (target.value !== undefined) return forTarget(target.value, pane);
      let slot = empty.get(pane);
      if (slot === undefined) {
        slot = {
          ...createComposer(),
          queueEdit: ref(),
          restore: () => {},
          persist: () => {},
          retain: () => ({ settle: () => {}, release: () => {} })
        };
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

  function persistSlot(storageKey: string, slot: ComposerDraft): boolean {
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
      return true;
    } catch {
      // Drafts are a local convenience only.
      return false;
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
    forTarget,
    releaseWorkspace: (nodeId: string, workspaceId: string) =>
      releaseWhere((target) => target.nodeId === nodeId && target.workspaceId === workspaceId),
    releaseNode: (nodeId: string) => releaseWhere((target) => target.nodeId === nodeId),
    releaseSession: (nodeId: string, workspaceId: string, sessionId: string) => {
      const target = { kind: 'session' as const, nodeId, workspaceId, sessionId };
      for (const lease of retained)
        if (
          lease.target.kind === 'session' &&
          lease.target.nodeId === nodeId &&
          lease.target.workspaceId === workspaceId &&
          lease.target.sessionId === sessionId
        )
          retained.delete(lease);
      const queueKey = queueKeyFor(target);
      // Resolve Main first so a legacy Composer is migrated before its old key is removed.
      forTarget(target).queueEdit.value = undefined;
      const saved = releaseWhere(
        (target) =>
          target.kind === 'session' &&
          target.nodeId === nodeId &&
          target.workspaceId === workspaceId &&
          target.sessionId === sessionId
      );
      // Deleted sessions cannot resume an edit, including entries already evicted from memory.
      // The shared Workspace Pane composers still use the ordinary recoverable release path.
      try {
        storage.removeItem(queueKey);
      } catch {
        // The deleted edit is already cleared in memory when storage is unavailable.
      }
      const legacyKey = legacyKeyFor(target);
      try {
        if (saved) storage.removeItem(legacyKey);
        else {
          // A failed migration must not destroy the only durable copy of the Pane input.
          const legacy = JSON.parse(storage.getItem(legacyKey) ?? 'null') as unknown;
          if (typeof legacy === 'object' && legacy !== null && 'queueEdit' in legacy) {
            delete legacy.queueEdit;
            storage.setItem(legacyKey, JSON.stringify(legacy));
          }
        }
      } catch {
        // Preserve the original legacy entry if its queue metadata cannot be rewritten safely.
      }
    },
    clear: () => {
      // Sign-out discards this tab's drafts, unlike ordinary Workspace release.
      // Include evicted and legacy entries so another account cannot restore them.
      const keys = new Set<string>();
      for (const entry of [...slots.values(), ...retained]) {
        keys.add(entry.storageKey);
        keys.add(entry.queueKey);
        keys.add(legacyKeyFor(entry.target));
      }
      try {
        if (storage.key !== undefined && storage.length !== undefined)
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (
              key !== null &&
              [
                'mar.workbench.draft.',
                'mar.workbench.aside-draft.',
                'mar.workbench.session-draft.',
                'mar.workbench.queue-edit.'
              ].some((prefix) => key.startsWith(prefix))
            )
              keys.add(key);
          }
      } catch {
        // Still attempt known keys when storage enumeration is unavailable.
      }
      for (const key of keys) {
        try {
          storage.removeItem(key);
        } catch {
          // Never retain the previous account in memory when storage is unavailable.
        }
      }
      slots.clear();
      retained.clear();
      composers.clear();
      migratedComposers.clear();
      queueEdits.clear();
      empty.clear();
    }
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
