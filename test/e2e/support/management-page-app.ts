import { defineAsyncComponent, h, nextTick } from 'vue';
import { createTooltipApp } from '../../../packages/web-core/test/e2e/tooltip-app.js';
import {
  i18n,
  localePreferenceService
} from '../../../packages/web-core/src/service/locale-preference-service.js';
import '../../../packages/web-core/src/styles.css';

const AuditManagementPage = defineAsyncComponent(
  () => import('../../../ee/web/src/view/settings/AuditManagementPage.vue')
);
const OAuthManagementPage = defineAsyncComponent(
  () => import('../../../ee/web/src/view/settings/OAuthManagementPage.vue')
);
const OrganizationManagementPage = defineAsyncComponent(
  () => import('../../../ee/web/src/view/settings/OrganizationManagementPage.vue')
);
const ResourceManagementPanel = defineAsyncComponent(
  () => import('../../../packages/web-core/src/view/settings/ResourceManagementPanel.vue')
);
const UsageStatisticsSettings = defineAsyncComponent(
  () => import('../../../packages/web-core/src/view/settings/UsageStatisticsSettings.vue')
);

const area = new URLSearchParams(location.search).get('area');
const audit = area === 'audit';
const usage = area === 'usage';
const tall = new URLSearchParams(location.search).has('tall');
const many = new URLSearchParams(location.search).has('many');
const pending: {
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}[] = [];
const nodes = Array.from({ length: many ? 85 : 45 }, (_, index) => ({
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
        const start = (page - 1) * 20;
        const events = Array.from({ length: Math.max(0, Math.min(20, total - start)) }, (_, i) => ({
          id: `event-${start + i}`,
          occurredAt: Date.now(),
          eventType: 'USER_LOGIN',
          actorUsername: 'Fixture user',
          result: 'SUCCESS'
        }));
        entry.resolve({ events, page, pageSize: 20, total, hasMore: page * 20 < total });
      } else if (usage) {
        const totals = {
          inputTokens: '10',
          outputTokens: '14',
          totalTokens: '24',
          cacheReadTokens: null,
          cacheWriteTokens: null,
          requests: '3',
          completeRequests: '3',
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
            runners: [{ ...totals, key: 'mar-agent', label: 'MAR Agent' }],
            models: [
              {
                ...totals,
                key: 'fixture-model',
                label: 'Fixture model',
                inputTokens: '8',
                outputTokens: '10',
                totalTokens: '18',
                requests: '2',
                completeRequests: '2'
              },
              {
                ...totals,
                key: 'fixture-model-2',
                label: 'Second model',
                inputTokens: '2',
                outputTokens: '4',
                totalTokens: '6',
                requests: '1',
                completeRequests: '1'
              }
            ],
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
      } else if (area === 'oauth') {
        entry.resolve({ providers: [] });
      } else if (area === 'organization') {
        entry.resolve({ organizations: [] });
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
    path.startsWith('/api/me/usage/') ||
    path === '/api/oauth-providers' ||
    path === '/api/organizations'
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
    h(
      'div',
      {
        class: 'fixture-scroller',
        style: `display:flex;height:${tall ? 3000 : 560}px;overflow:auto`
      },
      [renderPage()]
    )
})
  .use(i18n)
  .mount('#app');

function renderPage() {
  switch (area) {
    case 'audit':
      return h(AuditManagementPage, { request });
    case 'usage':
      return h(UsageStatisticsSettings, { request });
    case 'oauth':
      return h(OAuthManagementPage, { request, writable: false });
    case 'organization':
      return h(OrganizationManagementPage, { request, writable: false });
    default:
      return h(ResourceManagementPanel, { request, resourceType: 'NODE', writable: false });
  }
}
