import { describe, expect, it } from 'vitest';
import { mergeWorkspaceWatchSnapshot } from '../../src/service/WorkspaceRuntimeStateService.js';

describe('Shared Workspace topic state', () => {
  it('advances local topic revisions for accepted snapshots even when Node revisions restart', () => {
    const first = mergeWorkspaceWatchSnapshot(
      undefined,
      'node-1',
      'workspace-1',
      {
        files: { entries: [] }
      },
      { topic: 'files', revision: 9 }
    );
    const restarted = mergeWorkspaceWatchSnapshot(
      first,
      'node-1',
      'workspace-1',
      {
        files: { entries: [{ path: 'new.txt' }] }
      },
      { topic: 'files', revision: 1 }
    );
    expect(restarted.filesWatchRevision).toBe(first.filesWatchRevision! + 1);
    const sessions = mergeWorkspaceWatchSnapshot(
      restarted,
      'node-1',
      'workspace-1',
      {},
      {
        topic: 'sessions',
        revision: 2
      }
    );
    expect(sessions.filesWatchRevision).toBe(restarted.filesWatchRevision);
    expect(sessions.files).toBe(restarted.files);
    const switched = mergeWorkspaceWatchSnapshot(
      sessions,
      'node-1',
      'workspace-2',
      {
        files: { entries: [] }
      },
      { topic: 'files', revision: 1 }
    );
    expect(switched.filesWatchRevision).toBe(1);
  });

  it('merges Workspace topic snapshots within one target and clears the old topic on target switch', () => {
    const files = { entries: [{ path: 'src/main.ts' }] };
    const changes = { changes: [{ path: 'src/main.ts', status: 'MODIFIED' }] };
    const withFiles = mergeWorkspaceWatchSnapshot(undefined, 'node-1', 'workspace-1', { files });
    const withChanges = mergeWorkspaceWatchSnapshot(withFiles, 'node-1', 'workspace-1', {
      changes
    });

    expect(withChanges).toEqual({
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      files,
      changes
    });
    expect(
      mergeWorkspaceWatchSnapshot(withChanges, 'node-2', 'workspace-2', {
        changes: { changes: [] }
      })
    ).toEqual({
      nodeId: 'node-2',
      workspaceId: 'workspace-2',
      changes: { changes: [] }
    });
  });
});
