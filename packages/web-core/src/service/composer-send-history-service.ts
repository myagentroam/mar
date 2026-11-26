import { createUuid } from '../util/uuid.js';

const storageKey = 'mar.workbench.composer-send-history.v1';
const generationKey = `${storageKey}.generation`;
const expirationMs = 30 * 24 * 60 * 60 * 1000;
const sessionLimit = 30;
const bodyBytesLimit = 16 * 1024;
const accountBytesLimit = 1024 * 1024;
const encoder = new TextEncoder();

export interface ComposerSendHistoryTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export type ComposerSendHistoryDirection = 'older' | 'newer';
export type RecordComposerSend = (
  target: ComposerSendHistoryTarget,
  clientMessageId: string,
  body: string
) => void;

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StorageBinding = {
  readonly storage: HistoryStorage;
  readonly generation: string | null;
  readonly entriesKey: string;
};
type Entry = {
  scope: string;
  id: string;
  body: string;
  sentAt: number;
  usedAt: number;
};

function scopeKey({ nodeId, workspaceId, sessionId }: ComposerSendHistoryTarget): string {
  return JSON.stringify([nodeId, workspaceId, sessionId]);
}

function isCurrent({ storage, generation }: StorageBinding): boolean {
  try {
    return storage.getItem(generationKey) === generation;
  } catch {
    return false;
  }
}

function readEntries(bound: StorageBinding, time: number): Entry[] {
  try {
    const raw = bound.storage.getItem(bound.entriesKey);
    if (raw === null || raw.length > accountBytesLimit) return [];
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    const entries = decoded.filter(
      (entry): entry is Entry =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.scope === 'string' &&
        typeof entry.id === 'string' &&
        typeof entry.body === 'string' &&
        Number.isFinite(entry.sentAt) &&
        Number.isFinite(entry.usedAt) &&
        time - entry.usedAt < expirationMs
    );
    if (entries.length !== decoded.length) writeEntries(bound, entries);
    return entries;
  } catch {
    return [];
  }
}

function removeEntries({ storage, entriesKey }: StorageBinding): void {
  try {
    storage.removeItem(entriesKey);
  } catch {
    // Browser storage may be unavailable.
  }
}

function writeEntries(bound: StorageBinding, entries: readonly Entry[]): void {
  if (!isCurrent(bound)) return;
  if (entries.length === 0) {
    removeEntries(bound);
    return;
  }
  try {
    bound.storage.setItem(bound.entriesKey, JSON.stringify(entries));
    // A concurrent clear can win during the write. Its new generation uses a different key.
    if (!isCurrent(bound)) removeEntries(bound);
  } catch {
    // Best-effort browser history never affects submission or the draft.
  }
}

function retainRecent(entries: readonly Entry[]): Entry[] {
  const selected = new Set<Entry>();
  const counts = new Map<string, number>();
  let size = 2; // Array brackets.
  const recent = [...entries].reverse().sort((a, b) => b.usedAt - a.usedAt || b.sentAt - a.sentAt);
  for (const entry of recent) {
    const count = counts.get(entry.scope) ?? 0;
    if (count >= sessionLimit) continue;
    size += encoder.encode(JSON.stringify(entry)).length + (selected.size > 0 ? 1 : 0);
    if (size > accountBytesLimit) break;
    counts.set(entry.scope, count + 1);
    selected.add(entry);
  }
  return entries.filter((entry) => selected.has(entry));
}

/** Owns a best-effort account cache. Panes share records but own independent browsing cursors.
 * Account bindings capture a shared storage generation; clearing it also invalidates other tabs.
 * Nothing is read before authentication.
 */
export function createComposerSendHistory(options: {
  readonly canUseNode: (nodeId: string) => boolean;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let binding: StorageBinding | undefined;

  function captureSubmission(nodeId: string): RecordComposerSend | undefined {
    const submitted = binding;
    if (submitted === undefined || !options.canUseNode(nodeId) || !isCurrent(submitted))
      return undefined;
    const sentAt = now();
    return (target, id, body) => {
      if (
        binding !== submitted ||
        target.nodeId !== nodeId ||
        !options.canUseNode(nodeId) ||
        target.sessionId.startsWith('draft:') ||
        body.trim() === '' ||
        encoder.encode(body).length > bodyBytesLimit ||
        !isCurrent(submitted)
      )
        return;
      const usedAt = now();
      const scope = scopeKey(target);
      const entries = readEntries(submitted, usedAt);
      if (entries.some((entry) => entry.scope === scope && entry.id === id)) return;
      writeEntries(submitted, retainRecent([...entries, { scope, id, body, sentAt, usedAt }]));
    };
  }

  function createNavigation() {
    let cursor:
      { readonly binding: StorageBinding; readonly scope: string; readonly id: string } | undefined;
    return {
      reset: () => {
        cursor = undefined;
      },
      recall(
        target: ComposerSendHistoryTarget,
        direction: ComposerSendHistoryDirection,
        replace: (body: string) => boolean
      ): boolean {
        const current = binding;
        if (current === undefined || !options.canUseNode(target.nodeId) || !isCurrent(current))
          return false;
        const scope = scopeKey(target);
        const usedAt = now();
        const entries = readEntries(current, usedAt);
        const session = entries
          .filter((entry) => entry.scope === scope)
          .sort((a, b) => a.sentAt - b.sentAt);
        const index =
          cursor?.binding === current && cursor.scope === scope
            ? session.findIndex((entry) => entry.id === cursor?.id)
            : -1;
        const entry =
          direction === 'older'
            ? session[index < 0 ? session.length - 1 : index - 1]
            : index < 0
              ? undefined
              : session[index + 1];
        if (entry === undefined || !isCurrent(current) || !replace(entry.body)) return false;
        cursor = { binding: current, scope, id: entry.id };
        entry.usedAt = usedAt;
        if (binding === current) writeEntries(current, entries);
        return true;
      }
    };
  }

  return {
    captureSubmission,
    createNavigation,
    bindStorage: (storage: HistoryStorage) => {
      try {
        const generation = storage.getItem(generationKey);
        binding = {
          storage,
          generation,
          entriesKey: generation === null ? storageKey : `${storageKey}.${generation}`
        };
      } catch {
        binding = undefined;
      }
    },
    clearAccount: () => {
      const previous = binding;
      binding = undefined;
      if (previous === undefined || !isCurrent(previous)) return;
      try {
        previous.storage.setItem(generationKey, createUuid());
      } catch {
        // Clear the body cache even when the invalidation marker cannot be stored.
      }
      removeEntries(previous);
    }
  };
}
