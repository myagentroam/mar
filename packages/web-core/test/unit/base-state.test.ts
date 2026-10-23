import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../src/model/workbench.js';
import { createWorkbenchBaseStateService } from '../../src/service/WorkbenchBaseStateService.js';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
});
afterEach(() => vi.unstubAllGlobals());
const options = () => ({ sessionPageSize: 10, onUnauthenticated: vi.fn() });

describe('shared Workbench state composition', () => {
  it('creates isolated ordinary state without product navigation or enterprise targets', () => {
    const a = createWorkbenchBaseStateService(options());
    const b = createWorkbenchBaseStateService(options());
    expect(a).not.toHaveProperty('hostedSelection');
    expect(a).not.toHaveProperty('navigation');
    expect(a).not.toHaveProperty('notifications');
    expect(a.admin.admin.value.authenticated).toBe(false);
    a.selection.workspaceTarget.value = { nodeId: 'node-1', workspaceId: 'workspace-1' };
    a.surface.quickOpenFileVisible.value = true;
    a.paging.initialize('node-1:workspace-1');
    expect(a.paging.visibleLimits.value.get('node-1:workspace-1')).toBe(10);
    expect(b.selection.workspaceTarget.value).toBeUndefined();
    expect(b.surface.quickOpenFileVisible.value).toBe(false);
    expect(b.paging.visibleLimits.value.size).toBe(0);
    expect(a.surface.terminalDocks).not.toBe(b.surface.terminalDocks);
  });

  it('keeps extensible Workspace typing and connects drafts to the same selection refs', () => {
    interface Resource extends Workspace {
      readonly label: string;
    }
    const state = createWorkbenchBaseStateService<Resource>(options());
    state.selection.workspaces.value = [
      { id: 'w1', path: '/w1', kind: 'DIRECTORY', label: 'custom' }
    ];
    expect(state.selection.workspaces.value[0]?.label).toBe('custom');
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w1' };
    state.draft.input.value = 'first draft';
    state.draft.persist();
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w2' };
    state.draft.restore();
    expect(state.draft.input.value).toBe('');
    state.selection.workspaceTarget.value = { nodeId: 'n1', workspaceId: 'w1' };
    state.draft.restore();
    expect(state.draft.input.value).toBe('first draft');
  });

  it('shares the auth CSRF ref with HTTP and routes unauthenticated failure to its owner', async () => {
    const configuration = options();
    const state = createWorkbenchBaseStateService(configuration);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication is required.'
            }
          }),
          { status: 401 }
        )
    );
    vi.stubGlobal('fetch', fetch);
    state.admin.csrfToken.value = 'csrf-1';
    await expect(state.http.request('/api/example', { method: 'POST' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED'
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/example',
      expect.objectContaining({
        headers: { 'x-csrf-token': 'csrf-1' },
        credentials: 'same-origin'
      })
    );
    expect(configuration.onUnauthenticated).toHaveBeenCalledOnce();
  });
});
