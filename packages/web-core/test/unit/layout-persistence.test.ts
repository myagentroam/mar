import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchLayoutService } from '../../src/service/WorkbenchLayoutService.js';
import type { WorkspaceTab } from '../../src/model/workbench.js';

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    })
  };
}

function fixture() {
  const session = storage();
  const local = storage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  const options = {
    sidebarCollapsed: ref(true),
    expandedNodeIds: ref<readonly string[]>(['node']),
    nodeOrder: ref<readonly string[]>(['node']),
    workspaceOrderByNode: ref({ node: ['w'] }),
    workspaceTabs: ref<readonly WorkspaceTab[]>([
      {
        id: 'node:w',
        nodeId: 'node',
        workspaceId: 'w',
        label: 'W',
        lastActiveAt: 2,
        selectedSessionId: 'native'
      }
    ]),
    maxWorkspaceTabs: 1,
    restoreTree: vi.fn(),
    restoreTabs: vi.fn()
  };
  return { service: createWorkbenchLayoutService(options), options, session, local };
}

describe('Public Workbench Layout Persistence', () => {
  it('persists independent bounded panel widths locally and restores them without tabs', () => {
    const f = fixture();
    expect(f.service.panelWidths.value).toEqual({});
    f.service.setPanelWidth('sidebar', 330.4);
    f.service.setPanelWidth('inspector', 510);
    expect(JSON.parse(f.local.getItem('mar.workbench.panel-widths.v1')!)).toEqual({
      sidebar: 330,
      inspector: 510
    });
    f.service.setPanelWidth('sidebar', -10);
    f.service.setPanelWidth('inspector', 10000);
    f.service.restore();
    expect(f.service.panelWidths.value).toEqual({ sidebar: 220, inspector: 600 });
    expect(f.session.getItem('mar.workbench.panel-widths.v1')).toBeNull();
  });

  it('sanitizes width preferences and falls back independently on corrupt or blocked storage', () => {
    const f = fixture();
    for (const value of ['{', 'null', '[]', '{"sidebar":"330","inspector":null}']) {
      f.local.setItem('mar.workbench.panel-widths.v1', value);
      f.service.restore();
      expect(f.service.panelWidths.value).toEqual({});
    }
    f.local.setItem('mar.workbench.panel-widths.v1', '{"sidebar":900,"inspector":-1}');
    f.service.restore();
    expect(f.service.panelWidths.value).toEqual({ sidebar: 420, inspector: 275 });
    f.local.setItem.mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => f.service.setPanelWidth('sidebar', 300)).not.toThrow();
    f.service.setPanelWidth('sidebar', NaN);
    f.service.setPanelWidth('inspector', Infinity);
    expect(f.service.panelWidths.value).toEqual({ sidebar: 300, inspector: 275 });
    f.local.getItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => f.service.restore()).not.toThrow();
    expect(f.service.panelWidths.value).toEqual({});
  });

  it('restores pins beyond the normal quota and rejects malformed pin flags', () => {
    const f = fixture();
    const first = f.options.workspaceTabs.value[0]!;
    const pin = { ...first, id: 'pinned', pinned: true };
    f.local.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify([
        first,
        { ...first, id: 'extra' },
        pin,
        { ...first, id: 'bad-pin', pinned: 'true' }
      ])
    );
    f.service.restore();
    expect(f.options.restoreTabs).toHaveBeenCalledWith([pin, first]);
    f.options.workspaceTabs.value = [pin, first];
    f.service.persist();
    expect(JSON.parse(f.local.getItem('mar.workbench.tabs.v1')!)).toEqual([pin, first]);
  });

  it('Writes layout to sessionStorage and tab and native-session selection to localStorage', () => {
    const f = fixture();
    f.service.persist();
    expect(JSON.parse(f.session.getItem('mar.workbench.layout.v1')!)).toEqual({
      sidebarCollapsed: true,
      expandedNodeIds: ['node'],
      nodeOrder: ['node'],
      workspaceOrderByNode: { node: ['w'] }
    });
    expect(JSON.parse(f.local.getItem('mar.workbench.tabs.v1')!)).toEqual(
      f.options.workspaceTabs.value
    );
    expect(f.session.getItem('mar.workbench.tabs.v1')).toBeNull();
    expect(f.local.getItem('mar.workbench.layout.v1')).toBeNull();
  });

  it('Ignores corrupted layout data without affecting valid tab order, selection restoration, or the tab limit', () => {
    const f = fixture();
    f.session.setItem('mar.workbench.layout.v1', '{');
    const first = f.options.workspaceTabs.value[0]!;
    f.local.setItem(
      'mar.workbench.tabs.v1',
      JSON.stringify([{}, first, { ...first, id: 'second' }])
    );
    f.service.restore();
    expect(f.options.restoreTree).toHaveBeenCalledWith([], {}, []);
    expect(f.options.restoreTabs).toHaveBeenCalledWith([first]);
  });

  it('Supports legacy sidebar fields and filters out non-string Node IDs', () => {
    const f = fixture();
    f.session.setItem(
      'mar.workbench.layout.v1',
      JSON.stringify({
        explorerCollapsed: true,
        expandedNodeIds: ['node', null, 42]
      })
    );
    f.options.sidebarCollapsed.value = false;
    f.service.restore();
    expect(f.options.sidebarCollapsed.value).toBe(true);
    expect(f.options.restoreTree).toHaveBeenCalledWith(['node'], {}, []);
  });

  it('Restores Node order from session layout and rejects malformed positions', () => {
    const f = fixture();
    f.session.setItem('mar.workbench.layout.v1', JSON.stringify({ nodeOrder: ['b', null, 'a'] }));
    f.service.restore();
    expect(f.options.restoreTree).toHaveBeenLastCalledWith([], {}, ['b', 'a']);
    f.session.setItem('mar.workbench.layout.v1', JSON.stringify({ nodeOrder: {} }));
    f.service.restore();
    expect(f.options.restoreTree).toHaveBeenLastCalledWith([], {}, []);
  });

  it('Continues persisting to the other storage when one is disabled and safely clears failed reads', () => {
    const f = fixture();
    f.session.setItem.mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(() => f.service.persist()).not.toThrow();
    expect(f.local.setItem).toHaveBeenCalledOnce();
    f.local.getItem.mockImplementation(() => {
      throw new Error('disabled');
    });
    f.service.restore();
    expect(f.options.restoreTabs).toHaveBeenCalledWith([]);
  });
});
