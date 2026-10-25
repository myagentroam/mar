import { createTooltipApp } from './tooltip-app.js';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import DialogLayoutFixture from './dialog-layout-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(
  new URLSearchParams(location.search).get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(DialogLayoutFixture).use(i18n).use(ElementPlus).mount('#app');
