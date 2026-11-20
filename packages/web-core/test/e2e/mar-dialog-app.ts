import { createApp } from 'vue';
import { tooltipPlugin } from '../../src/directive/tooltip.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import '../../src/styles.css';
import Fixture from './mar-dialog-fixture.vue';

themePreferenceService().setTheme('vscode-dark-2026');
localePreferenceService().setLocale('en-US');
createApp(Fixture).use(tooltipPlugin).mount('#app');
