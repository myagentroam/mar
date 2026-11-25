import { createApp } from 'vue';
import '../../src/styles.css';
import MarControlsFixture from './mar-controls-fixture.vue';

const scheme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('dark', scheme === 'dark');
if (scheme === 'dark') document.documentElement.dataset.theme = 'dark';
document.documentElement.style.colorScheme = scheme;
createApp(MarControlsFixture).mount('#app');
