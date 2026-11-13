import { describe, expect, it } from 'vitest';
import {
  asideViewMode,
  createWorkbenchAsideService
} from '../../src/service/workbench-aside-service.js';

describe('Workspace Aside metadata', () => {
  it('releases the complete Workspace, Node and page scope independently', () => {
    const service = createWorkbenchAsideService();
    const a = { nodeId: 'node-a', workspaceId: 'a' };
    const b = { nodeId: 'node-a', workspaceId: 'b' };
    const c = { nodeId: 'node-b', workspaceId: 'c' };
    for (const target of [a, b, c]) {
      service.ensure(target, ['files']);
      service.openSession({ ...target, sessionId: 'session' });
      service.openHtml(target, 'index.html');
    }
    service.removeWorkspace(a);
    expect(service.current(a)).toEqual({ tools: [], sessions: [] });
    expect(service.current(b).htmlPath).toBe('index.html');
    service.removeNode('node-a');
    expect(service.current(b)).toEqual({ tools: [], sessions: [] });
    expect(service.current(c).sessions).toEqual(['session']);
    service.clear();
    expect(service.current(c)).toEqual({ tools: [], sessions: [] });
  });

  it('owns one browser target per workspace and clears it with its scope', () => {
    const service = createWorkbenchAsideService();
    const a = { nodeId: 'node', workspaceId: 'a' };
    const b = { nodeId: 'node', workspaceId: 'b' };
    service.ensure(a, ['files', 'terminal']);
    service.ensure(b, ['files']);
    service.openSession({ ...a, sessionId: 'session-a' });
    service.openHtml(a, 'first.html');
    service.openHtml(a, 'next.htm');
    service.openHtml(b, 'other.html');
    expect(service.current(a).htmlPath).toBe('next.htm');
    expect(asideViewMode(service.current(a).active)).toBe('content');
    service.toggleTerminal(a);
    service.toggleTerminal(a);
    expect(service.current(a).active).toEqual({ kind: 'browser' });
    const restored = createWorkbenchAsideService();
    restored.restore(a, service.snapshot(a), ['files']);
    expect(restored.current(a).htmlPath).toBe('next.htm');
    restored.restore(a, { sessions: [] }, ['files']);
    expect(restored.current(a).htmlPath).toBeUndefined();
    service.clearHtmlWorkspace(a);
    expect(service.current(a).htmlPath).toBeUndefined();
    expect(service.current(a).sessions).toEqual(['session-a']);
    expect(service.current(b).htmlPath).toBe('other.html');
    service.clearHtmlNode('node');
    expect(service.current(b).htmlPath).toBeUndefined();
    service.ensure(a, ['files']);
    service.openHtml(a, 'again.html');
    service.clearHtml();
    expect(service.current(a).htmlPath).toBeUndefined();
  });
  it('opens Browser as content only with file access and returns to the adjacent session on close', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['search', 'terminal']);
    expect(service.openHtml(workspace, 'index.html')).toBe(false);
    expect(service.current(workspace).htmlPath).toBeUndefined();
    service.ensure(workspace, ['files', 'search', 'terminal']);
    service.selectTool(workspace, 'search');
    service.openSession({ ...workspace, sessionId: 'one' });
    expect(service.openHtml(workspace, 'index.html')).toBe(true);
    expect(service.current(workspace)).toMatchObject({
      tools: ['files', 'search', 'terminal'],
      active: { kind: 'browser' },
      recentTool: 'search'
    });
    service.clearHtmlWorkspace(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'one' });
    expect(service.current(workspace).htmlPath).toBeUndefined();
    service.openHtml(workspace, 'again.html');
    service.closeSession({ ...workspace, sessionId: 'one' });
    expect(service.current(workspace).active).toEqual({ kind: 'browser' });
    service.clearHtmlWorkspace(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'search' });
  });
  it('closes background Browser without changing selection or reviving a stale Terminal return', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files', 'search', 'terminal']);
    service.selectTool(workspace, 'search');
    service.openHtml(workspace, 'index.html');
    service.toggleTerminal(workspace);
    expect(service.current(workspace).terminalReturn).toEqual({ kind: 'browser' });
    service.clearHtmlWorkspace(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'terminal' });
    expect(service.current(workspace).terminalReturn).toBeUndefined();
    service.toggleTerminal(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'search' });
    service.openHtml(workspace, 'again.html');
    service.openSession({ ...workspace, sessionId: 'one' });
    service.clearHtmlWorkspace(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'one' });
    service.openHtml(workspace, 'last.html');
    service.openSession({ ...workspace, sessionId: 'two' });
    service.closeSession({ ...workspace, sessionId: 'two' });
    expect(service.current(workspace).active).toEqual({ kind: 'browser' });
  });
  it('replaces the sole session tab without removing tools or retaining a stale Terminal return', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files', 'search', 'terminal']);
    service.selectTool(workspace, 'search');
    service.openSession({ ...workspace, sessionId: 'a' });
    service.toggleTerminal(workspace);
    service.openSession({ ...workspace, sessionId: 'b' });
    service.openSession({ ...workspace, sessionId: 'b' });
    expect(service.current(workspace)).toMatchObject({
      tools: ['files', 'search', 'terminal'],
      sessions: ['b'],
      active: { kind: 'session', sessionId: 'b' },
      terminalReturn: undefined
    });
    expect(service.activateSession({ ...workspace, sessionId: 'a' })).toBe(false);
    service.toggleTerminal(workspace);
    service.toggleTerminal(workspace);
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'b' });
    service.closeSession({ ...workspace, sessionId: 'a' });
    expect(service.current(workspace).sessions).toEqual(['b']);
    service.closeSession({ ...workspace, sessionId: 'b' });
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'search' });
  });

  it.each([
    { active: { kind: 'session' as const, sessionId: 'a' }, sessionId: 'a' },
    {
      active: { kind: 'tool' as const, id: 'terminal' as const },
      terminalReturn: { kind: 'session' as const, sessionId: 'b' },
      sessionId: 'b'
    },
    { active: { kind: 'tool' as const, id: 'files' as const }, sessionId: 'c' }
  ])('limits restored metadata while preserving the current target: $sessionId', (saved) => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.restore(workspace, { ...saved, sessions: ['a', 'b', 'c', 'a'] }, ['files', 'terminal']);
    expect(service.current(workspace).sessions).toEqual([saved.sessionId]);
    expect(service.current(workspace).active).toEqual(saved.active);
    expect(service.snapshot(workspace).sessions).toEqual([saved.sessionId]);
  });

  it('can raise the capacity without changing the tab model or selection operations', () => {
    const service = createWorkbenchAsideService(2);
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files']);
    for (const sessionId of ['a', 'b', 'c']) service.openSession({ ...workspace, sessionId });
    expect(service.current(workspace).sessions).toEqual(['b', 'c']);
    service.activateSession({ ...workspace, sessionId: 'b' });
    expect(service.current(workspace).sessions).toEqual(['b', 'c']);
    service.closeSession({ ...workspace, sessionId: 'b' });
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'c' });
  });

  it('keeps a valid Terminal return when the restored active session is no longer present', () => {
    const service = createWorkbenchAsideService();
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.restore(
      workspace,
      {
        sessions: ['a', 'b', 'c'],
        active: { kind: 'session', sessionId: 'missing' },
        terminalReturn: { kind: 'session', sessionId: 'b' }
      },
      ['files', 'terminal']
    );
    expect(service.current(workspace).sessions).toEqual(['b']);
    expect(service.current(workspace).active).toEqual({ kind: 'tool', id: 'files' });
    expect(service.current(workspace).terminalReturn).toEqual({ kind: 'session', sessionId: 'b' });
    expect(service.activateSession({ ...workspace, sessionId: 'b' })).toBe(true);
  });

  it('keeps independent session tabs and chooses neighboring sessions before the latest tool', () => {
    const service = createWorkbenchAsideService(3);
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
    const service = createWorkbenchAsideService(3);
    const workspace = { nodeId: 'node', workspaceId: 'workspace' };
    service.ensure(workspace, ['files']);
    for (const sessionId of ['a', 'b', 'c']) service.openSession({ ...workspace, sessionId });
    service.activateSession({ ...workspace, sessionId: 'b' });
    service.removeMissing(workspace, ['b', 'unrelated']);
    expect(service.current(workspace).sessions).toEqual(['a', 'c']);
    expect(service.current(workspace).active).toEqual({ kind: 'session', sessionId: 'a' });
  });
});
