import { createTooltipApp as createApp } from './tooltip-app.js';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import ConversationStyleFixture from './conversation-style-fixture.vue';
import ConversationScrollFixture from './conversation-scroll-fixture.vue';
import ConversationEmptyFixture from './conversation-empty-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createApp(
  new URL(location.href).searchParams.has('empty-layout')
    ? ConversationEmptyFixture
    : new URL(location.href).searchParams.has('cached-scroll')
      ? ConversationScrollFixture
      : ConversationStyleFixture
)
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
