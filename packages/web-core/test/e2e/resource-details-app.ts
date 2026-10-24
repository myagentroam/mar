import { h, nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import Panel from '../../src/view/settings/ResourceManagementPanel.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

// This standalone page mounts only the real resource component. Requests are
// controlled dependencies, not a Workbench, Server or authorization fixture.
localePreferenceService().setLocale('en-US');
const resourceType =
  new URLSearchParams(location.search).get('kind') === 'NODE' ? 'NODE' : 'WORKSPACE';
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
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
export interface ResourceDetailsFixture {
  pending(): string[];
  settle(path: string, value: unknown, fail?: boolean): Promise<void>;
}
declare global {
  interface Window {
    resourceDetailsFixture: ResourceDetailsFixture;
  }
}
window.resourceDetailsFixture = {
  pending: () => [...pending.keys()],
  async settle(path, value, fail = false) {
    const gate = pending.get(path);
    if (!gate) throw new Error(`No pending resource request: ${path}`);
    pending.delete(path);
    if (fail) gate.reject(new Error(String(value)));
    else gate.resolve(value);
    // Drain request continuations and their Vue render jobs before asserting
    // that a stale response has not changed or reopened a dialog.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};
async function request<T>(path: string): Promise<T> {
  if (path.startsWith('/api/resources?'))
    return {
      nodes: resourceType === 'NODE' ? nodes : [],
      workspaces: resourceType === 'WORKSPACE' ? workspaces : [],
      page: 1,
      pageSize: 20,
      total: 2,
      hasMore: false
    } as T;
  if (path === '/api/nodes') return { nodes } as T;
  if (path.startsWith('/api/environment-secrets?')) return { secrets: [] } as T;
  if (
    path.startsWith('/api/workspaces?') ||
    path.startsWith('/api/runner-usage/status?') ||
    path.startsWith('/api/runner-usage?')
  )
    return new Promise<T>((resolve, reject) => {
      if (pending.has(path)) throw new Error(`Duplicate pending resource request: ${path}`);
      pending.set(path, { resolve: (value) => resolve(value as T), reject });
    });
  throw new Error(`Unexpected resource fixture request: ${path}`);
}
createTooltipApp({ render: () => h(Panel, { request, resourceType, writable: false }) })
  .use(ElementPlus)
  .use(i18n)
  .mount('#app');
