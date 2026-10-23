import { readFileSync } from 'node:fs';
import { createSSRApp, h, type Component, type Ref, type SetupContext } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, {
  ElMessageBox,
  ID_INJECTION_KEY,
  ZINDEX_INJECTION_KEY,
  type MessageBoxData
} from 'element-plus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileSpecifierParser } from '@myagentroam/code-navigation';
import { filePreviewEnUS, filePreviewZhCN } from '../../src/i18n/file-preview.js';
import { commonMessages } from '../../src/i18n/messages.js';
import {
  i18n,
  localePreferenceService,
  translate
} from '../../src/service/LocalePreferenceService.js';
import WorkspaceFilePage from '../../src/view/workspace/WorkspaceTextFilePage.vue';
import WorkspaceFormatFilePage from '../../src/view/workspace/WorkspaceFormatFilePage.vue';
import GitDiffViewer from '../../src/view/workspace/GitDiffViewer.vue';
import InlineFindBar from '../../src/view/workspace/InlineFindBar.vue';
import FilePreviewLoading from '../../src/view/workspace/FilePreviewLoading.vue';

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n);
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 200, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  return renderToString(app);
}

it.each(['page', 'region'] as const)(
  'keeps an accessible preview wait with the %s visual role',
  async (variant) => {
    const html = await render(FilePreviewLoading, { variant, overlay: true });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label=');
    expect(html).toContain('busy-indicator');
    expect(html.includes('page-loading-state')).toBe(variant === 'page');
    expect(html.replace(/<[^>]*>/gu, '').trim()).toBe(
      variant === 'region' ? translate('generated.filePreviewDialog.loadingPreview') : ''
    );
  }
);

function buttonTag(html: string, label: string): string {
  const button = html
    .match(/<button\b[^>]*>/gu)
    ?.find((tag) => tag.includes(`aria-label="${label}"`));
  expect(button, label).toBeDefined();
  return button!;
}

function expectNativeButtonTitles(html: string): void {
  const buttons = html.match(/<button\b[^>]*aria-label="[^"]+"[^>]*>/gu) ?? [];
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button).toMatch(/\stitle="[^"]+"/u);
  }
}

function stubBrowserEnvironment(): {
  readonly storage: Map<string, string>;
  readonly setItem: ReturnType<typeof vi.fn>;
  readonly listeners: Map<
    string,
    (event: { readonly key: string | null; readonly newValue: string | null }) => void
  >;
} {
  const storage = new Map<string, string>();
  const listeners = new Map<
    string,
    (event: { readonly key: string | null; readonly newValue: string | null }) => void
  >();
  const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem,
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(
      (
        type: string,
        listener: (event: { readonly key: string | null; readonly newValue: string | null }) => void
      ) => listeners.set(type, listener)
    ),
    removeEventListener: vi.fn()
  });
  return { storage, setItem, listeners };
}

async function setupStandaloneWithCachedDraft() {
  stubBrowserEnvironment();
  const closeWindow = vi.fn();
  Object.assign(window, { close: closeWindow });
  const locationUrl = new URL(
    'https://example.invalid/console?standaloneFile=1&nodeId=node-1&workspaceId=workspace-1&path=active.txt'
  );
  vi.stubGlobal('location', locationUrl);
  const draft = {
    tabIdentity: 'inactive-tab',
    path: 'inactive.txt',
    content: 'unsaved draft',
    expectedRevision: 'revision-1'
  };
  const cachedTab = {
    id: 7,
    identity: draft.tabIdentity,
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    kind: 'WORKTREE_TEXT',
    path: draft.path,
    fileName: draft.path,
    url: `${locationUrl.origin}/console?standaloneFile=1&nodeId=node-1&workspaceId=workspace-1&path=inactive.txt`
  };
  const storage = new Map([
    ['mar.standalone-file-tabs.v1', JSON.stringify([cachedTab])],
    ['mar.standalone-file-drafts.v1', JSON.stringify([draft])]
  ]);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  interface Bindings {
    canCloseUnmountedTab(id: number): Promise<boolean>;
    closeStandaloneTab(id: number): void;
    closeStandaloneTabs(): void;
    standaloneTabs: Ref<readonly { id: number }[]>;
    dirtyDrafts: Ref<readonly (typeof draft)[]>;
  }
  const { default: standalone } =
    await import('../../src/view/workspace/StandaloneFilePreviewPage.vue');
  const setup = (standalone as unknown as { setup(props: object, context: SetupContext): Bindings })
    .setup;
  let bindings!: Bindings;
  const app = createSSRApp({
    setup(_props, context) {
      bindings = setup({}, context);
      return () => null;
    }
  });
  app.use(i18n);
  await renderToString(app);
  return { bindings, storage, draft, closeWindow };
}

const filePreviewMessageKeys = [
  'common.gitDiff',
  'common.save',
  'common.cancel',
  'fileEditor.edit',
  'fileEditor.editing',
  'fileEditor.readOnly',
  'fileEditor.saved',
  'fileEditor.conflict',
  'fileEditor.saveFailed',
  'fileEditor.unsavedMessage',
  'fileEditor.unsavedTitle',
  'filePreviewContext.copy',
  'filePreviewContext.paste',
  'filePreviewContext.reload',
  'filePreviewContext.clipboardFailed',
  'filePreviewContext.reloadUnsaved',
  'fileEditor.symbols',
  'fileEditor.searchSymbols',
  'fileEditor.noSymbols',
  'markdownPreview.open',
  'htmlPreview.open',
  'markdownPreview.settings',
  'markdownPreview.watermarkRequired',
  'markdownPreview.watermarkEnabled',
  'markdownPreview.watermarkText',
  'markdownPreview.watermarkPlaceholder',
  'inlineFind.label',
  'inlineFind.placeholder',
  'inlineFind.previous',
  'inlineFind.next',
  'inlineFind.close',
  'inlineFind.replacePlaceholder',
  'inlineFind.selectAll',
  'inlineFind.matchCase',
  'inlineFind.regexp',
  'inlineFind.wholeWord',
  'inlineFind.replace',
  'inlineFind.replaceAll',
  'gitDiffViewer.mobileSummary',
  'gitDiffViewer.mobileFileSummary',
  'gitDiffViewer.mobileChangeSummary',
  'gitDiffViewer.collapseMobileActions',
  'gitDiffViewer.expandMobileActions',
  'filePreviewDialog.collapseMobileActions',
  'filePreviewDialog.expandMobileActions',
  'filePreviewDialog.closeFileWindow',
  'generated.filePreviewDialog.filePreview',
  'generated.filePreviewDialog.downloadFile',
  'generated.filePreviewDialog.closePreview',
  'generated.filePreviewDialog.filePreviewActions',
  'generated.filePreviewDialog.codeEditorPreview',
  'generated.filePreviewDialog.onlyTheFirst512KiBIsShown',
  'generated.filePreviewDialog.thisFileTypeCannotBePreviewedIn',
  'generated.filePreviewDialog.previewFailedDownloadInstead',
  'generated.filePreviewDialog.loadingPreview',
  'generated.filePreviewDialog.filePreviewTabs',
  'generated.gitDiffViewer.gitDiffHasNoDisplayableTextContent',
  'generated.gitDiffViewer.gitDiffLoadFailed',
  'generated.gitDiffViewer.retry',
  'generated.gitDiffViewer.diffToolbar',
  'generated.gitDiffViewer.previousFile',
  'generated.gitDiffViewer.nextFile',
  'generated.gitDiffViewer.previousChange',
  'generated.gitDiffViewer.nextChange',
  'generated.gitDiffViewer.closeDiffPreview',
  'generated.gitDiffViewer.diffPreviewActions',
  'generated.gitDiffViewer.downloadDiff',
  'generated.gitDiffViewer.binaryFilesDoNotSupportDiff',
  'generated.gitDiffViewer.openFilePreview',
  'generated.gitDiffViewer.filePreviewRequiresNewerNode',
  'generated.gitDiffViewer.theCurrentNodeDidNotReturnThe',
  'generated.gitDiffViewer.showingTheFirst512KiB',
  'generated.gitDiffViewer.fullWorkingTreeFile',
  'generated.gitDiffViewer.emptyFile',
  'generated.gitDiffViewer.diffCodeMinimap',
  'generated.standaloneFilePreviewPage.theFilePreviewURLIsInvalid',
  'generated.standaloneFilePreviewPage.unableToReadTheFileCheckYour'
] as const;

const originalLocale = localePreferenceService().locale.value;

afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllTimers();
});

describe('standalone cached-draft close confirmation', () => {
  it('preserves inactive drafts on cancellation and clears them only after confirmed window close', async () => {
    const state = await setupStandaloneWithCachedDraft();
    const confirm = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as MessageBoxData);
    await expect(state.bindings.canCloseUnmountedTab(7)).resolves.toBe(false);
    expect(state.bindings.dirtyDrafts.value).toEqual([state.draft]);
    expect(state.storage.get('mar.standalone-file-drafts.v1')).toBe(JSON.stringify([state.draft]));
    expect(state.closeWindow).not.toHaveBeenCalled();
    await expect(state.bindings.canCloseUnmountedTab(7)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(state.bindings.dirtyDrafts.value).toEqual([state.draft]);
    state.bindings.closeStandaloneTabs();
    expect(state.bindings.standaloneTabs.value).toEqual([]);
    expect(state.storage.has('mar.standalone-file-drafts.v1')).toBe(false);
    expect(state.closeWindow).toHaveBeenCalledOnce();
  });

  it('does not prompt for clean tabs and removes only the individually closed draft', async () => {
    const state = await setupStandaloneWithCachedDraft();
    const confirm = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockResolvedValueOnce('confirm' as MessageBoxData);
    const cleanId = state.bindings.standaloneTabs.value.find((tab) => tab.id !== 7)!.id;
    await expect(state.bindings.canCloseUnmountedTab(cleanId)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    await expect(state.bindings.canCloseUnmountedTab(7)).resolves.toBe(true);
    state.bindings.closeStandaloneTab(7);
    expect(state.bindings.standaloneTabs.value).toHaveLength(1);
    expect(state.bindings.dirtyDrafts.value).toEqual([]);
    expect(state.storage.get('mar.standalone-file-drafts.v1')).toBe('[]');
    expect(state.closeWindow).not.toHaveBeenCalled();
  });
});

describe.each(['zh-CN', 'en-US'] as const)('public file preview components (%s)', (locale) => {
  it('omits embedded page close buttons but keeps standalone preview exits', async () => {
    stubBrowserEnvironment();
    localePreferenceService().setLocale(locale);
    const file = { path: 'sample.txt', encoding: 'utf-8', content: 'sample', truncated: false };
    const base = {
      file,
      kind: 'text',
      writeEnabled: false,
      downloading: false,
      targetLine: undefined,
      contentUrl: undefined
    };
    for (const component of [WorkspaceFilePage, WorkspaceFormatFilePage]) {
      const embedded = await render(component, base);
      expectNativeButtonTitles(embedded);
      expect(embedded).not.toContain(
        `aria-label="${i18n.global.t('generated.filePreviewDialog.closePreview')}"`
      );
      const standalone = await render(component, { ...base, fullscreen: true });
      expectNativeButtonTitles(standalone);
      expect(standalone).toContain(
        `aria-label="${i18n.global.t('generated.filePreviewDialog.closePreview')}"`
      );
    }
    const diffProps = {
      path: 'sample.txt',
      paths: ['sample.txt'],
      diff: undefined,
      previewEnabled: true,
      loading: true
    };
    const embeddedDiff = await render(GitDiffViewer, { ...diffProps, embedded: true });
    expect(embeddedDiff).not.toContain(
      `aria-label="${i18n.global.t('generated.gitDiffViewer.closeDiffPreview')}"`
    );
    const standaloneDiff = await render(GitDiffViewer, diffProps);
    expect(standaloneDiff).toContain(
      `aria-label="${i18n.global.t('generated.gitDiffViewer.closeDiffPreview')}"`
    );
  });

  it('registers file-navigation specifier handlers by source suffix', () => {
    expect(fileSpecifierParser('src/main.ts')?.find('import x from "./x.js";', 17)?.value).toBe(
      './x.js'
    );
    expect(
      fileSpecifierParser('src/Main.java')?.find('import com.example.Service;', 15)?.value
    ).toBe('com.example.Service');
    expect(
      fileSpecifierParser('src/main.py')?.find('from package.module import value', 10)?.value
    ).toBe('package.module');
    expect(
      fileSpecifierParser('src/main.cpp')?.find('#include "hal/ZOSHalMisc.h"', 17)?.value
    ).toBe('hal/ZOSHalMisc.h');
    expect(fileSpecifierParser('src/lib.rs')?.find('pub mod child;', 10)?.value).toBe('child');
    expect(
      fileSpecifierParser('src/main.go')?.find('import "example.test/project/internal/feature"', 15)
        ?.value
    ).toBe('example.test/project/internal/feature');
    expect(
      fileSpecifierParser('src/Program.cs')?.find('using Company.Project.Models;', 12)?.value
    ).toBe('Company.Project.Models');
    expect(fileSpecifierParser('styles/main.css')?.find('@import "./theme.css";', 10)?.value).toBe(
      './theme.css'
    );
    expect(fileSpecifierParser('styles/main.scss')?.find('@use "palette";', 7)?.value).toBe(
      'palette'
    );
    expect(
      fileSpecifierParser('components/App.vue')?.find(
        '<template><img src="../assets/logo.svg"></template>',
        26
      )?.value
    ).toBe('../assets/logo.svg');
  });

  it('registers complete preview, editor, Diff, and find messages in the public locale catalog', () => {
    localePreferenceService().setLocale(locale);
    const source = locale === 'en-US' ? filePreviewEnUS : filePreviewZhCN;

    expect(source).toBeDefined();
    expect(commonMessages[locale]).toBeDefined();
    for (const key of filePreviewMessageKeys) {
      expect(i18n.global.te(key, locale), key).toBe(true);
      expect(i18n.global.t(key, { value0: 'sample', value1: 2 })).not.toBe(key);
    }
  });

  it('renders the inline find bar with localized labels, a truncated count, and enabled navigation', async () => {
    localePreferenceService().setLocale(locale);
    const html = await render(InlineFindBar, {
      modelValue: 'needle',
      current: 2,
      total: 7,
      truncated: true
    });

    expect(html).toContain('role="search"');
    expect(html).toContain(i18n.global.t('inlineFind.label'));
    expect(html).toContain(i18n.global.t('inlineFind.placeholder'));
    expect(html).toContain('2 / 7+');
    expectNativeButtonTitles(html);
    expect(html).toContain(`aria-label="${i18n.global.t('inlineFind.previous')}"`);
    expect(html).toContain(`aria-label="${i18n.global.t('inlineFind.next')}"`);
    for (const key of ['inlineFind.previous', 'inlineFind.next']) {
      expect(buttonTag(html, i18n.global.t(key))).not.toMatch(/\sdisabled(?:\s|=|>)/u);
    }
    expect(html).not.toMatch(/(?:inlineFind|generated)\./u);
  });

  it('disables inline find navigation when no match exists while keeping the close action available', async () => {
    localePreferenceService().setLocale(locale);
    const html = await render(InlineFindBar, {
      modelValue: '',
      current: 0,
      total: 0,
      truncated: false
    });

    expect(html).toContain('0 / 0');
    expectNativeButtonTitles(html);
    for (const key of ['inlineFind.previous', 'inlineFind.next']) {
      expect(buttonTag(html, i18n.global.t(key))).toMatch(/\sdisabled(?:\s|=|>)/u);
    }
    expect(buttonTag(html, i18n.global.t('inlineFind.close'))).not.toMatch(/\sdisabled(?:\s|=|>)/u);
  });

  it('renders a binary Diff as a read-only fallback with an escaped path title during SSR', async () => {
    localePreferenceService().setLocale(locale);
    const path = 'assets/<logo>.png';
    const html = await render(GitDiffViewer, {
      path,
      diff: {
        binary: true,
        summary: 'Binary files differ',
        afterText: 'must not become searchable or visible'
      },
      paths: [path],
      loading: false,
      source: 'WORKING_TREE',
      previewEnabled: false
    });

    expectNativeButtonTitles(html);

    expect(html).toContain('role="dialog"');
    expect(html).toContain(`title="assets/&lt;logo&gt;.png"`);
    expect(html).toContain(i18n.global.t('common.gitDiff'));
    expect(html).toContain(i18n.global.t('generated.gitDiffViewer.binaryFilesDoNotSupportDiff'));
    expect(html).toContain(i18n.global.t('generated.gitDiffViewer.openFilePreview'));
    expect(html).toContain(i18n.global.t('generated.gitDiffViewer.filePreviewRequiresNewerNode'));
    expect(html).toContain('disabled');
    expect(html).not.toContain('unified-diff-code');
    expect(html).not.toContain('diff-minimap');
    expect(html).not.toContain('must not become searchable or visible');
    expect(html).not.toMatch(/(?:gitDiffViewer|generated)\./u);
  });

  it('renders mutually exclusive Git Diff loading, failure, fallback, history, and empty states', async () => {
    localePreferenceService().setLocale(locale);
    const base = {
      path: 'src/example.ts',
      paths: ['src/example.ts'],
      previewEnabled: true
    };
    const loading = await render(GitDiffViewer, {
      ...base,
      diff: undefined,
      loading: true,
      source: 'WORKING_TREE'
    });
    expect(loading).toContain(i18n.global.t('generated.filePreviewDialog.loadingPreview'));
    expect(loading).toContain('file-preview-loading');
    expect(loading).not.toContain(
      i18n.global.t('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe')
    );
    expect(loading).not.toContain(
      i18n.global.t('generated.gitDiffViewer.gitDiffHasNoDisplayableTextContent')
    );
    expect(loading).not.toContain('diff-minimap');
    expect(loading).not.toContain(i18n.global.t('generated.gitDiffViewer.gitDiffLoadFailed'));

    const loadingFailed = await render(GitDiffViewer, {
      ...base,
      diff: undefined,
      loading: true,
      loadFailed: true,
      source: 'WORKING_TREE'
    });
    expect(loadingFailed).toContain(i18n.global.t('generated.filePreviewDialog.loadingPreview'));
    expect(loadingFailed).not.toContain(i18n.global.t('generated.gitDiffViewer.gitDiffLoadFailed'));
    expect(loadingFailed).not.toContain(i18n.global.t('generated.gitDiffViewer.retry'));

    const failed = await render(GitDiffViewer, {
      ...base,
      diff: undefined,
      loading: false,
      loadFailed: true,
      source: 'WORKING_TREE'
    });
    expect(failed).toContain(i18n.global.t('generated.gitDiffViewer.gitDiffLoadFailed'));
    expect(failed).toContain(i18n.global.t('generated.gitDiffViewer.retry'));
    expect(failed).not.toContain(
      i18n.global.t('generated.gitDiffViewer.gitDiffHasNoDisplayableTextContent')
    );
    expect(failed).not.toContain('diff-minimap');

    const full = await render(GitDiffViewer, {
      ...base,
      diff: { text: '@@ -1,1 +0,0 @@\n-old', afterText: '' },
      loading: false,
      source: 'WORKING_TREE'
    });
    expect(full).toContain('unified-diff-code');
    expect(full).toContain(i18n.global.t('generated.gitDiffViewer.emptyFile'));
    expect(full).not.toContain(
      i18n.global.t('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe')
    );

    const unifiedText = '@@ -1 +1 @@\n-old\n+new';
    const fallback = await render(GitDiffViewer, {
      ...base,
      diff: { text: unifiedText },
      loading: false,
      source: 'WORKING_TREE'
    });
    expect(
      fallback.match(
        new RegExp(i18n.global.t('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe'), 'gu')
      )
    ).toHaveLength(1);
    expect(fallback).toContain('+new');

    const history = await render(GitDiffViewer, {
      ...base,
      diff: { text: unifiedText },
      loading: false,
      source: 'HISTORY'
    });
    expect(history).toContain('+new');
    expect(history).not.toContain(
      i18n.global.t('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe')
    );

    const empty = await render(GitDiffViewer, {
      ...base,
      diff: {},
      loading: false,
      source: 'WORKING_TREE'
    });
    expect(
      empty.match(
        new RegExp(
          i18n.global.t('generated.gitDiffViewer.gitDiffHasNoDisplayableTextContent'),
          'gu'
        )
      )
    ).toHaveLength(1);
    expect(empty).not.toContain(
      i18n.global.t('generated.gitDiffViewer.theCurrentNodeDidNotReturnThe')
    );
  });

  it('renders an oversized text file as a lightweight read-only preview during SSR', async () => {
    stubBrowserEnvironment();
    localePreferenceService().setLocale(locale);
    const html = await render(WorkspaceFilePage, {
      file: {
        path: 'notes/<draft>.txt',
        size: 709_830,
        encoding: 'utf-8',
        content: 'Original <content>',
        truncated: false
      },
      contentUrl: undefined,
      kind: 'text',
      downloading: false,
      targetLine: undefined,
      writeEnabled: false
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain(`title="notes/&lt;draft&gt;.txt"`);
    expect(html).toContain(i18n.global.t('fileEditor.readOnly'));
    expect(html).toContain('693.19 KB');
    expect(html).toContain('file-text-preview');
    expectNativeButtonTitles(html);
    expect(html).toContain(i18n.global.t('generated.filePreviewDialog.onlyTheFirst512KiBIsShown'));
    expect(html).not.toContain('code-file-editor');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).not.toContain('inert');
    expect(html).not.toContain(i18n.global.t('fileEditor.editing'));
    expect(html).not.toMatch(/(?:fileEditor|filePreviewDialog|generated)\./u);
  });

  it('renders code navigation preparation, no-result and multiple-definition states without exposing implementation details', async () => {
    stubBrowserEnvironment();
    localePreferenceService().setLocale(locale);
    const base = {
      file: {
        path: 'src/current.ts',
        size: 42,
        encoding: 'utf-8' as const,
        content: 'example()',
        truncated: false
      },
      contentUrl: undefined,
      kind: 'text' as const,
      downloading: false,
      targetLine: undefined
    };

    const preparing = await render(WorkspaceFilePage, { ...base, navigationLoading: true });
    expect(preparing).toContain(i18n.global.t('fileEditor.preparingNavigation'));

    const noDefinition = await render(WorkspaceFilePage, {
      ...base,
      navigationNoDefinition: true
    });
    expect(noDefinition).toContain(i18n.global.t('fileEditor.noDefinition'));

    const multiple = await render(WorkspaceFilePage, {
      ...base,
      tabs: [
        { id: 1, path: 'src/current.ts' },
        { id: 2, path: 'src/a.ts' }
      ],
      activeTabId: 2,
      navigationTargets: [
        {
          source: 'DEFINITION',
          path: 'src/a.ts',
          line: 3,
          kind: 'f',
          preview: 'export function alpha() { return 1; }'
        },
        {
          source: 'REFERENCE',
          path: 'src/b.ts',
          line: 8,
          column: 4,
          preview: 'alpha()'
        },
        { source: 'FILE', path: 'src/module.ts', line: 1, kind: 'file', preview: 'export {}' }
      ]
    });
    expect(multiple).toContain(i18n.global.t('fileEditor.definitions'));
    expect(multiple).toContain(i18n.global.t('fileEditor.references'));
    expect(multiple).toContain(i18n.global.t('fileEditor.files'));
    expect(multiple).toContain('src/a.ts');
    expect(multiple).toContain('src/b.ts');
    expect(multiple).toContain('src/module.ts');
    expect(multiple).toContain('hljs-keyword');
    expect(multiple).toContain('hljs-title function_');
    const dialogSource = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTextFilePage.vue', import.meta.url),
      'utf8'
    );
    expect(dialogSource).toMatch(
      /\.file-navigation-dropdown\s*\{[^}]*max-height:\s*min\(42rem,\s*calc\(100vh - 5rem\)\);[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*\}/u
    );
    expect(dialogSource).toMatch(
      /\.file-navigation-dropdown\s+\.file-symbol-list\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;[^}]*\}/u
    );
  });

  it('falls back to read-only preview when an editable file is not text-previewable', async () => {
    stubBrowserEnvironment();
    localePreferenceService().setLocale(locale);
    const html = await render(WorkspaceFormatFilePage, {
      file: {
        path: 'runtime-credential-hmac.key',
        size: 32,
        encoding: 'base64',
        content: '',
        truncated: false,
        revision: 'revision-1'
      },
      contentUrl: undefined,
      kind: 'unsupported',
      downloading: false,
      targetLine: undefined,
      writeEnabled: true,
      saveFile: async () => 'revision-2'
    });

    expect(html).not.toContain(i18n.global.t('fileEditor.editing'));
    expect(html).toContain(
      i18n.global.t('generated.filePreviewDialog.thisFileTypeCannotBePreviewedIn')
    );
    expect(html).not.toContain('code-file-editor');
  });

  it('applies a restored dirty draft on first page render and scopes Diff shortcuts to visible content', () => {
    const textPage = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTextFilePage.vue', import.meta.url),
      'utf8'
    );
    const diffViewer = readFileSync(
      new URL('../../src/view/workspace/GitDiffViewer.vue', import.meta.url),
      'utf8'
    );

    expect(textPage).toContain('{ immediate: true }');
    expect(textPage).toContain("emit('dirty-draft-applied', draft.tabIdentity)");
    expect(textPage).toContain('v-if="fallbackFindOpen && fallbackTextEnabled"');
    expect(textPage).toContain('ref="fallbackTextArea"');
    expect(textPage).toContain('textArea.setSelectionRange(0, textArea.value.length)');
    expect(diffViewer).toContain('if (props.active === false) return;');
    expect(diffViewer).toContain(
      "if (typeof document === 'undefined' || props.embedded === true) return;"
    );
    expect(diffViewer).toContain('event.stopPropagation();\n    closeFind();');
    expect(diffViewer).toContain('@keydown="onKeydown"');
    expect(diffViewer).not.toContain("window.addEventListener('keydown', onKeydown)");
    expect(diffViewer).toContain('function selectAll(): boolean {');
    expect(diffViewer).toContain('selection.selectAllChildren(pane);');
    expect(diffViewer).toContain('selectAll,');
  });
});

describe('standalone Markdown preview', () => {
  it('uses an explicit light scroll surface instead of inheriting the console theme', () => {
    const source = readFileSync(
      new URL('../../src/view/workspace/StandaloneFilePreviewPage.vue', import.meta.url),
      'utf8'
    );

    expect(source).toContain('github-markdown-css/github-markdown-light.css?url');
    expect(source).toMatch(
      /\.standalone-file-preview\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*auto;[^}]*background:\s*#fff;[^}]*color-scheme:\s*light;[^}]*\}/u
    );
    expect(source).toMatch(
      /\.markdown-preview-page\s+:deep\(\.markdown-body\)\s*\{[^}]*background-color:\s*transparent;[^}]*color-scheme:\s*light;[^}]*\}/u
    );
    expect(source).toMatch(/\.markdown-preview-page\s*\{[^}]*padding:\s*6mm 18mm 18mm;[^}]*\}/u);
    expect(source).toMatch(
      /\.markdown-preview-page\s+:deep\(\.markdown-body > :first-child\)\s*\{[^}]*margin-top:\s*0;[^}]*\}/u
    );
    expect(source).toMatch(
      /@media print\s*\{[\s\S]*?\.standalone-file-preview\s*\{[^}]*display:\s*block;[^}]*min-height:\s*0;[^}]*\}/u
    );
    expect(source).toMatch(
      /@media print\s*\{[\s\S]*?:global\(#app\)\s*\{[^}]*height:\s*auto\s*!important;[^}]*overflow:\s*visible\s*!important;[^}]*background:\s*#fff\s*!important;[^}]*\}/u
    );
    expect(source).toMatch(
      /@media print\s*\{[\s\S]*?@page\s*\{[^}]*margin:\s*0;[^}]*\}[\s\S]*?\.markdown-preview-page\s*\{[^}]*width:\s*210mm;[^}]*min-height:\s*297mm;[^}]*padding:\s*18mm;[^}]*\}/u
    );
  });

  it('keeps unavailable edit shortcuts native and gives format previews mobile actions', () => {
    const standalone = readFileSync(
      new URL('../../src/view/workspace/StandaloneFilePreviewPage.vue', import.meta.url),
      'utf8'
    );
    const formatPage = readFileSync(
      new URL('../../src/view/workspace/WorkspaceFormatFilePage.vue', import.meta.url),
      'utf8'
    );
    const frame = readFileSync(
      new URL('../../src/view/workspace/WorkspaceFilePageFrame.vue', import.meta.url),
      'utf8'
    );

    expect(standalone).toContain('<WorkspaceFileTabs');
    expect(standalone).toContain(':tabs="standaloneTabs"');
    expect(standalone).toContain('@activate="activateStandaloneTab"');
    expect(standalone).toContain('@close="closeStandaloneTab"');
    expect(standalone).toContain(
      "const markdownPreviewMode = !query.has('repositoryPath') && query.get('markdownPreview') === '1';"
    );
    expect(standalone).toContain('v-if="markdownPreviewMode"');
    expect(standalone).toContain(
      "const htmlPreviewMode = !query.has('repositoryPath') && query.get('htmlPreview') === '1';"
    );
    const inspector = readFileSync(
      new URL('../../src/view/workspace/WorkspaceInspector.vue', import.meta.url),
      'utf8'
    );
    expect(inspector).toContain(
      "preview === 'html' && activePreview.value?.worktreePath.value !== undefined"
    );
    expect(formatPage).toContain("toggleEdit: () => 'UNAVAILABLE' as const");
    expect(formatPage).toContain('createFilePreviewWindowInteractionService');
    expect(formatPage).toContain('if (props.fullscreen) windowInteraction.mount();');
    expect(standalone).toContain('if (renderedPreviewMode) windowInteraction.mount();');
    expect(formatPage).toContain('<template #mobile-actions>');
    expect(formatPage).toContain('mobile-actions-layout="compact"');
    expect(formatPage).toContain("translate('generated.filePreviewDialog.closePreview2')");
    expect(frame).toContain('class="mobile-preview-actions workspace-file-mobile-actions"');
    expect(frame).toContain("translate('filePreviewDialog.collapseMobileActions')");
    expect(frame).toContain('.workspace-file-mobile-actions.is-stacked');
    expect(frame).toMatch(
      /<div class="workspace-file-page-frame-content">\s*<FilePreviewLoading v-if="props.loading" overlay \/>/u
    );
    expect(frame).toContain('isolation: isolate');
    expect(standalone).toContain('htmlUrl && !htmlFrameLoaded');
    expect(standalone).toContain('htmlFrameLoaded.value = true');
    expect(standalone).toContain('<FilePreviewLoading');
    expect(formatPage).toContain('<FilePreviewLoading v-if="rendererLoading" overlay />');
    const loading = readFileSync(
      new URL('../../src/view/workspace/FilePreviewLoading.vue', import.meta.url),
      'utf8'
    );
    expect(loading).toContain("translate('generated.filePreviewDialog.loadingPreview')");
    expect(loading).toContain('<BusyIndicator />');
    const sharedStyles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    expect(sharedStyles).toContain('prefers-reduced-motion: no-preference');
    expect(sharedStyles).toContain('busy-indicator-spin');
    const textPage = readFileSync(
      new URL('../../src/view/workspace/WorkspaceTextFilePage.vue', import.meta.url),
      'utf8'
    );
    expect(textPage).toContain(':loading="loading"');
    expect(textPage).not.toContain('class="file-preview-loading"');
  });
});

describe('public file preview preferences', () => {
  it('persists editor mode and exposes the same reactive state through every service accessor', async () => {
    const browser = stubBrowserEnvironment();
    vi.resetModules();

    const { fileEditorPreferenceService, parseFileEditorDefaultMode } =
      await import('../../src/service/FileEditorPreferenceService.js');
    expect(parseFileEditorDefaultMode('read-only')).toBe('read-only');
    expect(parseFileEditorDefaultMode('unexpected')).toBe('edit');

    const first = fileEditorPreferenceService();
    const second = fileEditorPreferenceService();
    expect(first.mode.value).toBe('edit');

    first.setMode('read-only');
    expect(second.mode.value).toBe('read-only');
    expect(browser.storage.get('mar.file-editor.default-mode')).toBe('read-only');

    vi.resetModules();
    const { fileEditorPreferenceService: restoredEditorPreferenceService } =
      await import('../../src/service/FileEditorPreferenceService.js');
    expect(restoredEditorPreferenceService().mode.value).toBe('read-only');
  });

  it('normalizes saved Markdown preferences and applies storage events to the current service', async () => {
    const browser = stubBrowserEnvironment();
    vi.resetModules();

    const { createMarkdownPreviewPreferenceService } =
      await import('../../src/service/MarkdownPreviewPreferenceService.js');
    const service = createMarkdownPreviewPreferenceService();
    expect(service.preference.value).toEqual({
      watermarkEnabled: false,
      watermarkText: ''
    });

    service.save({
      watermarkEnabled: true,
      watermarkText: '  Internal use  '
    });
    expect(service.preference.value).toEqual({
      watermarkEnabled: true,
      watermarkText: 'Internal use'
    });
    expect(browser.setItem).toHaveBeenLastCalledWith(
      'mar.markdown-preview',
      JSON.stringify({
        watermarkEnabled: true,
        watermarkText: 'Internal use'
      })
    );

    browser.listeners.get('storage')?.({
      key: 'mar.markdown-preview',
      newValue: JSON.stringify({
        watermarkEnabled: false,
        watermarkText: 'Shared value'
      })
    });
    expect(service.preference.value).toEqual({
      watermarkEnabled: false,
      watermarkText: 'Shared value'
    });
    browser.listeners.get('storage')?.({ key: 'other-preference', newValue: null });
    expect(service.preference.value.watermarkText).toBe('Shared value');
    browser.listeners.get('storage')?.({ key: 'mar.markdown-preview', newValue: null });
    expect(service.preference.value).toEqual({
      watermarkEnabled: false,
      watermarkText: ''
    });
  });
});
