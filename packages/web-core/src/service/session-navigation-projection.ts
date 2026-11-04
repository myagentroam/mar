import { shallowRef } from 'vue';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { WorkspaceSessionNavigationQuery } from '@myagentroam/protocol';
import { sameNavigation } from './workspace-watch-service.js';

export function sessionNavigationQuery(options: {
  readonly enabled: boolean;
  readonly asideSessionIds: readonly string[];
  readonly visibleTreeAnchors: readonly string[];
  readonly treeAnchor?: string | undefined;
}): WorkspaceSessionNavigationQuery | undefined {
  if (!options.enabled) return undefined;
  return {
    sessionIds: [...new Set(options.asideSessionIds)],
    summaryAnchors: [
      ...new Set([
        ...options.visibleTreeAnchors,
        ...(options.treeAnchor === undefined ? [] : [options.treeAnchor])
      ])
    ],
    ...(options.treeAnchor === undefined ? {} : { treeAnchor: options.treeAnchor }),
    limit: 100
  };
}

export interface NavigationSession {
  readonly id: string;
  readonly parentSessionId: string | null;
  readonly title: string;
  readonly runner: string;
  readonly activity: string;
  readonly status: string;
  readonly lastActivityAt: number;
}

export interface NavigationSummary {
  readonly anchorSessionId: string;
  readonly descendantCount: number;
  readonly activeCount: number;
  readonly runningCount: number;
  readonly sleepingCount: number;
  readonly hasActiveDescendants: boolean;
}

export interface NavigationSnapshot extends WorkspaceTarget {
  readonly sessions: readonly NavigationSession[];
  readonly summaries: readonly NavigationSummary[];
  readonly tree: {
    readonly anchorSessionId: string;
    readonly parent: NavigationSession | null;
    readonly nodes: readonly NavigationSession[];
    readonly truncated: boolean;
  } | null;
  readonly missingSessionIds: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function session(value: unknown): value is NavigationSession {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    (value.parentSessionId === null || typeof value.parentSessionId === 'string') &&
    typeof value.title === 'string' &&
    typeof value.runner === 'string' &&
    typeof value.activity === 'string' &&
    typeof value.status === 'string' &&
    typeof value.lastActivityAt === 'number'
  );
}

function summary(value: unknown): value is NavigationSummary {
  return (
    record(value) &&
    typeof value.anchorSessionId === 'string' &&
    typeof value.descendantCount === 'number' &&
    typeof value.activeCount === 'number' &&
    typeof value.runningCount === 'number' &&
    typeof value.sleepingCount === 'number' &&
    typeof value.hasActiveDescendants === 'boolean'
  );
}

export function createSessionNavigationProjection(
  onMissing: (workspace: WorkspaceTarget, sessionIds: readonly string[]) => void
) {
  const snapshot = shallowRef<NavigationSnapshot>();
  let acceptedQuery: WorkspaceSessionNavigationQuery | undefined;

  function accept(
    workspace: WorkspaceTarget,
    query: WorkspaceSessionNavigationQuery,
    value: unknown
  ): boolean {
    if (
      !record(value) ||
      !Array.isArray(value.sessions) ||
      !value.sessions.every(session) ||
      !Array.isArray(value.summaries) ||
      !value.summaries.every(summary) ||
      !Array.isArray(value.missingSessionIds) ||
      !value.missingSessionIds.every((id: unknown) => typeof id === 'string') ||
      (value.tree !== null &&
        (!record(value.tree) ||
          typeof value.tree.anchorSessionId !== 'string' ||
          value.tree.anchorSessionId !== query.treeAnchor ||
          (value.tree.parent !== null && !session(value.tree.parent)) ||
          !Array.isArray(value.tree.nodes) ||
          !value.tree.nodes.every(session) ||
          typeof value.tree.truncated !== 'boolean'))
    )
      return false;
    acceptedQuery = query;
    snapshot.value = { ...value, ...workspace } as NavigationSnapshot;
    onMissing(workspace, value.missingSessionIds);
    return true;
  }

  function current(
    workspace: WorkspaceTarget | undefined,
    query: WorkspaceSessionNavigationQuery | undefined
  ) {
    const value = snapshot.value;
    return workspace !== undefined &&
      query !== undefined &&
      workspace.nodeId === value?.nodeId &&
      workspace.workspaceId === value.workspaceId &&
      sameNavigation(query, acceptedQuery)
      ? value
      : undefined;
  }

  return { snapshot, accept, current };
}
