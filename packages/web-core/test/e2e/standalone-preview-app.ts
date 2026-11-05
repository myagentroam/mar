import { createTooltipApp as createApp } from './tooltip-app.js';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import StandaloneFilePreviewPage from '../../src/view/workspace/StandaloneFilePreviewPage.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import {
  createPwaApplicationService,
  PWA_APPLICATION_SERVICE_KEY
} from '../../src/service/pwa-application-service.js';

themePreferenceService().setTheme(
  new URLSearchParams(location.search).get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createApp(StandaloneFilePreviewPage)
  .provide(
    PWA_APPLICATION_SERVICE_KEY,
    createPwaApplicationService(undefined, { version: 'fixture', buildId: 'fixture' })
  )
  .use(ElementPlus)
  .use(i18n)
  .mount('#app');
