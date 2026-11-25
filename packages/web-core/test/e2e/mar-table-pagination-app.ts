import { createApp } from 'vue';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import '../../src/styles.css';
import Fixture from './mar-table-pagination-fixture.vue';

themePreferenceService().setTheme('dark');
createApp(Fixture).mount('#app');
