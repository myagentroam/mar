import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { WorkspaceSessionNavigationQuery } from '@myagentroam/protocol';
import type { Session, WorkspaceTarget } from '../../src/model/workbench.js';
import { createWorkspaceWatchProjection } from '../../src/service/workspace-watch-projection.js';

const nodeId = 'node-1';
const workspaceId = 'workspace-1';

function navigationQuery(sessionIds = ['session-1']): WorkspaceSessionNavigationQuery {
  return {
    sessionIds,
    summaryAnchors: ['session-1'],
    treeAnchor: 'session-1',
    limit: 20
  };
}

function session(id: string, runnerTitle: string): Session {
  return { id, workspaceId, runner: 'codex', runnerTitle };
}

function setup(
  options: {
    readonly target?: WorkspaceTarget | undefined;
    readonly query?: WorkspaceSessionNavigationQuery | undefined;
    readonly sessions?: readonly Session[];
    readonly selectedId?: string | undefined;
  } = {}
) {
  const target = ref<WorkspaceTarget | undefined>(options.target ?? { nodeId, workspaceId });
  const query = ref<WorkspaceSessionNavigationQuery | undefined>(options.query);
  const currentSessions = ref<readonly Session[]>(options.sessions ?? []);
  const selectedId = ref<string | undefined>(options.selectedId);
  const navigationAccept = vi.fn();
  const filesAccept = vi.fn();
  const updateBranch = vi.fn();
  const applySnapshot = vi.fn(
    (_nodeId: string, _workspaceId: string, page: { readonly sessions: readonly Session[] }) => {
      currentSessions.value = page.sessions;
    }
  );
  const reconciledSelection: Array<Session | undefined> = [];
  const reconcile = vi.fn((_previous: Session | undefined, _current: Session | undefined) => {
    reconciledSelection.push(currentSessions.value.find((item) => item.id === selectedId.value));
  });

  const projection = createWorkspaceWatchProjection({
    workspaceTarget: target,
    navigation: { query: () => query.value, accept: navigationAccept },
    files: { acceptWatch: filesAccept },
    updateBranch,
    sessions: {
      current: currentSessions,
      selectedId,
      applySnapshot,
      reconcile
    }
  });

  return {
    projection,
    target,
    query,
    currentSessions,
    navigationAccept,
    filesAccept,
    updateBranch,
    applySnapshot,
    reconcile,
    reconciledSelection
  };
}

describe('Workspace Watch snapshot projection', () => {
  it('accepts a current navigation snapshot only for its target and query', () => {
    const currentQuery = navigationQuery();
    const capturedQuery = navigationQuery();
    const navigationSnapshot = {
      sessions: [],
      summaries: [],
      missingSessionIds: [],
      tree: null
    };
    const f = setup({ query: currentQuery });

    f.projection.accept(
      nodeId,
      workspaceId,
      { sessionNavigation: navigationSnapshot },
      'sessionNavigation',
      4,
      capturedQuery
    );

    expect(f.navigationAccept).toHaveBeenCalledWith(
      { nodeId, workspaceId },
      capturedQuery,
      navigationSnapshot
    );
    expect(f.filesAccept).not.toHaveBeenCalled();
    expect(f.applySnapshot).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('ignores navigation snapshots captured for an outdated query', () => {
    const f = setup({ query: navigationQuery(['session-2']) });

    f.projection.accept(
      nodeId,
      workspaceId,
      { sessionNavigation: { sessions: [] } },
      'sessionNavigation',
      5,
      navigationQuery(['session-1'])
    );

    expect(f.navigationAccept).not.toHaveBeenCalled();
    expect(f.filesAccept).not.toHaveBeenCalled();
    expect(f.applySnapshot).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('ignores navigation snapshots for a different active Workspace', () => {
    const f = setup({ target: { nodeId: 'node-2', workspaceId } });
    const query = navigationQuery();
    f.query.value = query;

    f.projection.accept(
      nodeId,
      workspaceId,
      { sessionNavigation: { sessions: [] } },
      'sessionNavigation',
      6,
      query
    );

    expect(f.navigationAccept).not.toHaveBeenCalled();
    expect(f.filesAccept).not.toHaveBeenCalled();
    expect(f.applySnapshot).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('forwards each file topic revision and updates the branch from Git Changes', () => {
    const f = setup();
    const filesSnapshot = { files: { entries: ['README.md'] } };
    const changesSnapshot = { changes: { branch: 'feature/watch-projection' } };

    f.projection.accept(nodeId, workspaceId, filesSnapshot, 'files', 12);
    f.projection.accept(nodeId, workspaceId, changesSnapshot, 'changes', 27);

    expect(f.filesAccept).toHaveBeenNthCalledWith(1, nodeId, workspaceId, filesSnapshot, {
      topic: 'files',
      revision: 12
    });
    expect(f.filesAccept).toHaveBeenNthCalledWith(2, nodeId, workspaceId, changesSnapshot, {
      topic: 'changes',
      revision: 27
    });
    expect(f.updateBranch).toHaveBeenCalledTimes(1);
    expect(f.updateBranch).toHaveBeenCalledWith(nodeId, workspaceId, 'feature/watch-projection');
  });

  it('applies session paging and running counts before reconciling the selected session', () => {
    const previous = session('session-1', 'Before snapshot');
    const current = session('session-1', 'After snapshot');
    const f = setup({ sessions: [previous], selectedId: previous.id });
    const runningCounts = { MAIN: 2, CHILD: 1 };
    const page = { sessions: [current], runningCounts, nextCursor: 'older-sessions' };

    f.projection.accept(nodeId, workspaceId, { sessions: page }, 'sessions', 31);

    expect(f.applySnapshot).toHaveBeenCalledWith(nodeId, workspaceId, page);
    expect(f.reconcile).toHaveBeenCalledWith(previous, current);
    expect(f.reconciledSelection).toEqual([current]);
    expect(f.currentSessions.value).toEqual([current]);
  });

  it('leaves the current session state alone when a snapshot has no sessions data', () => {
    const existing = session('session-1', 'Keep this session');
    const f = setup({ sessions: [existing], selectedId: existing.id });

    f.projection.accept(nodeId, workspaceId, { files: { entries: [] } }, 'files', 32);

    expect(f.currentSessions.value).toEqual([existing]);
    expect(f.applySnapshot).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });
});
