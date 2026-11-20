import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import Fixture from './workbench-style-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { MANAGEMENT_COMPOSITION_KEY } from '../../src/service/management-composition.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
localePreferenceService().setLocale(
  new URL(location.href).searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(Fixture)
  .use(i18n)
  .provide(MANAGEMENT_COMPOSITION_KEY, {
    items: () => [],
    resolve: () => {
      throw new Error('Unexpected fixture management page');
    }
  })
  .mount('#app');
