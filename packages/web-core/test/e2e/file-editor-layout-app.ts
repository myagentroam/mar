import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
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
const handle = ref<{ selectAll(): boolean }>();
const restoreDraft = query.has('draft');
function withActions(view: ReturnType<typeof h>) {
  return query.has('shortcuts')
    ? h('div', [
        h('input', {
          'aria-label': 'Outside preview',
          style: 'position: fixed; z-index: 100; left: 0; bottom: 0'
        }),
        h(
          'button',
          {
            style: 'position: fixed; z-index: 100; right: 0; bottom: 0',
            onMousedown: (event: MouseEvent) => event.preventDefault(),
            onClick: () => handle.value?.selectAll()
          },
          'Select preview content'
        ),
        view
      ])
    : view;
}
const content = longContent
  ? 'Long content '.repeat(30).concat('\n').repeat(100)
  : 'Original content';
createApp({
  setup: () => () => {
    const textMode = query.get('text');
    if (textMode === 'code' || textMode === 'fallback')
      return withActions(
        h(WorkspaceTextFilePage, {
          ref: handle,
          style: 'height: 100dvh',
          file: {
            path: '/workspace/example.txt',
            encoding: 'utf-8',
            content,
            revision: 'current-revision',
            size: textMode === 'fallback' ? 709830 : content.length,
            truncated: false
          },
          kind: 'text',
          tabIdentity: 'draft-tab',
          initialDirtyDraft: restoreDraft
            ? {
                tabIdentity: 'draft-tab',
                path: '/workspace/example.txt',
                content: 'Recovered unsaved content',
                expectedRevision: 'draft-revision'
              }
            : undefined,
          onDirtyDraftApplied: (identity: string) => {
            document.documentElement.dataset.appliedDraft = identity;
          },
          writeEnabled: restoreDraft,
          saveFile: async (value: string, revision: string) => {
            document.documentElement.dataset.savedDraft = JSON.stringify({ value, revision });
            return 'saved-revision';
          },
          downloading: false,
          targetLine: undefined
        })
      );
    const source = query.get('diff');
    if (source === 'HISTORY' || source === 'TOOL_CHANGE')
      return withActions(
        h(GitDiffViewer, {
          ref: handle,
          active: !query.has('inactive'),
          style: 'height: 100dvh',
          path: '/workspace/example.txt',
          paths: query.has('shortcuts')
            ? ['/workspace/example.txt', '/workspace/other.txt']
            : ['/workspace/example.txt'],
          onMoveFile: (direction: number) => {
            document.documentElement.dataset.movedFile = String(direction);
          },
          source,
          diff: {
            text:
              '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n' +
              (longContent ? content : '')
          },
          loading: false,
          previewEnabled: true
        })
      );
  }
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
