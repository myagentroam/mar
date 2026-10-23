import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import StandaloneFilePreviewPage from '../../src/view/workspace/StandaloneFilePreviewPage.vue';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { themePreferenceService } from '../../src/service/ThemePreferenceService.js';

themePreferenceService().setTheme(
  new URLSearchParams(location.search).get('theme') === 'daylight' ? 'daylight' : 'vscode-dark-2026'
);
createApp(StandaloneFilePreviewPage).use(ElementPlus).use(i18n).mount('#app');
