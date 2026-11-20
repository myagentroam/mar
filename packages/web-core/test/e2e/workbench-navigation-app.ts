import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import Fixture from './workbench-navigation-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const params = new URLSearchParams(location.search);
localePreferenceService().setLocale(params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(
  params.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(Fixture).use(i18n).mount('#app');
