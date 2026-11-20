import { h, reactive } from 'vue';
import { createTooltipApp } from './tooltip-app.js';
import WorkspaceFileTree from '../../src/view/workspace/WorkspaceFileTree.vue';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import '../../src/styles.css';

localePreferenceService().setLocale('en-US');
const file = reactive({
  path: 'notes.txt',
  name: 'notes.txt',
  kind: 'FILE' as const,
  size: 24,
  children: [],
  expanded: false,
  loaded: true,
  loading: false,
  nextCursor: null,
  placeholder: false
});
const root = reactive({
  ...file,
  path: '.',
  name: 'workspace',
  kind: 'DIRECTORY' as const,
  expanded: true,
  children: [
    file,
    ...['.agents', 'dist', 'src', 'test'].map((name) => ({
      ...file,
      path: name,
      name,
      kind: 'DIRECTORY' as const
    })),
    ...['button.spec.ts', '.gitignore', '.gitmodules'].map((name) => ({
      ...file,
      path: name,
      name
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      ...file,
      path: `generated-${index}`,
      name: `Long filename ${index} ${'content'.repeat(10)}.txt`
    }))
  ]
});
const state = reactive({
  selectedPath: '',
  disabled: false,
  mutationsEnabled: true,
  mobileViewport: false
});
createTooltipApp({
  render: () =>
    h('main', [
      h(
        'button',
        {
          onClick: () => {
            file.name = 'Renamed.ts';
          }
        },
        'Rename'
      ),
      h(
        'button',
        {
          onClick: () => {
            state.selectedPath = file.path;
          }
        },
        'Select'
      ),
      h(
        'button',
        {
          onClick: () => {
            state.disabled = !state.disabled;
          }
        },
        'Toggle disabled'
      ),
      h(
        'button',
        {
          onClick: () => {
            state.mobileViewport = !state.mobileViewport;
          }
        },
        'Toggle mobile'
      ),
      h(
        'button',
        {
          onClick: () => {
            root.loading = !root.loading;
            root.loaded = !root.loading;
          }
        },
        'Toggle loading'
      ),
      h(
        'button',
        {
          onClick: () => {
            state.mutationsEnabled = !state.mutationsEnabled;
          }
        },
        'Toggle mutations'
      ),
      h(
        'button',
        {
          onClick: () => {
            root.expanded = !root.expanded;
          }
        },
        'Toggle directory'
      ),
      h('button', { onClick: () => localePreferenceService().setLocale('zh-CN') }, 'Change locale'),
      h('section', { style: 'width:240px;height:250px;display:flex;margin-top:12px' }, [
        h(WorkspaceFileTree, { root, filter: '', ...state })
      ])
    ])
})
  .use(i18n)
  .mount('#app');
