import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';
import ConversationToolDetailFixture from './conversation-tool-detail-fixture.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';

localePreferenceService().setLocale('en-US');
createTooltipApp(ConversationToolDetailFixture).use(i18n).mount('#app');
