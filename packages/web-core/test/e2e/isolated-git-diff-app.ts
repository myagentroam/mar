import { h } from 'vue';
import ElementPlus from 'element-plus';
import { createTooltipApp } from './tooltip-app.js';
import GitDiffViewer from '../../src/view/workspace/GitDiffViewer.vue';
import { i18n } from '../../src/service/locale-preference-service.js';
import 'element-plus/dist/index.css';
import '../../src/styles.css';

createTooltipApp({
  render: () =>
    h(GitDiffViewer, {
      style: 'height: 100dvh',
      path: '/workspace/example.txt',
      paths: ['/workspace/example.txt'],
      source: 'HISTORY',
      diff: {
        binary: false,
        text: '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n'
      },
      loading: false,
      previewEnabled: false
    })
})
  .use(ElementPlus)
  .use(i18n)
  .mount('#app');
