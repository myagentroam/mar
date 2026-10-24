import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import { createEnterpriseManagementComposition } from '../../../../ee/web/src/composition/enterprise-management.js';
import type { ManagementPageContext } from '../../src/service/management-composition.js';
import { i18n } from '../../../../ee/web/src/service/locale-preference-service.js';

i18n.global.locale.value =
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? 'Fixture request failed');
  return body as T;
}

const context: ManagementPageContext = {
  admin: {
    authenticated: true,
    mustChangePassword: false,
    edition: 'ENTERPRISE',
    role: 'ADMIN',
    isAdmin: true,
    managementWritable: true
  },
  request,
  nodes: [],
  onlineNodeCount: 0,
  serverVersion: undefined
};
const composition = createEnterpriseManagementComposition();
if (!composition.items(context.admin).some((item) => item.id === 'users'))
  throw new Error('Users menu is unavailable');
const page = composition.resolve('users', context.admin);
if (page.id !== 'users') throw new Error('Users menu resolved to a different page');
const app = createApp(page.component, { ...page.props(context) });
app.use(ElementPlus);
app.use(i18n);
app.mount('#app');
