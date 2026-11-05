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
  readonly isWorkbenchActive: () => boolean;
  readonly nodes: Ref<readonly NodeSummary[]>;
  readonly sessions: Ref<readonly Session[]>;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly setSelectedSessionId: (id: string | undefined) => void;
  readonly activateWorkspace: (target: WorkspaceTarget) => Promise<boolean>;
  readonly synchronizeSessions: (workspaceId: string) => Promise<readonly Session[] | undefined>;
  readonly openSession: (sessionId: string) => Promise<void>;
  readonly lookupSession: (nodeId: string, sessionId: string) => Promise<Session | undefined>;
  readonly openDraft: () => void;
  readonly notice: (error: unknown) => void;
  readonly currentSelectionRevision?: () => number;
  readonly rememberSession?: (nodeId: string, workspaceId: string, sessionId?: string) => void;
}

export function createWorkbenchSelectionPersistenceService(
  options: WorkbenchSelectionPersistenceOptions
) {
  let initialized = false;
  const pendingRestores = new Set<() => boolean>();

  async function restore(): Promise<void> {
    const selection = readSelection();
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
      persist();
    }
  }

  async function restoreSession(workspaceId: string, preferredId?: string): Promise<void> {
    const targetWorkspace = options.workspaceTarget.value;
    if (targetWorkspace === undefined) return;
    const nodeId = targetWorkspace.nodeId;
    const selectedId = options.selectedSessionId.value;
    const revision = options.currentSelectionRevision?.();
    const current = () =>
      options.workspaceTarget.value === targetWorkspace &&
      targetWorkspace.workspaceId === workspaceId &&
      options.selectedSessionId.value === selectedId &&
      options.currentSelectionRevision?.() === revision;
    pendingRestores.add(current);
    try {
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
      if (target === undefined) {
        const sessions = await options.synchronizeSessions(workspaceId);
        if (!current() || sessions === undefined) return;
        target = sessions.find(
          (session) => session.workspaceId === workspaceId && session.id !== preferredId
        );
      }
      if (target === undefined) options.openDraft();
      else await options.openSession(target.id);
    } catch (error) {
      if (current()) {
        // Retain the target through transient failures, including subsequent route syncs.
        if (preferredId !== undefined) options.setSelectedSessionId(preferredId);
        options.notice(error);
      }
    } finally {
      pendingRestores.delete(current);
      persist();
    }
  }

  function persist(): void {
    if ([...pendingRestores].some((current) => current())) return;
    const workspace = options.workspaceTarget.value;
    if (!initialized && workspace === undefined) return;
    initialized = true;
    const selectedId = options.selectedSessionId.value;
    const selected = options.sessions.value.find((session) => session.id === selectedId);
    const sessionId =
      selectedId?.startsWith('draft:') ||
      (selected !== undefined && !sessionHasNativeIdentity(selected))
        ? undefined
        : selectedId;
    try {
      if (workspace === undefined) {
        localStorage.removeItem(SELECTION_STORAGE_KEY);
        return;
      }
      localStorage.setItem(
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

  return { restore, restoreSession, persist };
}

function readSelection(): StoredWorkbenchSelection | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? 'null') as unknown;
    if (isSelection(value)) return value;
    if (value !== null) localStorage.removeItem(SELECTION_STORAGE_KEY);
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
