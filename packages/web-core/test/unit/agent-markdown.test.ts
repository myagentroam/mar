import { createRenderer, createSSRApp, h, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node SSR cannot execute DOMPurify; keep sanitization out of these rendering checks.
vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html
  }
}));

import { i18n, localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';

const originalLocale = localePreferenceService().locale.value;

async function render(content: string): Promise<string> {
  const app = createSSRApp({ render: () => h(AgentMarkdown, { content }) });
  app.use(i18n);
  return renderToString(app);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

describe('AgentMarkdown workspace images', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders file hash lines as controlled preview links in a Windows Workspace', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const app = createSSRApp({
      render: () =>
        h(AgentMarkdown, {
          content:
            '[SDK](docs/design/SDK.md#L25) [external](https://other.example/docs/guide.md#L25)',
          workspaceRoot: 'E:/project'
        })
    });
    app.use(i18n);
    const html = await renderToString(app);
    expect(html).toContain('data-workspace-file="docs/design/SDK.md"');
    expect(html).toContain('data-workspace-line="25"');
    expect(html.match(/data-workspace-file=/gu)).toHaveLength(1);
    expect(html).toContain(
      'href="https://other.example/docs/guide.md#L25" target="_blank" rel="noopener noreferrer"'
    );
  });

  it('loads workspace, temporary, and external absolute file images through the controlled file response', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const imageResourceUrl = vi.fn(
      (path: string) => `/api/workspace-image?path=${encodeURIComponent(path)}`
    );
    const content = [
      '![workspace](/home/runner/project/output/chart.png)',
      '![relative](output/chart.png)',
      '![temporary](/tmp/capture.png)',
      '![sandbox](sandbox:/tmp/other.png)',
      '![generated](/home/runner/.mar/agent/sessions/session-id/generated_images/image.png)',
      '![windows](C:/Users/runner/AppData/Local/Temp/capture.png)',
      '[temporary file](C:/Windows/Temp/note.txt)'
    ].join('\n\n');
    const app = createSSRApp({
      render: () =>
        h(AgentMarkdown, {
          content,
          workspaceRoot: '/home/runner/project',
          imageResourceUrl
        })
    });
    app.use(i18n);

    const html = await renderToString(app);
    expect(imageResourceUrl.mock.calls.map(([path]) => path)).toEqual([
      'output/chart.png',
      'output/chart.png',
      '/tmp/capture.png',
      '/tmp/other.png',
      '/home/runner/.mar/agent/sessions/session-id/generated_images/image.png',
      'C:/Users/runner/AppData/Local/Temp/capture.png'
    ]);
    expect(html).toContain('src="/api/workspace-image?path=output%2Fchart.png"');
    expect(html).toContain('src="/api/workspace-image?path=%2Ftmp%2Fcapture.png"');
    expect(html).toContain('src="/api/workspace-image?path=C%3A%2FUsers%2Frunner');
    expect(html).toContain('data-workspace-file="C:/Windows/Temp/note.txt"');
    expect(html).not.toContain('src="/home/runner/project');
  });

  it('keeps external image URLs outside the workspace file response', async () => {
    const imageResourceUrl = vi.fn((path: string) => `/api/workspace-image?path=${path}`);
    const app = createSSRApp({
      render: () =>
        h(AgentMarkdown, {
          content: '![external](https://example.com/chart.png)',
          workspaceRoot: '/home/runner/project',
          imageResourceUrl
        })
    });
    app.use(i18n);

    expect(await renderToString(app)).toContain('src="https://example.com/chart.png"');
    expect(imageResourceUrl).not.toHaveBeenCalled();
  });
});

describe('AgentMarkdown code block copy button', () => {
  beforeEach(() => {
    localePreferenceService().setLocale('zh-CN');
  });

  afterEach(() => {
    localePreferenceService().setLocale(originalLocale);
  });

  it('wraps fenced code blocks with a bottom-right copy button and preserves code text', async () => {
    const html = await render('说明：\n\n```js\nconst value = 1;\n```\n\n行内 `code`。');

    expect(html).toContain('class="agent-markdown-code"');
    expect(html).toContain('data-code-block');
    expect(html).toContain('data-code-copy');
    expect(html).toContain('agent-markdown-code-copy icon-button utility-control');
    expect(html).toContain('agent-markdown-code-icon--check');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('title="复制代码"');
    expect(html.match(/data-code-copy/gu)).toHaveLength(1);
    expect(stripTags(html)).toContain('const value = 1;');
  });

  it('adds a copy button for fences without a known highlight language', async () => {
    const html = await render('```unknownlang\nplain text\n```');

    expect(html.match(/data-code-copy/gu)).toHaveLength(1);
    expect(stripTags(html)).toContain('plain text');
  });

  it('does not add a copy button for inline code', async () => {
    const html = await render('行内 `code` 没有按钮。');

    expect(html).not.toContain('data-code-copy');
  });

  it('localizes the copy button label', async () => {
    localePreferenceService().setLocale('en-US');
    const html = await render('```js\nconst a = 1;\n```');

    expect(html).toContain('aria-label="Copy code"');
  });

  it('shows a check for 500ms only after code reaches the clipboard', async () => {
    vi.useFakeTimers();
    class HostNode {
      constructor(readonly type: string) {}
    }
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp() {},
      insert() {},
      remove() {},
      createElement: (type) => new HostNode(type),
      createText: () => new HostNode('#text'),
      createComment: () => new HostNode('#comment'),
      setText() {},
      setElementText() {},
      parentNode: () => null,
      nextSibling: () => null
    });
    let resolveCopy: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        })
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const button = {
      dataset: {} as Record<string, string>,
      title: '',
      labels: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        this.labels.set(name, value);
      },
      closest(selector: string) {
        return selector === '[data-code-block]'
          ? { querySelector: () => ({ textContent: 'const value = 1;\n' }) }
          : null;
      }
    };
    class Target {
      closest() {
        return button;
      }
    }
    vi.stubGlobal('Element', Target);
    let setupState: Record<string, unknown> | undefined;
    const app = renderer.createApp({
      render: () =>
        h(AgentMarkdown, {
          content: '```js\nconst value = 1;\n```',
          onVnodeMounted: (vnode) => {
            setupState = (
              vnode.component as unknown as { readonly setupState: Record<string, unknown> } | null
            )?.setupState;
          }
        })
    });
    app.use(i18n);
    app.config.warnHandler = () => {};
    app.provide(ssrContextKey, { modules: new Set<string>() });
    app.mount(new HostNode('container'));
    try {
      const copy = setupState?.['onCopyClick'] as (event: MouseEvent) => Promise<void>;
      const pending = copy({
        target: new Target(),
        preventDefault: vi.fn()
      } as unknown as MouseEvent);
      expect(writeText).toHaveBeenCalledWith('const value = 1;\n');
      expect(button.dataset['copied']).toBeUndefined();
      resolveCopy?.();
      await pending;
      expect(button.dataset['copied']).toBe('true');
      expect(button.labels.get('aria-label')).toBe('代码已复制');
      vi.advanceTimersByTime(499);
      expect(button.dataset['copied']).toBe('true');
      vi.advanceTimersByTime(1);
      expect(button.dataset['copied']).toBeUndefined();
      expect(button.labels.get('aria-label')).toBe('复制代码');
    } finally {
      app.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
