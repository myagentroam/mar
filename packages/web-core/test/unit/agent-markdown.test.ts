import { createRenderer, createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node SSR cannot execute DOMPurify; keep sanitization out of these rendering checks.
vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html
  }
}));

import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import AgentMarkdown from '../../src/view/common/AgentMarkdown.vue';
import AgentMarkdownInteractive from '../../src/view/common/AgentMarkdown.vue?unit-render';
import { TOOLTIP_SERVICE_KEY, TooltipService } from '../../src/service/tooltip-service.js';

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

  it('keeps review file line ranges in controlled previews instead of opening website routes', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const path =
      'my-agent-roam/packages/web-core/src/view/conversation/HostedConversationEntryPage.vue';
    const html = await render(`[HostedConversationEntryPage.vue](${path}#L47-L59)`);
    expect(html).toContain(`href="${path}#L47-L59"`);
    expect(html).toContain(`data-workspace-file="${path}"`);
    expect(html).toContain('data-workspace-line="47"');
    expect(html).not.toContain('target="_blank"');
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
    expect(html).toContain(
      'src="/api/workspace-image?path=output%2Fchart.png&amp;maxWidth=320&amp;maxHeight=240"'
    );
    expect(html).toContain(
      'src="/api/workspace-image?path=%2Ftmp%2Fcapture.png&amp;maxWidth=320&amp;maxHeight=240"'
    );
    expect(html).toContain('data-image-source="/api/workspace-image?path=output%2Fchart.png"');
    expect(html).toContain('src="/api/workspace-image?path=C%3A%2FUsers%2Frunner');
    expect(html).toContain('data-workspace-file="C:/Windows/Temp/note.txt"');
    expect(html).not.toContain('src="/home/runner/project');
    expect(html.match(/data-image-preview/gu)).toHaveLength(6);
    expect(html.match(/loading="lazy"/gu)).toHaveLength(6);
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

  it('preserves explicit image links without nesting preview buttons', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://console.example' } });
    const html = await render(
      '[![linked](https://example.com/linked.png)](https://example.com/article)\n\n![preview](https://example.com/preview.png)'
    );
    expect(html).toContain('href="https://example.com/article"');
    expect(html.match(/data-image-preview/gu)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*><img[^>]*alt="linked"[^>]*><\/a>/u);
    expect(html).not.toMatch(/<a[^>]*><button/u);
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
    expect(html).not.toContain(' title=');
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
    let click: ((event: MouseEvent) => void) | undefined;
    class HostNode {
      constructor(readonly type: string) {}
      querySelectorAll() {
        return [button];
      }
    }
    const renderer = createRenderer<HostNode, HostNode>({
      patchProp(_element, key, _previous, value) {
        if (key === 'onClick') click = value as (event: MouseEvent) => void;
      },
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
      labels: new Map<string, string>([['aria-label', '复制代码']]),
      getAttribute(name: string) {
        return this.labels.get(name) ?? null;
      },
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
      closest(selector: string) {
        return selector === '[data-code-copy]' ? button : null;
      }
    }
    vi.stubGlobal('Element', Target);
    const tooltipService = new TooltipService({} as Document);
    const updateTooltip = vi.spyOn(tooltipService, 'update');
    const removeTooltip = vi.spyOn(tooltipService, 'remove');
    const app = renderer.createApp({
      render: () =>
        h(AgentMarkdownInteractive, {
          content: '```js\nconst value = 1;\n```'
        })
    });
    app.use(i18n);
    app.provide(TOOLTIP_SERVICE_KEY, tooltipService);
    app.mount(new HostNode('container'));
    try {
      expect(updateTooltip).toHaveBeenLastCalledWith(button, '复制代码');
      expect(click).toBeDefined();
      click?.({
        target: new Target(),
        preventDefault: vi.fn()
      } as unknown as MouseEvent);
      expect(writeText).toHaveBeenCalledWith('const value = 1;\n');
      expect(button.dataset['copied']).toBeUndefined();
      resolveCopy?.();
      await Promise.resolve();
      expect(button.dataset['copied']).toBe('true');
      expect(button.labels.get('aria-label')).toBe('代码已复制');
      expect(updateTooltip).toHaveBeenLastCalledWith(button, '代码已复制');
      vi.advanceTimersByTime(499);
      expect(button.dataset['copied']).toBe('true');
      vi.advanceTimersByTime(1);
      expect(button.dataset['copied']).toBeUndefined();
      expect(button.labels.get('aria-label')).toBe('复制代码');
      expect(updateTooltip).toHaveBeenLastCalledWith(button, '复制代码');
      expect(button).not.toHaveProperty('title');
      click?.({
        target: new Target(),
        preventDefault: vi.fn()
      } as unknown as MouseEvent);
      expect(writeText).toHaveBeenCalledTimes(2);
    } finally {
      app.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    expect(removeTooltip).toHaveBeenCalledWith(button);
    const updatesBeforeCompletion = updateTooltip.mock.calls.length;
    resolveCopy?.();
    await Promise.resolve();
    expect(button.dataset['copied']).toBeUndefined();
    expect(updateTooltip).toHaveBeenCalledTimes(updatesBeforeCompletion);
  });
});
