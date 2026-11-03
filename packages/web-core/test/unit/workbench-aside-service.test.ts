import { describe, expect, it } from 'vitest';
import { createWorkbenchAsideService } from '../../src/service/workbench-aside-service.js';

describe('Workspace Aside metadata', () => {
  it('keeps independent session tabs and chooses neighboring sessions before the latest tool', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files', 'search', 'terminal']);
    service.selectTool(workspace, 'search');
    service.openSession({ ...workspace, sessionId: 'a' });
    service.openSession({ ...workspace, sessionId: 'b' });
    service.openSession({ ...workspace, sessionId: 'c' });
    service.closeSession({ ...workspace, sessionId: 'b' });
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'c' });
    service.closeSession({ ...workspace, sessionId: 'c' });
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'a' });
    service.closeSession({ ...workspace, sessionId: 'a' });
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'search' });
  });

  it('restores metadata without duplicate sessions and toggles Terminal to its valid prior target', () => {
    const service = createWorkbenchAsideService();
    const a = { nodeId: 'node', workspaceId: 'a' };
    const b = { nodeId: 'node', workspaceId: 'b' };
    service.ensure(a, ['files', 'terminal']);
    service.ensure(b, ['terminal']);
    service.openSession({ ...a, sessionId: 'one' });
    service.openSession({ ...a, sessionId: 'one' });
    service.toggleTerminal(a);
    const saved = service.snapshot(a);
    expect(saved.sessions).toEqual(['one']);
    const restored = createWorkbenchAsideService();
    restored.restore(a, saved, ['files', 'terminal']);
    expect(restored.current(a).active).toEqual({ kind: 'tool', id: 'terminal' });
    restored.toggleTerminal(a);
    expect(restored.current(a).active).toEqual({ kind: 'session', sessionId: 'one' });
    restored.closeSession({ ...a, sessionId: 'one' });
    expect(restored.current(a).active).toEqual({ kind: 'tool', id: 'files' });
    expect(service.current(b).sessions).toEqual([]);
    service.removeWorkspace(a);
    expect(service.current(a).sessions).toEqual([]);
    expect(service.current(b).active).toEqual({ kind: 'tool', id: 'terminal' });
  });

  it('removes only authoritatively missing sessions without dropping other Workspace tabs', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files']);
    for (const sessionId of ['a', 'b', 'c']) service.openSession({ ...workspace, sessionId });
    service.activateSession({ ...workspace, sessionId: 'b' });
    service.removeMissing(workspace, ['b', 'unrelated']);
    expect(service.current(workspace).sessions).toEqual(['a', 'c']);
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'a' });
  });
});
