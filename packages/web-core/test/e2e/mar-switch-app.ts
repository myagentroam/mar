import { createApp } from 'vue';
import '../../src/styles.css';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import Fixture from './mar-switch-fixture.vue';

const theme = new URL(location.href).searchParams.get('theme');
themePreferenceService().setTheme(theme === 'light' ? 'daylight' : 'dark');
createApp(Fixture).mount('#app');
