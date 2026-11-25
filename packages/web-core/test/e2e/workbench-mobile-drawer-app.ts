import '../../src/styles.css';
import { createTooltipApp } from './tooltip-app.js';
import Fixture from './workbench-mobile-drawer-fixture.vue';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const query = new URL(location.href).searchParams;
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(query.get('theme') === 'daylight' ? 'daylight' : 'dark');
createTooltipApp(Fixture).use(i18n).mount('#app');
