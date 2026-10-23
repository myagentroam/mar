import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessage, ElMessageBox } from 'element-plus';
import NodePage from '../../src/view/settings/NodeManagementPage.vue?unit-render';
import WorkspacePage from '../../src/view/settings/WorkspaceManagementPage.vue?unit-render';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

const messages = commonMessages['en-US'].generated.resourceSharingPage;
const common = commonMessages['en-US'].common;
const previousLocale = i18n.global.locale.value;
beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://fixture/console' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
  vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  i18n.global.locale.value = previousLocale;
});

describe('Public resource operation behavior', () => {
  it.each(['NODE', 'WORKSPACE'] as const)(
    'validates %s edits, reloads the authoritative name, and confirms removal without deleting host files',
    async (resourceType) => {
      let displayName = 'Before edit';
      let removed = false;
      const endpoint =
        resourceType === 'NODE'
          ? '/api/nodes/node%20one'
          : '/api/workspaces/work%2Fone?nodeId=node%20one';
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === endpoint) {
          if (init?.method === 'PATCH') displayName = 'Server canonical name';
          if (init?.method === 'DELETE') removed = true;
          return {};
        }
        if (path.startsWith('/api/resources?'))
          return {
            nodes:
              resourceType === 'NODE' && !removed
                ? [
                    {
                      id: 'node one',
                      displayName,
                      ownership: { ownerType: 'PERSONAL', ownerUserId: 37 }
                    }
                  ]
                : [],
            workspaces:
              resourceType === 'WORKSPACE' && !removed
                ? [
                    {
                      nodeId: 'node one',
                      workspaceId: 'work/one',
                      displayName,
                      ownership: { ownerType: 'PERSONAL', ownerUserId: 37 }
                    }
                  ]
                : [],
            page: 1,
            pageSize: 20,
            total: removed ? 0 : 1,
            hasMore: false
          };
        throw new Error(`Unexpected fixture request: ${path}`);
      });
      const confirmation = vi
        .spyOn(ElMessageBox, 'confirm')
        .mockRejectedValueOnce('cancel')
        .mockResolvedValue('confirm' as never);
      const validate = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const changed = vi.fn();
      const view = renderComponent(
        resourceType === 'NODE' ? NodePage : WorkspacePage,
        { request, writable: true, onChanged: changed },
        {},
        { validate }
      );
      const button = (label: string) =>
        view.findAll('ElButton').find((node) => textContent(node).trim() === label)!;
      try {
        await flushComponent();
        await trigger(button(messages.edit), 'onClick');
        const name = view
          .findAll('ElInput')
          .find((node) => node.props['maxlength'] === (resourceType === 'NODE' ? 128 : 255))!;
        await trigger(name, 'onUpdate:modelValue', '  New client name  ');
        await trigger(button(common.save), 'onClick');
        expect(request.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
        await trigger(button(common.save), 'onClick');
        expect(request).toHaveBeenCalledWith(endpoint, {
          method: 'PATCH',
          body: JSON.stringify({ displayName: 'New client name' })
        });
        expect(textContent(view.root)).toContain('Server canonical name');
        expect(changed).toHaveBeenCalledOnce();
        await trigger(button(common.delete), 'onClick');
        expect(request.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
        await trigger(button(common.delete), 'onClick');
        expect(confirmation).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenCalledWith(endpoint, { method: 'DELETE' });
        expect(view.findAll('ElTable')[0]?.props['data']).toEqual([]);
        expect(changed).toHaveBeenCalledTimes(2);
      } finally {
        view.unmount();
      }
    }
  );

  it('refreshes live Node details, preserves failed refresh state, and drives confirmed upgrade/cancellation', async () => {
    let version = '0.10.2';
    let waiting = false;
    let failRefresh = false;
    const node = () => ({
      id: 'node-1',
      displayName: 'Live fixture Node',
      connected: true,
      disabled: false,
      manageable: true,
      nodeAppVersion: version,
      ownership: { ownerType: 'PERSONAL', ownerUserId: 37 },
      metadata: {
        upgrade: { state: waiting ? 'WAITING_FOR_RUNS' : 'IDLE', activeRunCount: waiting ? 2 : 0 }
      },
      upgradeAvailability: { state: 'AVAILABLE', targetVersion: '0.10.40' }
    });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/resources?'))
        return { nodes: [node()], workspaces: [], page: 1, pageSize: 20, total: 1, hasMore: false };
      if (path === '/api/nodes') {
        if (failRefresh) throw new Error('Fixture capability refresh unavailable');
        return { nodes: [node()] };
      }
      if (path.startsWith('/api/runner-usage/status')) return { statuses: [] };
      if (path.startsWith('/api/environment-secrets?')) return { secrets: [] };
      if (path === '/api/nodes/node-1/upgrade' && init?.method === 'POST') {
        waiting = true;
        return {};
      }
      if (path === '/api/nodes/node-1/upgrade/cancel' && init?.method === 'POST') {
        waiting = false;
        return {};
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const confirmation = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValue('confirm' as never);
    const view = renderComponent(NodePage, { request, writable: true });
    const button = (label: string) =>
      view.findAll('ElButton').find((node) => textContent(node).trim() === label)!;
    const refreshLabel = commonMessages['en-US'].generated.nodeDetailsDialogs.refreshCapabilities;
    try {
      await flushComponent();
      const table = view.findAll('ElTable')[0]!;
      const row = (table.props['data'] as object[])[0];
      await trigger(table, 'onRowClick', row);
      expect(request).toHaveBeenCalledWith('/api/nodes');
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('0.10.2');
      failRefresh = true;
      await trigger(button(refreshLabel), 'onClick');
      expect(ElMessage.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Fixture capability refresh unavailable' })
      );
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('0.10.2');
      failRefresh = false;
      version = '0.10.40';
      await trigger(button(refreshLabel), 'onClick');
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('0.10.40');
      expect(button(messages.pushUpgrade2).props['icon']).toBeTruthy();
      expect(button(messages.pushUpgrade2).props['type']).not.toBe('primary');
      await trigger(button(messages.pushUpgrade2), 'onClick');
      expect(request.mock.calls.some(([path]) => path.endsWith('/upgrade'))).toBe(false);
      await trigger(button(messages.pushUpgrade2), 'onClick');
      expect(confirmation).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledWith('/api/nodes/node-1/upgrade', { method: 'POST' });
      expect(button(messages.cancelUpgrade)).toBeDefined();
      expect(button(messages.cancelUpgrade).props['icon']).toBeTruthy();
      expect(button(messages.cancelUpgrade).props['type']).not.toBe('primary');
      await trigger(button(messages.cancelUpgrade), 'onClick');
      expect(request).toHaveBeenCalledWith('/api/nodes/node-1/upgrade/cancel', { method: 'POST' });
      expect(button(messages.cancelUpgrade)).toBeUndefined();
    } finally {
      view.unmount();
    }
  });
});
