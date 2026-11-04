import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationItem } from '../../src/model/workbench.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import ConversationToolDetail from '../../src/view/conversation/tool-detail/ConversationToolDetail.vue';
import { toolPresentation, toolPresentationTitle } from '../../src/util/tool-presentation.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

async function render(payload: Record<string, unknown>, extra: Partial<ConversationItem> = {}) {
  const item: ConversationItem = {
    id: 'web-detail',
    kind: 'tool_call',
    status: 'COMPLETED',
    payload,
    ...extra
  };
  const app = createSSRApp({ render: () => h(ConversationToolDetail, { item }) });
  app.use(i18n);
  app.directive('tooltip', { getSSRProps: () => ({}) });
  return renderToString(app);
}

describe('Web tool details', () => {
  it.each(['WEB_SEARCH', 'WEB_FETCH'] as const)(
    'uses structured %s detail-only facts without promoting the outer presentation',
    async (kind) => {
      const payload = {
        toolName: 'NativeWebTool',
        inputSummary: '{"unused":"copy-only input"}',
        outputSummary: 'Native public output',
        toolPresentation: {
          kind,
          detailOnly: true,
          ...(kind === 'WEB_SEARCH'
            ? { query: 'Native query', sources: [{ url: 'https://example.com/source' }] }
            : { requestUrl: 'https://example.com/request' })
        }
      };
      expect(toolPresentation(payload)).toBeUndefined();
      expect(toolPresentationTitle(payload)).toBe('');
      const html = await render(payload);
      expect(html).toContain('web-detail');
      if (kind === 'WEB_SEARCH') expect(html).not.toContain('Native public output');
      else expect(html).toContain('Native public output');
      expect(html).not.toContain('copy-only input');
      expect(html).toContain(
        kind === 'WEB_SEARCH'
          ? 'href="https://example.com/source"'
          : 'href="https://example.com/request"'
      );
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'shows safe search sources without input JSON or redundant output in %s',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const html = await render({
        toolName: 'web_search',
        inputSummary: '{"query":"original input"}',
        outputSummary: 'Redundant source output',
        toolPresentation: {
          kind: 'WEB_SEARCH',
          query: 'original query',
          sourcesOnly: true,
          sources: [
            { url: 'https://example.com/docs', title: 'Documentation', snippet: '<plain summary>' },
            { url: 'https://example.com/only-url' },
            { url: 'javascript:alert(1)', title: '<unsafe title>' }
          ]
        }
      });
      expect(html).toContain(locale === 'en-US' ? 'web_search · Search' : 'web_search · 搜索');
      expect(html).toContain(locale === 'en-US' ? 'Query:' : '查询:');
      expect(html).toContain(locale === 'en-US' ? 'Sources:' : '来源:');
      expect(html).toContain('original query');
      expect(html).toContain('href="https://example.com/docs"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('&lt;plain summary&gt;');
      expect(html).toContain('&lt;unsafe title&gt;');
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain('https://example.com/only-url');
      expect(html).not.toContain('original input');
      expect(html).not.toContain('Redundant source output');
    }
  );

  it.each(['HEAD', 'SOURCE'] as const)(
    'hides raw search output while retaining source links and %s truncation',
    async (truncation) => {
      const text = '{"sources":[{"url":"https://extra.test"}],"extra":"preserve me"}';
      const html = await render({
        toolName: 'web_search',
        output: { blocks: [{ channel: 'TEXT', text }], truncation },
        toolPresentation: { kind: 'WEB_SEARCH', sources: [{ url: 'https://example.com' }] }
      });
      expect(html).not.toContain('preserve me');
      expect(html).not.toContain('Output:');
      expect(html).toContain('href="https://example.com/"');
      expect(html).not.toContain('href="https://extra.test');
      expect(html).toContain('[Truncated]');
    }
  );

  it('distinguishes explicit empty results from absent source facts', async () => {
    localePreferenceService().setLocale('en-US');
    const empty = await render({
      toolPresentation: { kind: 'WEB_SEARCH', sourcesOnly: true, sources: [] }
    });
    expect(empty).toContain('No results');
    const unknown = await render({ toolPresentation: { kind: 'WEB_SEARCH' } });
    expect(unknown).not.toContain('No results');
    expect(unknown).not.toContain('Sources:');
  });

  it('shows page title and content with one URL and preserves line breaks', async () => {
    const html = await render({
      toolName: 'web_search',
      inputSummary: '{"type":"open_page","url":"https://example.com/page"}',
      output: { blocks: [{ channel: 'TEXT', text: '  First line\n\nNext <paragraph>' }] },
      toolPresentation: {
        kind: 'WEB_FETCH',
        title: 'Original title',
        requestUrl: 'https://example.com/page',
        url: 'https://example.com/page',
        mode: 'browser',
        status: 200
      }
    });
    expect(html).toContain('web_search · Web content');
    expect(html).toContain('Original title');
    expect(html).toContain('Content:');
    expect(html).toContain('  First line\n\nNext &lt;paragraph&gt;');
    expect(html.match(/href="https:\/\/example.com\/page"/gu)).toHaveLength(1);
    expect(html).not.toContain('From:');
    expect(html).not.toContain('open_page');
    expect(html).toContain('200');
    expect(html).toContain('browser');
  });

  it('shows redirect origin but never invents content, titles, or links from input', async () => {
    const redirected = await render({
      toolPresentation: {
        kind: 'WEB_FETCH',
        requestUrl: 'https://old.test',
        url: 'https://new.test'
      }
    });
    expect(redirected).toContain('From:');
    expect(redirected).toContain('href="https://old.test/"');
    expect(redirected).toContain('href="https://new.test/"');
    expect(redirected).not.toContain('Content:');
    const missing = await render({
      inputSummary: '{"url":"https://hidden.test"}',
      toolPresentation: { kind: 'WEB_FETCH', url: 'javascript:alert(1)' }
    });
    expect(missing).toContain('javascript:alert(1)');
    expect(missing).not.toContain('href="javascript:');
    expect(missing).not.toContain('hidden.test');
  });

  it('does not present URL normalization as a redirect', async () => {
    const html = await render({
      toolPresentation: {
        kind: 'WEB_FETCH',
        requestUrl: 'https://example.com',
        url: 'https://example.com/'
      }
    });
    expect(html).not.toContain('From:');
    expect(html.match(/href="https:\/\/example.com\/"/gu)).toHaveLength(1);
  });

  it('does not fall back to raw output when structured sources are absent', async () => {
    const html = await render({
      outputSummary: 'Only available public output',
      toolPresentation: { kind: 'WEB_SEARCH', sourcesOnly: true }
    });
    expect(html).not.toContain('Only available public output');
    expect(html).not.toContain('Output:');
    expect(html).not.toContain('No results');
  });

  it('keeps structured search errors visible without displaying raw output', async () => {
    const html = await render(
      {
        outputSummary: 'Raw provider response',
        errorCode: 'SEARCH_FAILED',
        errorMessage: 'Search provider unavailable',
        toolPresentation: { kind: 'WEB_SEARCH', query: 'documentation' }
      },
      { status: 'FAILED' }
    );
    expect(html).toContain('documentation');
    expect(html).toContain('SEARCH_FAILED');
    expect(html).toContain('Search provider unavailable');
    expect(html).not.toContain('Raw provider response');
    expect(html).not.toContain('No results');
  });

  it('keeps failure and permission facts in specialized details and honors explicit empty output', async () => {
    const html = await render(
      {
        toolName: 'web_fetch',
        outputSummary: 'Stale page body',
        output: { blocks: [] },
        errorCode: 'FETCH_FAILED',
        errorMessage: 'Original failure',
        toolPresentation: { kind: 'WEB_FETCH' }
      },
      {
        status: 'DECLINED',
        permissionStop: {
          reason: 'Not authorized',
          action: 'deny',
          source: {
            sessionId: 'session',
            executionId: 'execution',
            callId: 'call',
            toolName: 'web_fetch'
          }
        }
      }
    );
    expect(html).toContain('FETCH_FAILED');
    expect(html).toContain('Original failure');
    expect(html).toContain('Not authorized');
    expect(html).not.toContain('Stale page body');
    expect(html).not.toContain('Content:');
  });
});
