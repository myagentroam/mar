import { describe, expect, it } from 'vitest';
import { mergeWorkspaceWatchSnapshot } from '../../src/service/WorkspaceRuntimeStateService.js';

describe('Shared Workspace topic state', () => {
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
