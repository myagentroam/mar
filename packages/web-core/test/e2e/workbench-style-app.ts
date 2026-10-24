import { createTooltipApp } from './tooltip-app.js';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import Fixture from './workbench-style-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { themePreferenceService } from '../../src/service/ThemePreferenceService.js';
import { MANAGEMENT_COMPOSITION_KEY } from '../../src/service/ManagementComposition.js';
localePreferenceService().setLocale(
  new URL(location.href).searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(Fixture)
  .use(i18n)
  .use(ElementPlus)
  .provide(MANAGEMENT_COMPOSITION_KEY, {
    items: () => [],
    resolve: () => {
      throw new Error('Unexpected fixture management page');
    }
  })
  .mount('#app');
