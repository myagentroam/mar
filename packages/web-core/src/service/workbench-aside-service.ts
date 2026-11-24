import type { WorkspaceSessionPaneView } from './workspace-session-pane-controller.js';
import type { NavigationSession } from './session-navigation-projection.js';
import { shallowRef, watch, type Ref } from 'vue';

export type AsideTool = 'files' | 'search' | 'changes' | 'history' | 'terminal' | 'node-browser';
export type AsideViewMode = 'compact' | 'content';
export type AsideTarget =
  | { readonly kind: 'tool'; readonly id: AsideTool }
  | { readonly kind: 'session'; readonly sessionId: string };
export interface AsideWorkspace {
  readonly nodeId: string;
  readonly workspaceId: string;
}
export interface AsideSession extends AsideWorkspace {
  readonly sessionId: string;
}
export interface AsideSnapshot {
  readonly sessions: readonly string[];
  readonly browserOpen?: boolean;
  readonly terminalOpen?: boolean;
  readonly active?: AsideTarget | undefined;
  readonly recentTool?: AsideTool | undefined;
  readonly terminalReturn?: AsideTarget | undefined;
}
export interface AsideState extends AsideSnapshot {
  readonly tools: readonly AsideTool[];
  readonly collapsed?: boolean;
}

export const ASIDE_TOOLS: readonly AsideTool[] = [
  'files',
  'search',
  'changes',
  'history',
  'terminal',
  'node-browser'
];
const empty: AsideState = { tools: [], sessions: [] };

export function asideViewMode(target: AsideTarget | undefined): AsideViewMode {
  return target?.kind === 'session' ||
    (target?.kind === 'tool' && (target.id === 'terminal' || target.id === 'node-browser'))
    ? 'content'
    : 'compact';
}

/** Owns each open Workspace's Aside tab metadata and in-memory desktop visibility preference. */
export function createWorkbenchAsideService({
  sessionTabLimit = 1,
  mobileViewport
}: {
  readonly sessionTabLimit?: number;
  readonly mobileViewport?: Readonly<Ref<boolean>>;
} = {}) {
  const workspaces = shallowRef<ReadonlyMap<string, ReadonlyMap<string, AsideState>>>(new Map());

  function observeCapabilities(input: {
    readonly workspace: Readonly<Ref<AsideWorkspace | undefined>>;
    readonly manifest: Readonly<
      Ref<import('../model/workbench.js').NodeWorkbenchManifest | undefined>
    >;
    readonly selectedWorkspace: Readonly<
      Ref<import('../model/workbench.js').Workspace | undefined>
    >;
  }): void {
    const workspaceTarget = input.workspace;
    const nodeManifest = input.manifest;
    const selectedWorkspace = input.selectedWorkspace;
    watch(
      [workspaceTarget, nodeManifest, () => selectedWorkspace.value?.kind],
      ([target, manifest, kind]) => {
        if (target === undefined || manifest === undefined) return;
        const tools: AsideTool[] = [];
        if (manifest.files?.available === true) tools.push('files', 'search');
        if (kind === 'GIT_WORKSPACE') {
          tools.push('changes');
          if (manifest.git?.supportsHistory === true) tools.push('history');
        }
        if (manifest.terminal?.available === true && manifest.terminal.supportsReplay === true)
          tools.push('terminal');
        if (manifest.browser?.apiVersion === 1) tools.push('node-browser');
        ensure(target, tools);
      },
      { immediate: true }
    );
  }

  function current(target: AsideWorkspace): AsideState {
    return workspaces.value.get(target.nodeId)?.get(target.workspaceId) ?? empty;
  }
  function setCollapsed(target: AsideWorkspace, collapsed: boolean): void {
    const state = current(target);
    if ((state.collapsed ?? false) !== collapsed) put(target, { ...state, collapsed });
  }
  function put(target: AsideWorkspace, state: AsideState): void {
    if (state.sessions.length > sessionTabLimit) {
      const retainedSessionId =
        state.active?.kind === 'session' && valid(state, state.active)
          ? state.active.sessionId
          : state.terminalReturn?.kind === 'session'
            ? state.terminalReturn.sessionId
            : undefined;
      const removed = new Set(
        state.sessions
          .filter((id) => id !== retainedSessionId)
          .slice(0, state.sessions.length - sessionTabLimit)
      );
      state = { ...state, sessions: state.sessions.filter((id) => !removed.has(id)) };
    }
    if (state.terminalReturn !== undefined && !valid(state, state.terminalReturn))
      state = { ...state, terminalReturn: undefined };
    const nodes = new Map(workspaces.value);
    const entries = new Map(nodes.get(target.nodeId));
    entries.set(target.workspaceId, state);
    nodes.set(target.nodeId, entries);
    workspaces.value = nodes;
  }
  function valid(state: AsideState, target: AsideTarget | undefined): target is AsideTarget {
    return (
      target !== undefined &&
      (target.kind === 'tool'
        ? state.tools.includes(target.id) &&
          (target.id !== 'node-browser' || state.browserOpen === true) &&
          (target.id !== 'terminal' || state.terminalOpen === true)
        : state.sessions.includes(target.sessionId))
    );
  }
  function fallback(state: AsideState): AsideTarget | undefined {
    const tool =
      state.recentTool &&
      state.recentTool !== 'node-browser' &&
      state.tools.includes(state.recentTool)
        ? state.recentTool
        : state.tools.find((item) => item !== 'terminal' && item !== 'node-browser');
    return tool === undefined ? undefined : { kind: 'tool', id: tool };
  }
  function ensure(target: AsideWorkspace, tools: readonly AsideTool[]): void {
    const available = ASIDE_TOOLS.filter((tool) => tools.includes(tool));
    const prior = current(target);
    const next: AsideState = {
      ...prior,
      tools: available,
      ...(prior.browserOpen && !available.includes('node-browser') ? { browserOpen: false } : {}),
      ...(prior.terminalOpen && !available.includes('terminal')
        ? { terminalOpen: false, terminalReturn: undefined }
        : {})
    };
    put(target, {
      ...next,
      active: valid(next, prior.active) ? prior.active : fallback(next)
    });
  }
  function selectTool(target: AsideWorkspace, id: AsideTool): boolean {
    const state = current(target);
    if (!state.tools.includes(id)) return false;
    const terminalReturn =
      id === 'terminal' &&
      state.active?.kind !== undefined &&
      !(state.active.kind === 'tool' && state.active.id === 'terminal')
        ? state.active
        : state.terminalReturn;
    put(target, {
      ...state,
      ...(mobileViewport?.value ? {} : { collapsed: false }),
      active: { kind: 'tool', id },
      terminalReturn,
      ...(id === 'node-browser'
        ? { browserOpen: true }
        : id === 'terminal'
          ? { terminalOpen: true }
          : { recentTool: id })
    });
    return true;
  }

  function closeBrowser(target: AsideWorkspace): void {
    const state = current(target);
    if (!state.browserOpen) return;
    const next = { ...state, browserOpen: false };
    if (state.active?.kind === 'tool' && state.active.id === 'node-browser') {
      const sessionId = state.sessions.at(-1);
      put(target, {
        ...next,
        active: sessionId
          ? { kind: 'session', sessionId }
          : (fallback(next) ?? (state.terminalOpen ? { kind: 'tool', id: 'terminal' } : undefined))
      });
    } else put(target, next);
  }
  function closeTerminal(target: AsideWorkspace): void {
    const state = current(target);
    if (!state.terminalOpen) return;
    const next: AsideState = { ...state, terminalOpen: false, terminalReturn: undefined };
    put(target, {
      ...next,
      active:
        state.active?.kind === 'tool' && state.active.id === 'terminal'
          ? terminalFallback(next, state.terminalReturn)
          : state.active
    });
  }

  function terminalFallback(state: AsideState, previous: AsideTarget | undefined) {
    if (valid(state, previous) && !(previous.kind === 'tool' && previous.id === 'terminal'))
      return previous;
    const sessionId = state.sessions.at(-1);
    return (
      (sessionId ? ({ kind: 'session', sessionId } as const) : undefined) ??
      fallback(state) ??
      (state.browserOpen ? ({ kind: 'tool', id: 'node-browser' } as const) : undefined)
    );
  }
  function openSession(target: AsideSession): void {
    const state = current(target);
    if (state.active?.kind === 'session' && state.active.sessionId === target.sessionId) {
      if (!mobileViewport?.value) setCollapsed(target, false);
      return;
    }
    put(target, {
      ...state,
      ...(mobileViewport?.value ? {} : { collapsed: false }),
      sessions: state.sessions.includes(target.sessionId)
        ? state.sessions
        : [...state.sessions, target.sessionId],
      active: { kind: 'session', sessionId: target.sessionId }
    });
  }

  function replaceSession(target: AsideSession, nextSessionId: string): boolean {
    const state = current(target);
    if (!state.sessions.includes(target.sessionId)) return false;
    const replace = (value: AsideTarget | undefined): AsideTarget | undefined =>
      value?.kind === 'session' && value.sessionId === target.sessionId
        ? { kind: 'session', sessionId: nextSessionId }
        : value;
    put(target, {
      ...state,
      sessions: [
        ...new Set(state.sessions.map((id) => (id === target.sessionId ? nextSessionId : id)))
      ],
      active: replace(state.active),
      terminalReturn: replace(state.terminalReturn)
    });
    return true;
  }
  function activateSession(target: AsideSession): boolean {
    if (!current(target).sessions.includes(target.sessionId)) return false;
    openSession(target);
    return true;
  }
  function closeSession(target: AsideSession): void {
    removeMissing(target, [target.sessionId]);
  }
  function removeMissing(target: AsideWorkspace, ids: readonly string[]): void {
    const state = current(target);
    const missing = new Set(ids);
    if (!state.sessions.some((id) => missing.has(id))) return;
    const sessions = state.sessions.filter((id) => !missing.has(id));
    const next: AsideState = {
      ...state,
      sessions,
      terminalReturn:
        state.terminalReturn?.kind === 'session' && missing.has(state.terminalReturn.sessionId)
          ? undefined
          : state.terminalReturn
    };
    if (state.active?.kind === 'session' && missing.has(state.active.sessionId)) {
      const index = state.sessions.indexOf(state.active.sessionId);
      const neighbor =
        state.sessions
          .slice(0, index)
          .reverse()
          .find((id) => !missing.has(id)) ??
        state.sessions.slice(index + 1).find((id) => !missing.has(id));
      put(target, {
        ...next,
        active: neighbor !== undefined ? { kind: 'session', sessionId: neighbor } : fallback(next)
      });
    } else put(target, next);
  }
  function toggleTerminal(target: AsideWorkspace): boolean {
    const state = current(target);
    if (!state.tools.includes('terminal')) return false;
    if (state.active?.kind !== 'tool' || state.active.id !== 'terminal')
      return selectTool(target, 'terminal');
    put(target, {
      ...state,
      active: terminalFallback(state, state.terminalReturn)
    });
    return true;
  }
  function snapshot(target: AsideWorkspace): AsideSnapshot {
    const { sessions, active, recentTool, terminalReturn, browserOpen, terminalOpen } =
      current(target);
    return {
      sessions: [...sessions],
      active,
      recentTool,
      terminalReturn,
      ...(browserOpen ? { browserOpen } : {}),
      ...(terminalOpen ? { terminalOpen } : {})
    };
  }
  function restore(
    target: AsideWorkspace,
    saved: AsideSnapshot,
    tools: readonly AsideTool[]
  ): void {
    const sessions = [
      ...new Set(saved.sessions.filter((id) => typeof id === 'string' && id.length > 0))
    ];
    put(target, {
      tools: ASIDE_TOOLS.filter((tool) => tools.includes(tool)),
      sessions,
      active: saved.active,
      recentTool: saved.recentTool,
      terminalReturn: saved.terminalReturn,
      ...(saved.browserOpen ? { browserOpen: true } : {}),
      ...(saved.terminalOpen ? { terminalOpen: true } : {})
    });
    ensure(target, tools);
  }
  function removeWorkspace(target: AsideWorkspace): void {
    const nodes = new Map(workspaces.value);
    const entries = new Map(nodes.get(target.nodeId));
    entries.delete(target.workspaceId);
    if (entries.size === 0) nodes.delete(target.nodeId);
    else nodes.set(target.nodeId, entries);
    workspaces.value = nodes;
  }

  function createInteraction(options: {
    readonly workspace: Readonly<Ref<AsideWorkspace | undefined>>;
    readonly mobileSurface: Readonly<Ref<string>>;
    readonly saveSession: () => void;
    readonly openMobile: (surface: 'terminal' | 'inspector') => void;
    readonly closeMobile?: () => void;
  }) {
    function owns(target: AsideWorkspace): boolean {
      const workspace = options.workspace.value;
      return workspace?.nodeId === target.nodeId && workspace.workspaceId === target.workspaceId;
    }
    function saveActive(target: AsideWorkspace): void {
      if (current(target).active?.kind === 'session') options.saveSession();
    }
    function select(target: AsideWorkspace & { readonly id: AsideTool }): void {
      if (!owns(target)) return;
      saveActive(target);
      if (selectTool(target, target.id) && mobileViewport?.value)
        options.openMobile(target.id === 'terminal' ? 'terminal' : 'inspector');
    }
    function toggleTerminalSurface(): void {
      const target = options.workspace.value;
      if (target === undefined) return;
      saveActive(target);
      const mobile = mobileViewport?.value === true;
      const surface = options.mobileSurface.value;
      if (mobile ? surface !== 'inspector' && surface !== 'terminal' : current(target).collapsed) {
        if (selectTool(target, 'terminal') && mobile) options.openMobile('terminal');
        return;
      }
      if (!toggleTerminal(target)) return;
      if (mobile) {
        const active = current(target).active;
        if (!active) {
          options.closeMobile?.();
          return;
        }
        options.openMobile(
          active?.kind === 'tool' && active.id === 'terminal' ? 'terminal' : 'inspector'
        );
      }
    }
    return { select, toggleTerminal: toggleTerminalSurface };
  }
  return {
    observeCapabilities,
    createInteraction,
    current,
    setCollapsed,
    ensure,
    selectTool,
    openSession,
    replaceSession,
    activateSession,
    closeSession,
    closeBrowser,
    closeTerminal,
    removeMissing,
    toggleTerminal,
    snapshot,
    restore,
    removeWorkspace,
    removeNode: (nodeId: string) => {
      const nodes = new Map(workspaces.value);
      nodes.delete(nodeId);
      workspaces.value = nodes;
    },
    clear: () => {
      workspaces.value = new Map();
    }
  };
}

export interface WorkbenchAsideView {
  asidePaneController: WorkspaceSessionPaneView;
  asideSessionLocation: AsideSession | undefined;
  asideSessionMetadata: NavigationSession[];
  asideState: AsideState | undefined;
  asideSupported: boolean;
  asideViewMode: (target: AsideTarget | undefined) => AsideViewMode;
  asideWidth: (
    mode: AsideViewMode,
    availableWidth: number,
    mainMinWidth: number
  ) => number | undefined;
  closeAsideSession: (target: AsideSession) => void;
  closeAsideBrowser: (target: AsideWorkspace) => void;
  closeAsideTerminal: (target: AsideWorkspace) => Promise<void>;
  terminalSessionsEnded: (target: AsideWorkspace) => void;
  terminalTabOpen: (target: AsideWorkspace) => boolean;
  openAsideSession: (target: AsideSession) => boolean;
  openHtmlAside: (path: string) => void;
  reloadAsideSession: () => void;
  selectAsideTool: (target: AsideWorkspace & { readonly id: AsideTool }) => void;
  setAsideCollapsed: (target: AsideWorkspace, collapsed: boolean) => void;
  setAsideSessionFits: (fits: boolean | undefined) => void;
  setAsideSurfaceVisible: (visible: boolean) => void;
  toggleAsideTerminal: () => void;
}
