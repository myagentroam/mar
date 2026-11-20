import { createApp } from 'vue';
import '../../src/styles.css';
import MarControlsFixture from './mar-controls-fixture.vue';

const scheme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('dark', scheme === 'dark');
document.documentElement.dataset.theme = `vscode-${scheme}-2026`;
document.documentElement.style.colorScheme = scheme;
createApp(MarControlsFixture).mount('#app');
