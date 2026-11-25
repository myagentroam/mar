import { createApp, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { marUiLocaleKey } from '@myagentroam/mar-ui/locale';
import en from '@myagentroam/mar-ui/locale/en';
import zhCn from '@myagentroam/mar-ui/locale/zh-cn';
import '../../src/styles.css';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import Fixture from './mar-form-fixture.vue';

const query = new URLSearchParams(location.search);
const locale = query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
document.documentElement.lang = locale;
themePreferenceService().setTheme(query.get('theme') === 'light' ? 'daylight' : 'dark');
const i18n = createI18n({
  legacy: false,
  locale,
  messages: {
    'en-US': {
      heading: 'Workspace settings',
      name: 'Display name',
      nameError: 'Enter a display name',
      nameHint: 'Shown to workspace members.',
      mode: 'Execution mode',
      modeError: 'Select a mode',
      local: 'Local workspace',
      visible: 'Show in directory',
      confirmed: 'Confirm changes',
      save: 'Save settings',
      disabled: 'Toggle disabled',
      clear: 'Clear name error'
    },
    'zh-CN': {
      heading: '工作区设置',
      name: '显示名称',
      nameError: '请输入显示名称',
      nameHint: '向工作区成员显示。',
      mode: '运行方式',
      modeError: '请选择运行方式',
      local: '本地工作区',
      visible: '在目录中显示',
      confirmed: '确认更改',
      save: '保存设置',
      disabled: '切换禁用',
      clear: '清除名称错误'
    }
  }
});
createApp(Fixture)
  .use(i18n)
  .provide(marUiLocaleKey, shallowRef(locale === 'zh-CN' ? zhCn : en))
  .mount('#app');
