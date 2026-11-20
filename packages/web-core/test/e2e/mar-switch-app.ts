import { createApp } from 'vue';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import Fixture from './mar-switch-fixture.vue';

const theme = new URL(location.href).searchParams.get('theme');
themePreferenceService().setTheme(theme === 'light' ? 'daylight' : 'vscode-dark-2026');
createApp(Fixture).mount('#app');
