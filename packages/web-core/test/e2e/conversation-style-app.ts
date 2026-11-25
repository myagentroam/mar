import { createTooltipApp as createApp } from './tooltip-app.js';
import '../../src/styles.css';
import ConversationStyleFixture from './conversation-style-fixture.vue';
import ConversationScrollFixture from './conversation-scroll-fixture.vue';
import ConversationEmptyFixture from './conversation-empty-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme(
  new URL(location.href).searchParams.get('theme') === 'daylight' ? 'daylight' : 'dark'
);
createApp(
  new URL(location.href).searchParams.has('empty-layout')
    ? ConversationEmptyFixture
    : new URL(location.href).searchParams.has('cached-scroll')
      ? ConversationScrollFixture
      : ConversationStyleFixture
)
  .use(i18n)
  .mount('#app');
