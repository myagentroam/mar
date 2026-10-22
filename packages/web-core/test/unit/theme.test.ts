import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('uses the shared neutral daylight palette with accessible interactive and text colors', () => {
    const source = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const daylight = styleDeclarations(source, ':root').find((rule) => '--mar-bg-page' in rule)!;

    expect(daylight['--mar-bg-page']).toBe('#f3f6f9');
    expect(daylight['--mar-bg-panel']).toBe('#ffffff');
    expect(daylight['--mar-bg-tab-inactive']).toBe('#f1f4f7');
    expect(daylight['--mar-border-default']).toBe('#dce3ea');
    expect(daylight['--mar-color-brand']).toBe('#0a6fd8');
    expect(daylight['--mar-color-brand-text']).toBe('#135fa8');
    expect(daylight['--mar-color-brand-selected']).toBe('#e4effb');
    expect(daylight['--mar-color-accent']).toBe('#14778a');
    expect(daylight['--mar-control-color-success']).toBe('#17803d');
    expect(daylight['--mar-text-primary']).toBe('#1c2733');
    expect(daylight['--mar-text-secondary']).toBe('#47586a');
    expect(daylight['--mar-text-tertiary']).toBe('#5f7082');
    expect(daylight['--mar-text-muted']).toBe('#627386');
    expect(daylight['--mar-text-faint']).toBe('#8c9bab');
    expect(source).toContain('html.console-ui .el-message--info {');
    expect(source).toMatch(
      /html\.console-ui \.el-message__content\s*\{[^}]*white-space:\s*pre-line;[^}]*line-height:\s*1\.5;/u
    );

    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const contrast = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)];
      return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    };

    expect(contrast('#ffffff', '#0a6fd8')).toBeGreaterThanOrEqual(4.5);
    for (const foreground of ['#1c2733', '#47586a', '#5f7082', '#627386']) {
      expect(contrast(foreground, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    }
    for (const [foreground, background] of [
      ['#135fa8', '#e4effb'],
      ['#14778a', '#e8f5f7'],
      ['#17803d', '#eaf7ef'],
      ['#946200', '#fff6d6'],
      ['#c83b3b', '#fff0ee']
    ]) {
      expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses the shared blue-gray dark palette for Console surfaces and semantic accents', () => {
    const source = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const dark = styleDeclarations(source, "html.console-ui[data-theme='vscode-dark-2026']")[0]!;

    expect(dark['--mar-bg-page']).toBe('#0e1116');
    expect(dark['--mar-bg-panel']).toBe('#131922');
    expect(dark['--mar-bg-tab-inactive']).toBe('#1a2230');
    expect(dark['--mar-border-default']).toBe('#273142');
    expect(dark['--mar-color-brand']).toBe('#3093ff');
    expect(dark['--mar-color-brand-hover']).toBe('#4aa3ff');
    expect(dark['--mar-color-brand-selected']).toBe(
      'color-mix(in srgb, var(--mar-color-brand) 8%, transparent)'
    );
    expect(dark['--mar-color-accent']).toBe('#37c8ff');
    expect(dark['--mar-control-color-success']).toBe('#22c55e');
    expect(dark['--mar-text-primary']).toBe('#e8eef8');
    expect(dark['--mar-text-secondary']).toBe('#9fb0c7');
    expect(dark['--mar-text-muted']).toBe('#6d7c92');
    expect(dark['--mar-shadow-medium']).toBe('rgb(0 0 0 / 28%)');
    expect(dark['--mar-overlay-scrim']).toBe('rgb(0 0 0 / 48%)');
    expect(dark['--mar-text-neutral-control']).toBe('var(--mar-text-faint)');
    expect(source).toContain("html.console-ui[data-theme='vscode-dark-2026'] .el-message--info {");
    expect(source).toContain('--el-message-bg-color: var(--mar-bg-tab-inactive);');
  });

  it('uses rounded brand-highlight selection without tab underlines on desktop and mobile', () => {
    const readView = (path: string) =>
      readFileSync(new URL(`../../src/view/${path}`, import.meta.url), 'utf8');
    const workspaceTabs = readView('workspace/WorkspaceTabs.vue');
    const inspector = readView('workspace/WorkspaceInspector.vue');
    const terminal = readView('terminal/TerminalDock.vue');
    const terminalView = readView('terminal/TerminalTabView.vue');
    const fileTabs = readView('workspace/WorkspaceFileTabs.vue');
    const workspaceTree = readView('workspace/WorkspaceTree.vue');
    const sessionList = readView('workspace/WorkspaceSessionList.vue');

    expect(workspaceTabs).not.toContain('box-shadow: inset 0 -2px 0 var(--mar-color-brand)');
    expect(styleDeclarations(workspaceTabs, '.workspace-tab.active')[0]!['background']).toContain(
      'var(--mar-color-brand-selected)'
    );
    expect(styleDeclarations(workspaceTabs, '.workspace-tab:not(.active):hover')).toContainEqual(
      expect.objectContaining({ background: 'var(--mar-bg-tab-inactive)' })
    );
    expect(inspector).not.toContain('.inspector-tabs button.active::after');
    for (const selector of [
      '.inspector-tabs button.active',
      '.inspector-tabs button.active:hover:not(:disabled)'
    ])
      expect(styleDeclarations(inspector, selector)).toContainEqual(
        expect.objectContaining({ background: 'var(--mar-color-brand-selected)' })
      );
    expect(
      styleDeclarations(inspector, '.inspector-tabs button:not(.active):hover:not(:disabled)')
    ).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-bg-tab-inactive)',
        color: 'var(--mar-text-primary)'
      })
    );
    expect(styleDeclarations(terminal, '.terminal-tab.active')).toContainEqual(
      expect.objectContaining({ background: 'var(--mar-color-brand-selected)' })
    );
    expect(
      styleDeclarations(terminal, '.terminal-tab:not(.active):hover:not(:disabled)')
    ).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-bg-tab-inactive)',
        color: 'var(--mar-text-primary)'
      })
    );
    expect(terminal).toContain('background: var(--mar-bg-subtle);');
    expect(terminal).toContain('class="terminal-tab-close icon-button utility-control"');
    expect(terminal).toContain('<el-icon><Close /></el-icon>');
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
      expect.objectContaining({ background: 'var(--mar-color-brand-selected)' })
    );
    expect(fileTabs).toContain('background: var(--mar-bg-subtle);');
    expect(styleDeclarations(fileTabs, '.workspace-file-tab:not(.is-active):hover')).toContainEqual(
      expect.objectContaining({
        background: 'var(--mar-bg-tab-inactive)',
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
    ).toContainEqual(expect.objectContaining({ color: 'var(--mar-color-brand-text)' }));
    expect(styleDeclarations(workspaceTree, '.tree-node-row.selected .tree-node')).toContainEqual(
      expect.objectContaining({ color: 'var(--mar-color-brand-text)' })
    );
    expect(workspaceTree).toContain('margin: 2px 6px;');
    expect(sessionList).not.toContain('box-shadow: inset 2px 0 var(--mar-color-brand)');
    expect(sessionList).toContain('border-radius: var(--el-border-radius-base);');
    expect(styleDeclarations(sessionList, '.session-list li')).toContainEqual(
      expect.objectContaining({ 'border-bottom': '0', padding: '1px 6px' })
    );
    expect(terminalView).not.toContain('#17232d');
    expect(terminalView).not.toContain('#18212b');
    expect(terminalView).toContain('background: var(--mar-terminal-background);');
  });

  it('keeps conversation text readable on each theme surface without changing global colors', () => {
    const source = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
    const themes = [':root', "html.console-ui[data-theme='vscode-dark-2026']"];
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const selector of themes) {
      const declarations = styleDeclarations(source, selector).find(
        (rule) => '--mar-conversation-canvas' in rule
      )!;
      const tokens = new Map(
        Object.entries(declarations)
          .filter(([name]) => name.startsWith('--mar-conversation-'))
          .map(([name, value]) => [name.slice('--mar-conversation-'.length), value])
      );
      for (const name of [
        'canvas',
        'surface',
        'process',
        'border',
        'process-border',
        'code',
        'text',
        'muted'
      ])
        expect(tokens.get(name), name).toMatch(/^#[\da-f]{6}$/u);
      expect(tokens.get('canvas')).not.toBe(tokens.get('surface'));
      for (const foreground of ['text', 'muted']) {
        for (const background of ['canvas', 'surface', 'process', 'code']) {
          const values = [luminance(tokens.get(foreground)!), luminance(tokens.get(background)!)];
          const contrast = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
          expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
      }
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
    expect(themeColorAttributes.get('content')).toBe('#ffffff');
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
    expect(themeColorAttributes.get('content')).toBe('#ffffff');
  });
});
