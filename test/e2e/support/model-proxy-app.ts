import { h } from 'vue';
import { createTooltipApp } from '../../../packages/web-core/test/e2e/tooltip-app.js';
import {
  i18n,
  localePreferenceService
} from '../../../packages/web-core/src/service/locale-preference-service.js';
import Page from '../../../packages/web-core/src/view/settings/MarAgentModelManagementPage.vue';
import type { NodeSummary } from '../../../packages/web-core/src/model/node.js';
import '../../../packages/web-core/src/styles.css';

const parameters = new URLSearchParams(location.search);
const testNode = parameters.get('test-node');
const nodeNames = testNode === 'socks5' ? ['Fixture Node', 'Backup Node'] : ['Fixture Node'];
const nodes: NodeSummary[] = testNode
  ? nodeNames.map((displayName, index) => ({
      id: `fixture-node-${index}`,
      displayName,
      registeredAddress: '127.0.0.1',
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: 'fixture',
      nodeVersion: 'fixture',
      connected: true,
      disabled: false,
      capabilities: {
        marAgentRuntimeCredentials: {
          apiVersion: 1,
          websocket: true,
          httpVersions: ['1.1', '2'],
          modelSocks5Proxy: testNode === 'socks5'
        }
      }
    }))
  : [];
localePreferenceService().setLocale(parameters.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
document.documentElement.classList.toggle('dark', parameters.get('theme') === 'dark');
if (parameters.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error('Fixture request failed');
  return response.json() as Promise<T>;
}
createTooltipApp({
  render: () =>
    h(
      'main',
      { style: 'padding:16px' },
      h(Page, { request, canManageModels: true, writable: true, nodes })
    )
})
  .use(i18n)
  .mount('#app');
