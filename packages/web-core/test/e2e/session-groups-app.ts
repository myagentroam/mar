import { createTooltipApp } from './tooltip-app.js';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/styles.css';
import Fixture from './session-groups-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

const params = new URL(location.href).searchParams;
localePreferenceService().setLocale(params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
const themes = themePreferenceService();
if (params.get('theme') === 'custom') {
  const source = JSON.parse(themes.builtinSource('daylight', 'Custom groups'));
  source.colors['--mar-fill-selection'] = '#dfe5d1';
  source.colors['--mar-color-brand'] = '#6d479e';
  const custom = themes.saveCustomTheme(JSON.stringify(source));
  themes.setTheme(custom.id);
} else themes.setTheme(params.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026');
createTooltipApp(Fixture).use(i18n).use(ElementPlus).mount('#app');
