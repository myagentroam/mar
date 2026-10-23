import { createTooltipApp as createApp } from './tooltip-app.js';
import { h } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import GitDiffViewer from '../../src/view/workspace/GitDiffViewer.vue';
import WorkspaceTextFilePage from '../../src/view/workspace/WorkspaceTextFilePage.vue';
import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { themePreferenceService } from '../../src/service/ThemePreferenceService.js';

localePreferenceService().setLocale('en-US');
themePreferenceService().setTheme('vscode-dark-2026');
const query = new URLSearchParams(location.search);
const longContent = query.has('long');
const content = longContent
  ? 'Long content '.repeat(30).concat('\n').repeat(100)
  : 'Original content';
createApp({
  setup: () => () => {
    const textMode = query.get('text');
    if (textMode === 'code' || textMode === 'fallback')
      return h(WorkspaceTextFilePage, {
        style: 'height: 100dvh',
        file: {
          path: '/workspace/example.txt',
          encoding: 'utf-8',
          content,
          size: textMode === 'fallback' ? 709830 : content.length,
          truncated: false
        },
        kind: 'text',
        downloading: false,
        targetLine: undefined
      });
    const source = query.get('diff');
    if (source === 'HISTORY' || source === 'TOOL_CHANGE')
      return h(GitDiffViewer, {
        style: 'height: 100dvh',
        path: '/workspace/example.txt',
        paths: ['/workspace/example.txt'],
        source,
        diff: {
          text:
            '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n' +
            (longContent ? content : '')
        },
        loading: false,
        previewEnabled: true
      });
  }
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
