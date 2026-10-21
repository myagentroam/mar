import { describe, expect, it } from 'vitest';
import { createWorkspaceSessionPagingService } from '../../src/service/WorkspaceSessionPagingService.js';

describe('Web Workspace Session Paging State', () => {
  it('Initialization, page appends, and Node cleanup preserve Tab boundaries', () => {
    const state = createWorkspaceSessionPagingService(10);
    state.initialize('node-1:workspace-1');
    state.append('node-1:workspace-1', 10, 'next-page');
    state.initialize('node-2:workspace-1');

    expect(state.visibleLimits.value.get('node-1:workspace-1')).toBe(20);
    expect(state.nextCursors.value.get('node-1:workspace-1')).toBe('next-page');
    state.removeNode('node-1');
    expect(state.visibleLimits.value.has('node-1:workspace-1')).toBe(false);
    expect(state.visibleLimits.value.has('node-2:workspace-1')).toBe(true);
  });

  it('Expands the visible limit when opening a session that is currently hidden', () => {
    const state = createWorkspaceSessionPagingService(10);
    state.ensureVisible('node-1:workspace-1', 12);
    expect(state.visibleLimits.value.get('node-1:workspace-1')).toBe(13);
  });
});
