import { shallowRef } from 'vue';

export type AsideTool = 'files' | 'search' | 'changes' | 'history' | 'terminal';
export type AsideViewMode = 'compact' | 'content';
export type AsideTarget =
  | { readonly kind: 'tool'; readonly id: AsideTool }
  | { readonly kind: 'browser' }
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
  readonly active?: AsideTarget | undefined;
  readonly recentTool?: AsideTool | undefined;
  readonly terminalReturn?: AsideTarget | undefined;
  readonly htmlPath?: string | undefined;
}
export interface AsideState extends AsideSnapshot {
  readonly tools: readonly AsideTool[];
}

export const ASIDE_TOOLS: readonly AsideTool[] = [
  'files',
  'search',
  'changes',
  'history',
  'terminal'
];
const empty: AsideState = { tools: [], sessions: [] };

export function asideViewMode(target: AsideTarget | undefined): AsideViewMode {
  return target?.kind === 'session' ||
    target?.kind === 'browser' ||
    (target?.kind === 'tool' && target.id === 'terminal')
    ? 'content'
    : 'compact';
}

export function createWorkbenchAsideService(sessionTabLimit = 1) {
  const workspaces = shallowRef<ReadonlyMap<string, ReadonlyMap<string, AsideState>>>(new Map());

  function current(target: AsideWorkspace): AsideState {
    return workspaces.value.get(target.nodeId)?.get(target.workspaceId) ?? empty;
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
        ? state.tools.includes(target.id)
        : target.kind === 'browser'
          ? state.tools.includes('files') && state.htmlPath !== undefined
          : state.sessions.includes(target.sessionId))
    );
  }
  function fallback(state: AsideState): AsideTarget | undefined {
    const tool =
      state.recentTool && state.tools.includes(state.recentTool)
        ? state.recentTool
        : state.tools.find((item) => item !== 'terminal');
    return tool === undefined ? undefined : { kind: 'tool', id: tool };
  }
  function ensure(target: AsideWorkspace, tools: readonly AsideTool[]): void {
    const available = ASIDE_TOOLS.filter((tool) => tools.includes(tool));
    const prior = current(target);
    const next: AsideState = { ...prior, tools: available };
    put(target, {
      ...next,
      active: valid(next, prior.active)
        ? prior.active
        : (fallback(next) ??
          (available.includes('terminal') ? { kind: 'tool', id: 'terminal' } : undefined))
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
      active: { kind: 'tool', id },
      terminalReturn,
      ...(id === 'terminal' ? {} : { recentTool: id })
    });
    return true;
  }
  function openSession(target: AsideSession): void {
    const state = current(target);
    put(target, {
      ...state,
      sessions: state.sessions.includes(target.sessionId)
        ? state.sessions
        : [...state.sessions, target.sessionId],
      active: { kind: 'session', sessionId: target.sessionId }
    });
  }

  function openHtml(target: AsideWorkspace, path: string): boolean {
    const state = current(target);
    if (!state.tools.includes('files')) return false;
    put(target, { ...state, htmlPath: path, active: { kind: 'browser' } });
    return true;
  }

  function activateHtml(target: AsideWorkspace): boolean {
    const state = current(target);
    if (!valid(state, { kind: 'browser' })) return false;
    put(target, { ...state, active: { kind: 'browser' } });
    return true;
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
        active:
          neighbor !== undefined
            ? { kind: 'session', sessionId: neighbor }
            : valid(next, { kind: 'browser' })
              ? { kind: 'browser' }
              : fallback(next)
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
      active: valid(state, state.terminalReturn) ? state.terminalReturn : fallback(state)
    });
    return true;
  }
  function snapshot(target: AsideWorkspace): AsideSnapshot {
    const { sessions, active, recentTool, terminalReturn, htmlPath } = current(target);
    return { sessions: [...sessions], active, recentTool, terminalReturn, htmlPath };
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
      htmlPath: saved.htmlPath
    });
    ensure(target, tools);
  }
  function clearHtmlWorkspace(target: AsideWorkspace): void {
    const state = workspaces.value.get(target.nodeId)?.get(target.workspaceId);
    if (state?.htmlPath === undefined) return;
    const next: AsideState = { ...state, htmlPath: undefined };
    const sessionId = state.sessions.at(-1);
    put(target, {
      ...next,
      active:
        state.active?.kind !== 'browser'
          ? state.active
          : sessionId !== undefined
            ? { kind: 'session', sessionId }
            : fallback(next)
    });
  }
  function clearHtmlNode(nodeId: string): void {
    for (const workspaceId of workspaces.value.get(nodeId)?.keys() ?? [])
      clearHtmlWorkspace({ nodeId, workspaceId });
  }
  function clearHtml(): void {
    for (const nodeId of workspaces.value.keys()) clearHtmlNode(nodeId);
  }
  function removeWorkspace(target: AsideWorkspace): void {
    const nodes = new Map(workspaces.value);
    const entries = new Map(nodes.get(target.nodeId));
    entries.delete(target.workspaceId);
    if (entries.size === 0) nodes.delete(target.nodeId);
    else nodes.set(target.nodeId, entries);
    workspaces.value = nodes;
  }
  return {
    current,
    ensure,
    selectTool,
    openHtml,
    activateHtml,
    openSession,
    replaceSession,
    activateSession,
    closeSession,
    removeMissing,
    toggleTerminal,
    snapshot,
    restore,
    removeWorkspace,
    clearHtmlWorkspace,
    clearHtmlNode,
    clearHtml
  };
}
