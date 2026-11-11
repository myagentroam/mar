import { createTooltipApp } from '../../../packages/web-core/test/e2e/tooltip-app.js';
import '../../../packages/web-core/src/styles.css';
import Fixture from './composer-quotes-fixture.vue';
import { localePreferenceService } from '../../../packages/web-core/src/service/locale-preference-service.js';
import { themePreferenceService } from '../../../packages/web-core/src/service/theme-preference-service.js';
themePreferenceService();
localePreferenceService().setLocale('en-US');
createTooltipApp(Fixture).mount('#app');
