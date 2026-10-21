import { describe, expect, it } from 'vitest';
import { createWorkbenchSelectionStateService } from '../../src/service/WorkbenchSelectionStateService.js';

describe('Public Workbench Selection State', () => {
  it('Keeps selection state independent per composition', () => {
    const first = createWorkbenchSelectionStateService();
    const second = createWorkbenchSelectionStateService();
    first.workspaceTarget.value = { nodeId: 'node', workspaceId: 'workspace' };
    expect(first).not.toHaveProperty('selectedNodeId');
    expect(first).not.toHaveProperty('selectedWorkspaceId');
    expect(first.workspaceTarget.value).toEqual({ nodeId: 'node', workspaceId: 'workspace' });
    expect(first).not.toHaveProperty('workspaceNodeId');
    first.workspaceTarget.value = undefined;
    expect(first.workspaceTarget.value).toBeUndefined();
    first.loading.value = true;
    expect(second.workspaceTarget.value).toBeUndefined();
    expect(second.loading.value).toBe(false);
    expect(second.workspaces.value).toEqual([]);
    expect(second.sessions.value).toEqual([]);
  });
});
