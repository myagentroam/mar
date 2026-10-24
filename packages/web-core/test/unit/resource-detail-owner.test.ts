import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NodePage from '../../src/view/settings/NodeManagementPage.vue?unit-render';
import WorkspacePage from '../../src/view/settings/WorkspaceManagementPage.vue?unit-render';
import { i18n } from '../../src/service/locale-preference-service.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const nodes = ['a', 'b'].map((id) => ({
  id,
  displayName: `Node ${id}`,
  connected: true,
  capabilities: { codex: { available: true } },
  ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
}));
const workspaces = nodes.map((node) => ({
  nodeId: node.id,
  workspaceId: `work-${node.id}`,
  displayName: `Workspace ${node.id}`,
  ownership: node.ownership
}));
const originalLocale = i18n.global.locale.value;
beforeEach(() => {
  vi.mocked(showMessage).mockClear();
  i18n.global.locale.value = 'en-US';
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://fixture/console' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = originalLocale;
});

function fixture(kind: 'NODE' | 'WORKSPACE') {
  const paths = [deferred<unknown>(), deferred<unknown>()];
  const statuses = [deferred<unknown>(), deferred<unknown>()];
  const usages = [deferred<unknown>(), deferred<unknown>()];
  const refreshes: ReturnType<typeof deferred<unknown>>[] = [];
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/api/resources?'))
      return {
        nodes: kind === 'NODE' ? nodes : [],
        workspaces: kind === 'WORKSPACE' ? workspaces : [],
        page: 1,
        pageSize: 20,
        total: 2,
        hasMore: false
      };
    if (path === '/api/nodes') return refreshes.shift()?.promise ?? { nodes };
    if (path.startsWith('/api/workspaces?')) return paths[path.endsWith('=a') ? 0 : 1]!.promise;
    if (path.startsWith('/api/runner-usage/status?'))
      return statuses[path.endsWith('=a') ? 0 : 1]!.promise;
    if (path.startsWith('/api/runner-usage?'))
      return usages[path.includes('nodeId=a&') ? 0 : 1]!.promise;
    if (path.startsWith('/api/environment-secrets?')) return { secrets: [] };
    if (path.includes('/git-policy?')) return {};
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const view = renderComponent(kind === 'NODE' ? NodePage : WorkspacePage, {
    request,
    writable: false
  });
  const table = () => view.findAll('ElTable')[0]!;
  async function open(id: string) {
    const row = (table().props['data'] as { nodeId: string; resourceType: string }[]).find(
      (row) => row.nodeId === id && row.resourceType === kind
    );
    void trigger(table(), 'onRowClick', row);
    await flushComponent();
  }
  const dialog = () => view.findAll('ElDialog')[0]!;
  const usageButton = () =>
    view
      .findAll('ElButton')
      .find((node) => node.props['class'] === 'runner-usage-link utility-control')!;
  return { ...view, request, paths, statuses, usages, refreshes, open, dialog, usageButton };
}

describe('Resource detail request ownership', () => {
  it.each(['success', 'failure'] as const)(
    'does not reopen a closed Workspace after a late path %s',
    async (outcome) => {
      const view = fixture('WORKSPACE');
      try {
        await flushComponent();
        await view.open('a');
        await trigger(view.dialog(), 'onUpdate:modelValue', false);
        if (outcome === 'success')
          view.paths[0]!.resolve({ workspaces: [{ id: 'work-a', path: '/late/a' }] });
        else view.paths[0]!.reject(new Error('Old path failure'));
        await flushComponent();
        expect(view.findAll('ElDialog')).toHaveLength(0);
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'keeps the current Workspace path after an old path %s',
    async (outcome) => {
      const view = fixture('WORKSPACE');
      try {
        await flushComponent();
        await view.open('a');
        await view.open('b');
        view.paths[1]!.resolve({ workspaces: [{ id: 'work-b', path: '/current/b' }] });
        await flushComponent();
        expect(textContent(view.dialog())).toContain('/current/b');
        if (outcome === 'success')
          view.paths[0]!.resolve({ workspaces: [{ id: 'work-a', path: '/late/a' }] });
        else view.paths[0]!.reject(new Error('Old path failure'));
        await flushComponent();
        expect(textContent(view.dialog())).toContain('/current/b');
        expect(textContent(view.dialog())).not.toContain('/late/a');
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'keeps current Node usage availability after an old status %s',
    async (outcome) => {
      const view = fixture('NODE');
      try {
        await flushComponent();
        await view.open('a');
        await view.open('b');
        view.statuses[1]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
        await flushComponent();
        expect(view.usageButton().props['disabled']).toBe(false);
        if (outcome === 'success')
          view.statuses[0]!.resolve({ statuses: [{ runner: 'codex', available: false }] });
        else view.statuses[0]!.reject(new Error('Old usage failure'));
        await flushComponent();
        expect(textContent(view.dialog())).toContain('Node b');
        expect(view.usageButton().props['disabled']).toBe(false);
      } finally {
        view.unmount();
      }
    }
  );

  it('clears previous Node availability while the next target is loading and accepts current failure', async () => {
    const view = fixture('NODE');
    try {
      await flushComponent();
      await view.open('a');
      view.statuses[0]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
      await flushComponent();
      expect(view.usageButton().props['disabled']).toBe(false);
      await view.open('b');
      expect(view.usageButton().props['disabled']).toBe(true);
      view.statuses[1]!.reject(new Error('Current usage failure'));
      await flushComponent();
      expect(view.usageButton().props['disabled']).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it.each(['success', 'failure'] as const)(
    'ignores a closed Node status %s while the next target is still loading',
    async (outcome) => {
      const view = fixture('NODE');
      try {
        await flushComponent();
        await view.open('a');
        await trigger(view.dialog(), 'onUpdate:modelValue', false);
        await view.open('b');
        if (outcome === 'success')
          view.statuses[0]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
        else view.statuses[0]!.reject(new Error('Closed usage failure'));
        await flushComponent();
        expect(textContent(view.dialog())).toContain('Node b');
        expect(view.usageButton().props['disabled']).toBe(true);
        view.statuses[1]!.resolve({ statuses: [{ runner: 'codex', available: false }] });
        await flushComponent();
        expect(view.usageButton().props['disabled']).toBe(true);
      } finally {
        view.unmount();
      }
    }
  );

  it('keeps a current Workspace open when its path request fails', async () => {
    const view = fixture('WORKSPACE');
    try {
      await flushComponent();
      await view.open('a');
      view.paths[0]!.reject(new Error('Current path failure'));
      await flushComponent();
      expect(textContent(view.dialog())).toContain('Workspace a');
      expect(textContent(view.dialog())).not.toContain('/late/');
    } finally {
      view.unmount();
    }
  });

  it.each(['success', 'failure'] as const)(
    'invalidates a closed Node lifecycle before its main refresh %s finishes',
    async (outcome) => {
      const view = fixture('NODE');
      const old = deferred<unknown>();
      const current = deferred<unknown>();
      try {
        await flushComponent();
        view.refreshes.push(old, current);
        await view.open('a');
        await trigger(view.dialog(), 'onUpdate:modelValue', false);
        await view.open('a');
        if (outcome === 'success') old.resolve({ nodes });
        else old.reject(new Error('Old refresh failure'));
        await flushComponent();
        expect(view.request.mock.calls.some(([path]) => path.includes('runner-usage/status'))).toBe(
          false
        );
        expect(vi.mocked(showMessage)).not.toHaveBeenCalled();
        const refresh = () =>
          view.findAll('ElButton').find((node) => textContent(node) === 'Refresh capabilities')!;
        expect(refresh().props['loading']).toBe(true);
        current.resolve({ nodes });
        await flushComponent();
        expect(refresh().props['loading']).toBe(false);
        expect(view.request).toHaveBeenCalledWith('/api/runner-usage/status?nodeId=a');
      } finally {
        view.unmount();
      }
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores old usage detail %s without reopening or clearing the current loading state',
    async (outcome) => {
      const view = fixture('NODE');
      try {
        await flushComponent();
        await view.open('a');
        view.statuses[0]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
        await flushComponent();
        await trigger(view.usageButton(), 'onClick');
        await trigger(view.dialog(), 'onUpdate:modelValue', false);
        await view.open('b');
        view.statuses[1]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
        await flushComponent();
        await trigger(view.usageButton(), 'onClick');
        expect(view.usageButton().props['loading']).toBe(true);
        if (outcome === 'success')
          view.usages[0]!.resolve({ usage: { runner: 'codex', windows: [], fetchedAt: 1 } });
        else view.usages[0]!.reject(new Error('Old usage detail failure'));
        await flushComponent();
        expect(view.findAll('ElDialog')).toHaveLength(1);
        expect(view.usageButton().props['loading']).toBe(true);
        expect(vi.mocked(showMessage)).not.toHaveBeenCalled();
        view.usages[1]!.resolve({
          usage: {
            runner: 'codex',
            windows: [
              { id: 'current', label: 'Current window', usedPercentage: 37, resetsAt: null }
            ],
            fetchedAt: 2,
            cached: false
          }
        });
        await flushComponent();
        expect(view.findAll('ElDialog')).toHaveLength(2);
        expect(view.usageButton().props['loading']).toBe(false);
        expect(textContent(view.root)).toContain('37%');
      } finally {
        view.unmount();
      }
    }
  );

  it('retains the current Node and reports a current usage detail failure', async () => {
    const view = fixture('NODE');
    try {
      await flushComponent();
      await view.open('a');
      view.statuses[0]!.resolve({ statuses: [{ runner: 'codex', available: true }] });
      await flushComponent();
      await trigger(view.usageButton(), 'onClick');
      view.usages[0]!.reject(new Error('Current usage failure'));
      await flushComponent();
      expect(view.findAll('ElDialog')).toHaveLength(1);
      expect(view.usageButton().props['loading']).toBe(false);
      expect(vi.mocked(showMessage)).toHaveBeenCalledWith(
        'Current usage failure',
        'error',
        expect.any(Error)
      );
    } finally {
      view.unmount();
    }
  });

  it('does not continue Node reads after unmount', async () => {
    const view = fixture('NODE');
    const refresh = deferred<unknown>();
    await flushComponent();
    view.refreshes.push(refresh);
    await view.open('a');
    view.unmount();
    refresh.resolve({ nodes });
    await flushComponent();
    expect(view.request.mock.calls.some(([path]) => path.includes('runner-usage/status'))).toBe(
      false
    );
  });
});
