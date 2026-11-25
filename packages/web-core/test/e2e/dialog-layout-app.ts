import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import DialogLayoutFixture from './dialog-layout-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

localePreferenceService().setLocale(
  new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
themePreferenceService().setTheme(
  new URLSearchParams(location.search).get('theme') === 'daylight' ? 'daylight' : 'dark'
);
createTooltipApp(DialogLayoutFixture).use(i18n).mount('#app');
