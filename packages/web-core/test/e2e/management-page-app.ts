import { h, nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import ResourceManagementPanel from '../../src/view/settings/ResourceManagementPanel.vue';
import AuditManagementPage from '../../../../ee/web/src/view/settings/AuditManagementPage.vue';
import UsageStatisticsSettings from '../../src/view/settings/UsageStatisticsSettings.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

const audit = new URLSearchParams(location.search).get('area') === 'audit';
const usage = new URLSearchParams(location.search).get('area') === 'usage';
const tall = new URLSearchParams(location.search).has('tall');
const pending: {
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}[] = [];
const nodes = Array.from({ length: 45 }, (_, index) => ({
  id: `node-${index}`,
  displayName: `Node ${index}`,
  connected: true,
  disabled: false,
  ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
}));

declare global {
  interface Window {
    managementPageFixture: {
      calls(): string[];
      settle(index: number, success: boolean): Promise<void>;
    };
  }
}

window.managementPageFixture = {
  calls: () => pending.map((entry) => entry.path),
  async settle(index, success) {
    const entry = pending[index];
    if (!entry) throw new Error(`No request ${index}`);
    if (!success) entry.reject(new Error('List request failed'));
    else {
      const url = new URL(entry.path, location.origin);
      const page = Number(url.searchParams.get('page') ?? '1');
      if (audit) {
        const total = new URLSearchParams(location.search).has('pages') ? 45 : 0;
        entry.resolve({ events: [], page, pageSize: 20, total, hasMore: page * 20 < total });
      } else if (usage) {
        const totals = {
          inputTokens: '10',
          outputTokens: '14',
          totalTokens: '24',
          cacheReadTokens: null,
          cacheWriteTokens: null,
          requests: '1',
          completeRequests: '1',
          partialRequests: '0',
          unknownRequests: '0'
        };
        const now = Date.now();
        if (url.pathname.endsWith('/overview'))
          entry.resolve({
            asOf: now,
            availableFrom: now - 86400000,
            firstRecordedAt: now - 1000,
            lastReceivedAt: now,
            last24Hours: totals,
            last7Days: totals,
            selected: totals,
            buckets: [],
            runners: [],
            models: [],
            coverage: 'observed-only'
          });
        else
          entry.resolve({
            records: Array.from({ length: 20 }, (_, i) => ({
              schemaVersion: 1,
              recordId: `page-${page}-${i}`,
              requestId: `page-${page}-${i}`,
              revision: 1,
              scopeId: '00000000-0000-4000-8000-000000000001',
              sessionId: 'session',
              runId: 'run',
              runner: 'mar-agent',
              purpose: 'conversation',
              agentRole: 'root',
              state: 'succeeded',
              coverage: 'request',
              startedAt: now - 1000,
              endedAt: now,
              inputTokens: '10',
              outputTokens: '14',
              totalTokens: '24',
              mode: 'conversation'
            })),
            total: '40',
            page,
            nextCursor: null
          });
      } else {
        const keyword = url.searchParams.get('keyword') ?? '';
        const filtered = nodes.filter((node) => node.displayName.includes(keyword));
        entry.resolve({
          nodes: filtered.slice((page - 1) * 20, page * 20),
          workspaces: [],
          page,
          pageSize: 20,
          total: filtered.length,
          hasMore: page * 20 < filtered.length
        });
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};

async function request<T>(path: string): Promise<T> {
  if (
    path.startsWith('/api/resources?') ||
    path.startsWith('/api/audit-events?') ||
    path.startsWith('/api/me/usage/')
  )
    return new Promise<T>((resolve, reject) =>
      pending.push({ path, resolve: (value) => resolve(value as T), reject })
    );
  if (path === '/api/nodes') return { nodes } as T;
  throw new Error(`Unexpected fixture request: ${path}`);
}

localePreferenceService().setLocale('en-US');
createTooltipApp({
  render: () =>
    h('div', { class: 'fixture-scroller', style: `height:${tall ? 3000 : 560}px;overflow:auto` }, [
      audit
        ? h(AuditManagementPage, { request })
        : usage
          ? h(UsageStatisticsSettings, { request })
          : h(ResourceManagementPanel, { request, resourceType: 'NODE', writable: false })
    ])
})
  .use(ElementPlus)
  .use(i18n)
  .mount('#app');
