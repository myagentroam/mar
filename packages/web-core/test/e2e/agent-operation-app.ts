import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import AgentOperationFixture from './agent-operation-fixture.vue';

const query = new URLSearchParams(location.search);
localePreferenceService().setLocale(query.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');
themePreferenceService().setTheme(query.get('theme') === 'dark' ? 'vscode-dark-2026' : 'daylight');
createTooltipApp(AgentOperationFixture).use(i18n).mount('#app');
