import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import UserManagementPage from '../../../../ee/web/src/view/settings/UserManagementPage.vue';
import { i18n } from '../../../../ee/web/src/service/locale-preference-service.js';

i18n.global.locale.value =
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? 'Fixture request failed');
  return body as T;
}

const app = createApp(UserManagementPage, { request });
app.use(ElementPlus);
app.use(i18n);
app.mount('#app');
