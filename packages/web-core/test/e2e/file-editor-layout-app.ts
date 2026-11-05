import { createTooltipApp as createApp } from './tooltip-app.js';
import { h, ref } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import '../../src/styles.css';
import GitDiffViewer from '../../src/view/workspace/GitDiffViewer.vue';
import WorkspaceTextFilePage from '../../src/view/workspace/WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from '../../src/view/workspace/WorkspaceFormatFilePage.vue';
import FilePreviewSurface from '../../src/view/workspace/FilePreviewSurface.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import { themePreferenceService } from '../../src/service/theme-preference-service.js';
import { consoleKeyboardShortcutService } from '../../src/service/console-keyboard-shortcut-service.js';
import type {
  WorkspaceNavigationNotice,
  WorkspaceNavigationTarget
} from '../../src/model/workspace-navigation.js';

localePreferenceService().setLocale('en-US');
const query = new URLSearchParams(location.search);
if (query.has('shortcuts')) {
  window.addEventListener('keydown', (event) => {
    consoleKeyboardShortcutService.handle(event);
  });
}
const navigationNotice = ref<WorkspaceNavigationNotice | undefined>(
  query.get('navigationNotice') === 'LIMITED'
    ? 'LIMITED'
    : query.get('navigationNotice') === 'UNAVAILABLE'
      ? 'UNAVAILABLE'
      : undefined
);
const navigationTargets = ref<WorkspaceNavigationTarget[]>(
  query.has('navigationCandidate') ? [{ source: 'DEFINITION', path: 'src/target.ts', line: 4 }] : []
);
themePreferenceService().setTheme(query.get('theme') === 'light' ? 'daylight' : 'vscode-dark-2026');
const longContent = query.has('long');
const handle = ref<{ selectAll(): boolean; openFind(): boolean }>();
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
        h(
          'button',
          {
            style: 'position: fixed; z-index: 100; right: 160px; bottom: 0',
            onClick: () => handle.value?.openFind()
          },
          'Find preview content'
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
    const state = query.get('preview-state');
    if (state === 'unsupported' || state === 'render-failed') {
      return h(
        FilePreviewSurface,
        { overlay: true, label: 'File preview' },
        {
          default: () =>
            h(WorkspaceFormatFilePage, {
              file: {
                path: state === 'unsupported' ? 'archive.bin' : 'broken.png',
                encoding: 'base64',
                content: '',
                truncated: false
              },
              kind: state === 'unsupported' ? 'unsupported' : 'image',
              contentUrl: state === 'unsupported' ? undefined : 'data:image/png;base64,invalid',
              downloading: false,
              onDownload: () => {
                document.documentElement.dataset.stateAction = 'download';
              }
            })
        }
      );
    }
    const image = query.get('image');
    if (image) {
      const [width, height] =
        image === 'landscape' ? [1600, 900] : image === 'portrait' ? [200, 2000] : [40, 40];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/></svg>`;
      return h(
        FilePreviewSurface,
        { overlay: true, label: 'File image preview' },
        {
          default: () =>
            h(WorkspaceFormatFilePage, {
              file: {
                path: 'sample.svg',
                encoding: 'base64',
                content: '',
                size: svg.length,
                truncated: false
              },
              contentUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
              kind: 'image',
              downloading: false,
              fullscreen: true,
              contained: true
            })
        }
      );
    }
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
          navigationNotice: navigationNotice.value,
          navigationTargets: navigationTargets.value,
          onOpenNavigationTarget: (target: { readonly path: string }) => {
            document.documentElement.dataset.openedNavigationTarget = target.path;
          },
          onDismissNavigation: () => {
            navigationNotice.value = undefined;
            navigationTargets.value = [];
          },
          targetLine: undefined
        })
      );
    const source = query.get('diff');
    if (source === 'HISTORY' || source === 'TOOL_CHANGE' || source === 'WORKING_TREE')
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
            binary: query.get('diff-state') === 'binary',
            afterText: source === 'WORKING_TREE' ? content : undefined,
            text:
              query.get('diff-state') === 'empty'
                ? undefined
                : '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n' +
                  (longContent ? content : '')
          },
          loading: false,
          loadFailed: query.has('load-failed'),
          loadErrorMessage: query.has('load-failed')
            ? i18n.global.t('errors.FILE_NOT_FOUND')
            : undefined,
          onPreview: () => {
            document.documentElement.dataset.stateAction = 'preview';
          },
          onRetry: () => {
            document.documentElement.dataset.diffRetries = String(
              Number(document.documentElement.dataset.diffRetries ?? '0') + 1
            );
          },
          previewEnabled: true
        })
      );
  }
})
  .use(i18n)
  .use(ElementPlus)
  .mount('#app');
