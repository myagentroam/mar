import type { Ref } from 'vue';
import type { NodeSummary, Session, WorkspaceTarget } from '../model/workbench.js';
import { errorCode } from '../util/api-error.js';
import { sessionHasNativeIdentity } from '../util/session-presentation.js';

interface StoredWorkbenchSelection {
  readonly workspace: WorkspaceTarget;
  readonly sessionId?: string;
}

const SELECTION_STORAGE_KEY = 'mar.workbench.selection.v1';
export interface WorkbenchSelectionPersistenceOptions {
  readonly storage?: Storage;
  readonly isWorkbenchActive: () => boolean;
  readonly nodes: Ref<readonly NodeSummary[]>;
  readonly sessions: Ref<readonly Session[]>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly draftInput: Readonly<Ref<string>>;
  readonly activateWorkspace: (target: WorkspaceTarget) => Promise<boolean>;
  readonly openSession: (sessionId: string) => Promise<void>;
  readonly lookupSession: (nodeId: string, sessionId: string) => Promise<Session | undefined>;
  readonly openDraft: () => void;
  readonly notice: (error: unknown) => void;
  readonly currentSelectionRevision?: () => number;
  readonly rememberSession?: (nodeId: string, workspaceId: string, sessionId?: string) => void;
}

/** Restores the browser's Workspace target without promoting an unverified session to selection. */
export function createWorkbenchSelectionPersistenceService(
  options: WorkbenchSelectionPersistenceOptions
) {
  let storage = options.storage ?? localStorage;
  let initialized = false;
  const pendingRestores = new Set<() => boolean>();
  let deferred: { readonly sessionId: string; readonly current: () => boolean } | undefined;

  async function restore(): Promise<void> {
    const owner = storage;
    const selection = readSelection(storage);
    if (
      !options.isWorkbenchActive() ||
      selection === undefined ||
      options.workspaceTarget.value !== undefined
    )
      return;
    if (!options.nodes.value.some((node) => node.id === selection.workspace.nodeId)) {
      initialized = true;
      persist();
      return;
    }
    const activation = options.activateWorkspace(selection.workspace);
    const target = options.workspaceTarget.value;
    const revision = options.currentSelectionRevision?.();
    const current = () =>
      owner === storage &&
      target !== undefined &&
      options.workspaceTarget.value === target &&
      options.selectedSessionId.value === undefined &&
      options.currentSelectionRevision?.() === revision;
    pendingRestores.add(current);
    try {
      if ((await activation) && current())
        await restoreSession(selection.workspace.workspaceId, selection.sessionId);
    } finally {
      pendingRestores.delete(current);
      if (owner === storage) persist();
    }
  }

  async function restoreSession(workspaceId: string, preferredId?: string): Promise<void> {
    const owner = storage;
    const targetWorkspace = options.workspaceTarget.value;
    if (targetWorkspace?.workspaceId !== workspaceId) return;
    const nodeId = targetWorkspace.nodeId;
    const offline = () =>
      options.nodes.value.some((node) => node.id === nodeId && node.connected === false);
    const selectedId = options.selectedSessionId.value;
    const draftInput = options.draftInput.value;
    const revision = options.currentSelectionRevision?.();
    const current = () =>
      owner === storage &&
      options.workspaceTarget.value === targetWorkspace &&
      options.selectedSessionId.value === selectedId &&
      options.draftInput.value === draftInput &&
      options.currentSelectionRevision?.() === revision;
    deferred = undefined;
    pendingRestores.add(current);
    try {
      if (offline()) {
        if (preferredId !== undefined) deferred = { sessionId: preferredId, current };
        return;
      }
      let target: Session | undefined;
      if (preferredId !== undefined) {
        try {
          target = await options.lookupSession(nodeId, preferredId);
        } catch (error) {
          if (
            ![
              'SESSION_NOT_FOUND',
              'FORBIDDEN',
              'REQUEST_FAILED_404',
              'REQUEST_FAILED_403'
            ].includes(errorCode(error) ?? '')
          )
            throw error;
        }
        if (!current()) return;
        if (target?.workspaceId !== workspaceId) target = undefined;
      }
      if (current()) {
        if (target === undefined) options.openDraft();
        else await options.openSession(target.id);
      }
    } catch (error) {
      if (current()) {
        // Retain the target through transient failures, including subsequent route syncs.
        if (preferredId !== undefined) deferred = { sessionId: preferredId, current };
        if (errorCode(error) !== 'NODE_OFFLINE' || !offline()) options.notice(error);
      }
    } finally {
      pendingRestores.delete(current);
      if (owner === storage) persist();
    }
  }

  function persist(): void {
    if ([...pendingRestores].some((current) => current())) return;
    const workspace = options.workspaceTarget.value;
    if (!initialized && workspace === undefined) return;
    initialized = true;
    if (deferred !== undefined && !deferred.current()) deferred = undefined;
    const selectedId = options.selectedSessionId.value ?? deferred?.sessionId;
    const selected = options.sessions.value.find((session) => session.id === selectedId);
    const sessionId =
      selectedId?.startsWith('draft:') ||
      (selected !== undefined && !sessionHasNativeIdentity(selected))
        ? undefined
        : selectedId;
    try {
      if (workspace === undefined) {
        storage.removeItem(SELECTION_STORAGE_KEY);
        return;
      }
      storage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({
          workspace,
          ...(sessionId === undefined ? {} : { sessionId })
        } satisfies StoredWorkbenchSelection)
      );
      options.rememberSession?.(workspace.nodeId, workspace.workspaceId, sessionId);
    } catch {
      // A blocked browser cache must not prevent Workspace selection.
    }
  }

  return {
    restore,
    restoreSession,
    persist,
    bindStorage: (next: Storage) => {
      storage = next;
      initialized = false;
      deferred = undefined;
      pendingRestores.clear();
    }
  };
}

function readSelection(storage: Storage): StoredWorkbenchSelection | undefined {
  try {
    const value = JSON.parse(storage.getItem(SELECTION_STORAGE_KEY) ?? 'null') as unknown;
    if (isSelection(value)) return value;
    if (value !== null) storage.removeItem(SELECTION_STORAGE_KEY);
    return undefined;
  } catch {
    return undefined;
  }
}

function isSelection(value: unknown): value is StoredWorkbenchSelection {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as Partial<StoredWorkbenchSelection>;
  return (
    typeof selection.workspace?.nodeId === 'string' &&
    selection.workspace.nodeId.length > 0 &&
    typeof selection.workspace.workspaceId === 'string' &&
    selection.workspace.workspaceId.length > 0 &&
    (selection.sessionId === undefined ||
      (typeof selection.sessionId === 'string' && selection.sessionId.length > 0))
  );
}
