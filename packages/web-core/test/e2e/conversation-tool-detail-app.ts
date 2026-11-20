import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import ConversationToolDetailFixture from './conversation-tool-detail-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';

localePreferenceService().setLocale(
  new URL(location.href).searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US'
);
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight'
);
createTooltipApp(ConversationToolDetailFixture).use(i18n).mount('#app');
