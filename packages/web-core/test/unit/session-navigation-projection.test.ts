import { describe, expect, it, vi } from 'vitest';
import {
  createSessionNavigationProjection,
  sessionNavigationQuery
} from '../../src/service/session-navigation-projection.js';

describe('Session Navigation projection', () => {
  it('omits unsupported topics and does not request descendant summaries for background tabs', () => {
    const input = {
      asideSessionIds: ['front', 'background', 'front'],
      visibleTreeAnchors: ['main', 'front'],
      treeAnchor: 'list-anchor'
    };
    expect(sessionNavigationQuery({ ...input, enabled: false })).toBeUndefined();
    expect(sessionNavigationQuery({ ...input, enabled: true })).toEqual({
      sessionIds: ['front', 'background'],
      summaryAnchors: ['main', 'front', 'list-anchor'],
      treeAnchor: 'list-anchor',
      limit: 100
    });
  });
  it('publishes successful snapshots and reports only their explicit missing targets', () => {
    const missing = vi.fn();
    const projection = createSessionNavigationProjection(missing);
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    const query = { sessionIds: ['live', 'gone'], summaryAnchors: ['live'], limit: 100 };
    const payload = {
      sessions: [
        {
          id: 'live',
          parentSessionId: null,
          title: 'Live',
          runner: 'codex',
          activity: 'IDLE',
          status: 'IDLE',
          lastActivityAt: 0
        }
      ],
      summaries: [
        {
          anchorSessionId: 'live',
          descendantCount: 2,
          activeCount: 0,
          runningCount: 0,
          sleepingCount: 0,
          hasActiveDescendants: false
        }
      ],
      tree: null,
      missingSessionIds: ['gone']
    };
    expect(projection.accept(workspace, query, payload)).toBe(true);
    expect(projection.snapshot.value).toEqual({ ...workspace, ...payload });
    expect(missing).toHaveBeenCalledWith(workspace, ['gone']);
    expect(projection.accept(workspace, query, { ...payload, missingSessionIds: null })).toBe(
      false
    );
    expect(
      projection.accept(workspace, query, { ...payload, tree: { anchorSessionId: 'live' } })
    ).toBe(false);
    expect(projection.snapshot.value).toEqual({ ...workspace, ...payload });
    expect(missing).toHaveBeenCalledOnce();
  });

  it('uses the watch identity even when a payload includes different workspace fields', () => {
    const missing = vi.fn();
    const projection = createSessionNavigationProjection(missing);
    const workspace = { nodeId: 'node-a', workspaceId: 'workspace-a' };
    expect(
      projection.accept(
        workspace,
        { sessionIds: [], summaryAnchors: [], limit: 100 },
        {
          nodeId: 'node-b',
          workspaceId: 'workspace-b',
          sessions: [],
          summaries: [],
          tree: null,
          missingSessionIds: ['gone']
        }
      )
    ).toBe(true);
    expect(projection.snapshot.value).toMatchObject(workspace);
    expect(missing).toHaveBeenCalledWith(workspace, ['gone']);
  });

  it('exposes only the snapshot for the requested Workspace and complete captured query', () => {
    const projection = createSessionNavigationProjection(vi.fn());
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    const query = { sessionIds: ['tab'], summaryAnchors: ['a'], treeAnchor: 'a', limit: 100 };
    const payload = {
      sessions: [],
      summaries: [],
      tree: { anchorSessionId: 'a', parent: null, nodes: [], truncated: false },
      missingSessionIds: []
    };
    expect(projection.accept(workspace, query, payload)).toBe(true);
    expect(projection.current(workspace, { ...query })).toMatchObject(payload);
    expect(projection.accept(workspace, { ...query, treeAnchor: 'b' }, payload)).toBe(false);
    expect(projection.current(workspace, query)).toMatchObject(payload);
    for (const next of [
      { ...query, treeAnchor: 'b' },
      { ...query, sessionIds: ['other'] },
      { ...query, summaryAnchors: ['b'] },
      { ...query, limit: 50 }
    ])
      expect(projection.current(workspace, next)).toBeUndefined();
    expect(projection.current({ ...workspace, nodeId: 'other' }, query)).toBeUndefined();
  });
});
