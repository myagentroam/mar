import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import { createTooltipApp } from './tooltip-app.js';
import Fixture from './workbench-mobile-drawer-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const query = new URL(location.href).searchParams;
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(
  query.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(Fixture).use(i18n).use(ElementPlus).mount('#app');
