import { describe, expect, it } from 'vitest';
import { createWorkbenchWorkspaceSelectionState } from '../../src/service/workbench-workspace-selection-service.js';
import { createWorkbenchSessionSelectionState } from '../../src/service/workbench-session-selection-service.js';

describe('Workbench selection owners', () => {
  it('keeps Workspace and Session selection independent between compositions', () => {
    const first = createWorkbenchWorkspaceSelectionState();
    const second = createWorkbenchWorkspaceSelectionState();
    const firstSession = createWorkbenchSessionSelectionState(first.target);
    const secondSession = createWorkbenchSessionSelectionState(second.target);
    first.setTarget({ nodeId: 'node', workspaceId: 'workspace' });
    expect(first).not.toHaveProperty('selectedNodeId');
    expect(first).not.toHaveProperty('selectedWorkspaceId');
    expect(first.target.value).toEqual({ nodeId: 'node', workspaceId: 'workspace' });
    expect(first).not.toHaveProperty('workspaceNodeId');
    firstSession.setSession('session');
    expect(firstSession.draftTarget.value).toEqual({
      kind: 'session',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session'
    });
    firstSession.setDraftOpen(true);
    expect(firstSession.draftTarget.value).toEqual({
      kind: 'workspace',
      nodeId: 'node',
      workspaceId: 'workspace'
    });
    expect(second.target.value).toBeUndefined();
    expect(secondSession.sessionId.value).toBeUndefined();
    first.setTarget(undefined);
    expect(first.target.value).toBeUndefined();
    expect(firstSession.draftTarget.value).toBeUndefined();
  });
});
