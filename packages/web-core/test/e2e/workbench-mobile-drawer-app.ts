import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import { createTooltipApp } from './tooltip-app.js';
import Fixture from './workbench-mobile-drawer-fixture.vue';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const query = new URL(location.href).searchParams;
document.addEventListener('keydown', consoleKeyboardShortcutService.handle, { capture: true });
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(
  query.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createTooltipApp(Fixture).use(i18n).use(ElementPlus).mount('#app');
