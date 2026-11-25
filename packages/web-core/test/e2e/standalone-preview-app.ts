import { createTooltipApp as createApp } from './tooltip-app.js';
import '../../src/styles.css';
import StandaloneFilePreviewPage from '../../src/view/workspace/StandaloneFilePreviewPage.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import {
  createPwaApplicationService,
  PWA_APPLICATION_SERVICE_KEY
} from '../../src/service/pwa-application-service.js';

themePreferenceService().setTheme(
  new URLSearchParams(location.search).get('theme') === 'daylight' ? 'daylight' : 'dark'
);
createApp(StandaloneFilePreviewPage)
  .provide(
    PWA_APPLICATION_SERVICE_KEY,
    createPwaApplicationService(undefined, { version: 'fixture', buildId: 'fixture' })
  )
  .use(i18n)
  .mount('#app');
