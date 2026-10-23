import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createThemePreferenceService,
  parseStoredThemePreference,
  THEME_STORAGE_KEY
} from '../../src/service/ThemePreferenceService';

function styleDeclarations(source: string, selector: string): Record<string, string>[] {
  // Inspect declarations only; browser tests protect rendered styles and the CSS cascade.
  const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gu)];
  const styles = blocks.length ? blocks.map((match) => match[1]).join('\n') : source;
  const rules = styles.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu);
  const matches = [...rules].filter((match) =>
    match[1]!.split(',').some((value) => value.trim().replace(/\s+/gu, ' ') === selector)
  );
  expect(matches, `CSS rule: ${selector}`).not.toHaveLength(0);
  return matches.map((rule) =>
    Object.fromEntries(
      [...rule[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)].map((match) => [
        match[1]!,
        match[2]!.trim().replace(/\s+/gu, ' ')
      ])
    )
  );
}

it('shares global typography with native inputs and Element Plus without undefined font roles', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/(--mar-font-[\w-]+)\s*:/gu)].map((match) => match[1]));
  expect(css).toContain('--el-font-family: var(--mar-font-sans)');
  expect(css).toContain('--el-font-size-base: var(--mar-font-size-body)');
  expect(css).toContain('--mar-font-size-input: var(--mar-font-size-body)');
  expect(css).toContain('--mar-font-size-input: 0.875rem');
  expect(css).not.toContain('--mar-font-size-input: 1rem');
  expect(css).not.toContain('--mar-font-size-nav-label');
  expect(css).toContain('font-size: var(--mar-font-size-input)');
  const root = fileURLToPath(new URL('../../src/view/', import.meta.url));
  for (const file of readdirSync(root, {
    recursive: true,
    encoding: 'utf8',
    withFileTypes: false
  })) {
    if (!file.endsWith('.vue')) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/var\((--mar-font-[\w-]+)/gu)) {
      expect(defined.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
    }
  }
  for (const type of ['success', 'warning', 'danger', 'info']) {
    for (const suffix of ['light-3', 'light-5', 'light-7', 'light-8', 'light-9', 'dark-2']) {
      expect(css).toContain(`--el-color-${type}-${suffix}:`);
    }
  }
});

function stubBrowserEnvironment() {
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const themeColorAttributes = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name)
      },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null
    },
    querySelector: (selector: string) =>
      selector === 'meta[name="theme-color"]'
        ? {
            setAttribute: (name: string, value: string) => themeColorAttributes.set(name, value)
          }
        : null
  });
  return { storage, classes, attributes, themeColorAttributes };
}

afterEach(() => vi.unstubAllGlobals());

describe('Web theme preference', () => {
  it('loads the production stylesheet stack in the theme browser fixture', () => {
    const cssImports = (path: string) => {
      const file = new URL(path, import.meta.url);
      return [...readFileSync(file, 'utf8').matchAll(/import '([^']+\.css)'/gu)].map(
        ([, specifier]) => (specifier!.startsWith('.') ? new URL(specifier!, file).href : specifier)
      );
    };
    expect(cssImports('../e2e/custom-theme-app.ts')).toEqual(cssImports('../../src/bootstrap.ts'));
  });

  it('uses rounded neutral selection without tab underlines on desktop and mobile', () => {
    const global = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const radii = styleDeclarations(global, ':root').find(
      (rule) => '--mar-radius-selection' in rule
    )!;
    expect(radii).toMatchObject({
      '--mar-radius-marker': '4px',
      '--mar-radius-control': '6px',
      '--mar-radius-selection': '6px',
      '--mar-radius-surface': '12px'
    });
    const readView = (path: string) =>
      readFileSync(new URL(`../../src/view/${path}`, import.meta.url), 'utf8');
    const workspaceTabs = readView('workspace/WorkspaceTabs.vue');
    const inspector = readView('workspace/WorkspaceInspector.vue');
    const terminal = readView('terminal/TerminalDock.vue');
    const terminalView = readView('terminal/TerminalTabView.vue');
    const fileTabs = readView('workspace/WorkspaceFileTabs.vue');
    const workspaceTree = readView('workspace/WorkspaceTree.vue');
    const sessionList = readView('workspace/WorkspaceSessionList.vue');

    for (const [component, selector] of [
      [workspaceTabs, '.workspace-tab'],
      [fileTabs, '.workspace-file-tab'],
      [terminal, '.terminal-tab'],
      [inspector, '.inspector-tabs button'],
      [workspaceTree, '.workspace-branches > li'],
      [sessionList, '.session-row'],
      [readView('workbench/WorkbenchNavigation.vue'), '.activity-rail nav button']
    ] as const) {
      expect(styleDeclarations(component, selector)).toContainEqual(
        expect.objectContaining({ 'border-radius': 'var(--mar-radius-selection)' })
      );
    }

    expect(workspaceTabs).not.toContain('box-shadow: inset 0 -2px 0 var(--mar-color-brand)');
    expect(styleDeclarations(workspaceTabs, '.workspace-tab.active')[0]!['background']).toContain(
      'var(--mar-fill-selection)'
    );
    expect(styleDeclarations(workspaceTabs, '.workspace-tab:not(.active):hover')).toContainEqual(
      expect.objectContaining({ background: 'var(--mar-fill-row-hover)' })
    );
    expect(inspector).not.toContain('.inspector-tabs button.active::after');
    for (const selector of [
      '.inspector-tabs button.active',
      '.inspector-tabs button.active:hover:not(:disabled)'
    ])
      expect(styleDeclarations(inspector, selector)).toContainEqual(
        expect.objectContaining({ background: 'var(--mar-fill-selection)' })
      );
    expect(
      styleDeclarations(inspector, '.inspector-tabs button:not(.active):hover:not(:disabled)')
    ).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-fill-row-hover)',
        color: 'var(--mar-text-primary)'
      })
    );
    expect(styleDeclarations(terminal, '.terminal-tab.active')).toContainEqual(
      expect.objectContaining({ background: 'var(--mar-fill-selection)' })
    );
    expect(
      styleDeclarations(terminal, '.terminal-tab:not(.active):hover:not(:disabled)')
    ).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-fill-row-hover)',
        color: 'var(--mar-text-primary)'
      })
    );
    for (const [component, selector] of [
      [
        readView('workbench/WorkbenchNavigation.vue'),
        '.activity-rail nav button:hover:not(:disabled)'
      ],
      [workspaceTree, '.workspace-group-toggle:hover'],
      [workspaceTree, '.workspace-branches > li:hover'],
      [sessionList, '.session-row:hover']
    ] as const) {
      expect(styleDeclarations(component, selector)).toContainEqual(
        expect.objectContaining({ background: 'var(--mar-fill-row-hover)' })
      );
    }
    expect(terminal).toContain('background: var(--mar-bg-chrome);');
    expect(terminal).toContain('class="terminal-tab-close icon-button utility-control"');
    expect(terminal).not.toContain('role="button"');
    expect(terminal).not.toContain('>×</span');
    expect(styleDeclarations(terminal, '.admin-terminal-header')).toContainEqual(
      expect.objectContaining({
        'min-height': '0',
        flex: 'none',
        'margin-bottom': '0.45rem',
        padding: '0.7rem 0.7rem 0'
      })
    );
    expect(fileTabs).not.toContain('box-shadow: inset 0 -2px var(--mar-color-brand)');
    expect(styleDeclarations(fileTabs, '.workspace-file-tab.is-active')).toContainEqual(
      expect.objectContaining({ background: 'var(--mar-fill-selection)' })
    );
    expect(fileTabs).toContain('background: var(--mar-bg-subtle);');
    expect(styleDeclarations(fileTabs, '.workspace-file-tab:not(.is-active):hover')).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-fill-row-hover)',
        color: 'var(--mar-text-primary)'
      })
    );
    for (const selector of [
      '.workspace-file-tab-close:focus-visible',
      '.workspace-file-window-close:focus-visible'
    ])
      expect(styleDeclarations(fileTabs, selector)).toContainEqual(
        expect.objectContaining({ outline: '2px solid var(--mar-color-brand)' })
      );
    expect(styleDeclarations(fileTabs, '.workspace-file-tab-header')).toContainEqual(
      expect.objectContaining({ height: '40px', 'min-height': '40px', flex: '0 0 40px' })
    );
    expect(styleDeclarations(fileTabs, '.workspace-file-tab-list')).toContainEqual(
      expect.objectContaining({ 'align-items': 'center', gap: '4px', padding: '2px 4px' })
    );
    expect(styleDeclarations(fileTabs, '.workspace-file-tab')).toContainEqual(
      expect.objectContaining({ height: '36px', 'min-height': '36px' })
    );
    expect(
      styleDeclarations(workspaceTree, '.workspace-branches > li.selected .workspace-branch-button')
    ).toContainEqual(expect.objectContaining({ color: 'var(--mar-text-primary)' }));
    expect(styleDeclarations(workspaceTree, '.tree-node-row.selected .tree-node')).toContainEqual(
      expect.objectContaining({ color: 'var(--mar-text-primary)' })
    );
    expect(workspaceTree).toContain('margin: 2px 6px;');
    expect(sessionList).not.toContain('box-shadow: inset 2px 0 var(--mar-color-brand)');
    expect(styleDeclarations(sessionList, '.session-row')).toContainEqual(
      expect.objectContaining({ 'border-radius': 'var(--mar-radius-selection)' })
    );
    expect(styleDeclarations(sessionList, '.session-link')).toContainEqual(
      expect.objectContaining({ 'border-radius': 'inherit' })
    );
    expect(styleDeclarations(sessionList, '.session-list li')).toContainEqual(
      expect.objectContaining({ 'border-bottom': '0', padding: '2px 6px' })
    );
    expect(styleDeclarations(sessionList, '.session-list li:first-child')).toContainEqual(
      expect.objectContaining({ 'padding-top': '4px' })
    );
    expect(terminalView).not.toContain('#17232d');
    expect(terminalView).not.toContain('#18212b');
    expect(terminalView).toContain('background: var(--mar-terminal-background);');
  });

  it('keeps private headers and file actions in their owning components', () => {
    const global = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const frame = readFileSync(
      new URL('../../src/view/workspace/WorkspaceFilePageFrame.vue', import.meta.url),
      'utf8'
    );
    const header = readFileSync(
      new URL('../../src/view/conversation/ConversationHeader.vue', import.meta.url),
      'utf8'
    );
    for (const selector of [
      '.file-preview-header',
      '.mobile-preview-actions',
      '.conversation-header'
    ])
      expect(global).not.toContain(selector);
    expect(styleDeclarations(frame, '.workspace-file-page-frame-header')).toContainEqual(
      expect.objectContaining({ display: 'flex', 'justify-content': 'space-between' })
    );
    expect(styleDeclarations(frame, '.workspace-file-mobile-actions')).toContainEqual(
      expect.objectContaining({ display: 'none' })
    );
    expect(styleDeclarations(frame, '.workspace-file-mobile-actions')).toContainEqual(
      expect.objectContaining({ display: 'flex', position: 'fixed', 'border-radius': '0.75rem' })
    );
    expect(styleDeclarations(header, '.conversation-header h2')).toContainEqual(
      expect.objectContaining({ 'font-size': 'var(--mar-font-size-body)' })
    );
  });

  it('keeps theme previews, status markers and overlays on the shared radius roles', () => {
    const readView = (path: string) =>
      readFileSync(new URL(`../../src/view/${path}`, import.meta.url), 'utf8');
    const global = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const preview = readView('settings/ThemePreview.vue');
    const timeline = readView('conversation/ConversationTimeline.vue');
    for (const selector of ['.user-message', '.assistant-message', '.process'])
      expect(styleDeclarations(preview, selector)).toContainEqual(
        expect.objectContaining({ 'border-radius': 'var(--mar-radius-surface)' })
      );
    for (const selector of [
      '.task-list-status',
      '.conversation-file-change-status',
      '.conversation-error-code'
    ])
      expect(styleDeclarations(timeline, selector)).toContainEqual(
        expect.objectContaining({ 'border-radius': 'var(--mar-radius-marker)' })
      );
    const message = styleDeclarations(timeline, '.conversation-item.user_message')[0]!;
    expect(styleDeclarations(preview, '.user-message')[0]!['background']).toBe(
      message['background']
    );
    expect(styleDeclarations(preview, '.user-message')[0]!['border']).toBe(
      `1px solid ${message['border-color']}`
    );
    for (const name of ['dialog', 'popover'])
      expect(styleDeclarations(global, `html.console-ui .el-${name}`)).toContainEqual(
        expect.objectContaining({ [`--el-${name}-border-radius`]: 'var(--mar-radius-surface)' })
      );
  });

  it('uses conversation-level separators for task, tool and command details', () => {
    const timeline = readFileSync(
      new URL('../../src/view/conversation/ConversationTimeline.vue', import.meta.url),
      'utf8'
    );
    for (const [selector, edge, width] of [
      ['.task-list-items', 'border-top', '1px'],
      ['.task-list-items > li', 'border-bottom', '1px'],
      ['.conversation-tool-list', 'border-left', '2px'],
      ['.conversation-command-list', 'border-left', '2px'],
      ['.conversation-tool-detail', 'border-top', '1px'],
      ['.conversation-command-detail', 'border-top', '1px']
    ] as const) {
      expect(styleDeclarations(timeline, selector)).toContainEqual(
        expect.objectContaining({ [edge]: `${width} solid var(--mar-conversation-process-border)` })
      );
    }
  });

  it('accepts registered theme identifiers and falls back to the default dark theme for others', () => {
    expect(parseStoredThemePreference('vscode-dark-2026')).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('daylight')).toBe('daylight');
    expect(parseStoredThemePreference(null)).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('')).toBe('vscode-dark-2026');
    expect(parseStoredThemePreference('dark')).toBe('vscode-dark-2026');
  });

  it.each([null, '', 'unknown-theme', 'vscode-dark-2026'])(
    'initializes the dark theme without overwriting stored value %s',
    (stored) => {
      const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
      if (stored !== null) storage.set(THEME_STORAGE_KEY, stored);

      const service = createThemePreferenceService();

      expect(service.theme.value).toBe('vscode-dark-2026');
      expect(attributes.get('data-theme')).toBe('vscode-dark-2026');
      expect(classes.has('dark')).toBe(true);
      expect(themeColorAttributes.get('content')).toBe('#0e1116');
      expect(storage.get(THEME_STORAGE_KEY)).toBe(stored ?? undefined);
    }
  );

  it('preserves the saved light theme during initialization', () => {
    const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
    storage.set(THEME_STORAGE_KEY, 'daylight');

    const service = createThemePreferenceService();

    expect(service.theme.value).toBe('daylight');
    expect(attributes.has('data-theme')).toBe(false);
    expect(classes.has('dark')).toBe(false);
    expect(themeColorAttributes.get('content')).toBe('#f7f8fa');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
  });

  it('synchronizes the root marker and local persistence when switching themes', () => {
    const { storage, classes, attributes, themeColorAttributes } = stubBrowserEnvironment();
    const service = createThemePreferenceService();

    service.setTheme('vscode-dark-2026');
    expect(service.theme.value).toBe('vscode-dark-2026');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('vscode-dark-2026');
    expect(attributes.get('data-theme')).toBe('vscode-dark-2026');
    expect(classes.has('dark')).toBe(true);
    expect(themeColorAttributes.get('content')).toBe('#0e1116');

    service.setTheme('daylight');
    expect(service.theme.value).toBe('daylight');
    expect(storage.get(THEME_STORAGE_KEY)).toBe('daylight');
    expect(attributes.has('data-theme')).toBe(false);
    expect(classes.has('dark')).toBe(false);
    expect(themeColorAttributes.get('content')).toBe('#f7f8fa');
  });
});
