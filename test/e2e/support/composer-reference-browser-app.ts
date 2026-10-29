import { createTooltipApp } from '../../../packages/web-core/test/e2e/tooltip-app.js';
import { ElButton } from '../../../packages/web-core/test/support/element-plus-button.js';
import '../../../packages/web-core/src/styles.css';
import ComposerReferenceBrowserFixture from './composer-reference-browser-fixture.vue';
import { localePreferenceService } from '../../../packages/web-core/src/service/locale-preference-service.js';

localePreferenceService().setLocale('en-US');
createTooltipApp(ComposerReferenceBrowserFixture).component('ElButton', ElButton).mount('#app');
