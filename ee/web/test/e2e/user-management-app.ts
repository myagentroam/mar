import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../../../packages/web-core/src/styles.css';
import { createEnterpriseManagementComposition } from '../../src/composition/enterprise-management.js';
import UserManagementPage from '../../src/view/settings/UserManagementPage.vue';
import type { ManagementPageContext } from '../../../../packages/web-core/src/service/management-composition.js';
import { i18n } from '../../src/service/locale-preference-service.js';

const params = new URLSearchParams(location.search);
i18n.global.locale.value = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? 'Fixture request failed');
  return body as T;
}

function createFixtureApp() {
  if (params.get('page') === 'personal') return createApp(UserManagementPage, { request });

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
  const pageId = params.get('page') === 'organizations' ? 'organizations' : 'users';
  if (!composition.items(context.admin).some((item) => item.id === pageId))
    throw new Error(`${pageId} menu is unavailable`);
  const page = composition.resolve(pageId, context.admin);
  if (page.id !== pageId) throw new Error(`${pageId} menu resolved to a different page`);
  return createApp(page.component, { ...page.props(context) });
}

const app = createFixtureApp();
app.use(ElementPlus);
app.use(i18n);
app.mount('#app');
