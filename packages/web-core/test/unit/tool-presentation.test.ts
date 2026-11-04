import { afterEach, describe, expect, it, vi } from 'vitest';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { displayConversationItem } from '../../src/util/conversation-domain.js';
import { mergeConversationPayload } from '../../src/util/conversation-history.js';
import {
  conversationDisplayItems,
  conversationItemDetail,
  conversationItemLabel,
  conversationItemText
} from '../../src/util/conversation-presentation.js';
import {
  toolPresentationDetails,
  readFileDetail,
  toolPresentationReadRange,
  detailOnlyToolText,
  toolPresentationSources,
  toolPresentationStatus
} from '../../src/util/tool-presentation.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => {
  localePreferenceService().setLocale(originalLocale);
  vi.useRealTimers();
});
const payload = (toolPresentation: unknown) => ({
  toolName: 'native-tool',
  inputSummary: 'Original input',
  outputSummary: 'Original output',
  toolPresentation
});

describe('independent tool presentation', () => {
  it.each(['zh-CN', 'en-US'] as const)('keeps literal source markers unchanged in %s', (locale) => {
    localePreferenceService().setLocale(locale);
    const text = 'source ...Truncated\nsource [Truncated]';
    const detail = readFileDetail(
      {
        output: { blocks: [{ channel: 'TEXT', text }], truncation: 'SOURCE' },
        toolPresentation: {
          kind: 'READ',
          paths: ['file.ts'],
          results: [
            { path: 'file.ts', contentRange: { channel: 'TEXT', start: 0, end: text.length } }
          ]
        }
      },
      'file.ts'
    );
    expect(detail).toBe(`${text}\n\n[Truncated]`);
  });

  it('keeps actual Read ranges in the file heading and only raw content in the detail', () => {
    const value = {
      output: { blocks: [{ channel: 'TEXT', text: '  first\r\nsecond\r\n' }] },
      toolPresentation: {
        kind: 'READ',
        paths: ['file.ts'],
        results: [
          {
            path: 'file.ts',
            startLine: 3,
            endLine: 4,
            contentRange: { channel: 'TEXT', start: 0, end: 9 }
          },
          { path: 'other.ts', startLine: 10, endLine: 20 },
          {
            path: 'file.ts',
            startLine: 8,
            endLine: 8,
            contentRange: { channel: 'TEXT', start: 9, end: 17 }
          }
        ]
      }
    };
    const original = structuredClone(value);
    expect(toolPresentationReadRange(value, 'file.ts')).toBe('3–4, 8');
    expect(readFileDetail(value, 'file.ts')).toBe('  first\r\n\n\nsecond\r\n');
    expect(
      toolPresentationReadRange({ toolPresentation: { kind: 'READ', paths: ['old.ts'] } }, 'old.ts')
    ).toBe('');
    expect(
      toolPresentationReadRange({ inputSummary: '{"path":"file.ts","offset":3}' }, 'file.ts')
    ).toBe('');
    expect(value).toEqual(original);
  });
  it.each([
    { kind: 'WEB_SEARCH', query: 'documentation' },
    { kind: 'WEB_FETCH', requestUrl: 'https://example.test' },
    { kind: 'SKILL', name: 'review' },
    { kind: 'SLEEP', durationMs: 1000 },
    { kind: 'WEB_SEARCH', detailOnly: true, query: 'documentation' },
    { kind: 'WEB_FETCH', detailOnly: true, requestUrl: 'https://example.test' },
    { kind: 'IMAGE_VIEW', path: 'photo.png' },
    { kind: 'TOOL_SEARCH', query: 'files', tools: ['mcp__files'] },
    { kind: 'COMPACT_REQUEST', accepted: true }
  ])('retains the public input and its clipping notice for $kind details', (facts) => {
    localePreferenceService().setLocale('en-US');
    const value = {
      ...payload(facts),
      inputSummary: '{"query":"documentation","maxTokens":512,"limit":3}',
      inputTruncated: true
    };
    const detail = detailOnlyToolText(value) ?? toolPresentationDetails(value);
    expect(detail).toContain(`Input: ${value.inputSummary}\n[Truncated]`);
  });
  it.each(['HEAD', 'SOURCE'] as const)(
    'keeps the %s notice on the correct side of associated READ content',
    (truncation) => {
      localePreferenceService().setLocale('en-US');
      const value = {
        output: { blocks: [{ channel: 'TEXT', text: 'retained content' }], truncation },
        toolPresentation: {
          kind: 'READ',
          paths: ['file.ts'],
          results: [{ path: 'file.ts', contentRange: { channel: 'TEXT', start: 0, end: 16 } }]
        }
      };
      expect(readFileDetail(value, 'file.ts')).toBe(
        truncation === 'HEAD'
          ? '[Truncated]\n\nretained content'
          : 'retained content\n\n[Truncated]'
      );
    }
  );
  it.each(['HEAD', 'SOURCE'] as const)(
    'shows only one %s notice when selected READ content was clipped away',
    (truncation) => {
      localePreferenceService().setLocale('en-US');
      const detail = readFileDetail(
        {
          output: { blocks: [{ channel: 'TEXT', text: 'another file' }], truncation },
          toolPresentation: {
            kind: 'READ',
            paths: ['clipped.ts'],
            results: [{ path: 'clipped.ts' }]
          }
        },
        'clipped.ts'
      );
      expect(detail?.match(/\[Truncated\]/gu)).toHaveLength(1);
      expect(detail).not.toContain('clipped.ts');
      expect(detail).not.toContain('No output');
      expect(detail).not.toContain('another file');
    }
  );
  it('keeps repeated READ ranges, empty files, errors and truncated-away text distinct', () => {
    localePreferenceService().setLocale('en-US');
    const value = {
      output: { blocks: [{ channel: 'TEXT', text: 'first😀second' }], truncation: 'HEAD' },
      toolPresentation: {
        kind: 'READ',
        paths: ['a', 'b', 'c'],
        results: [
          {
            path: 'a',
            startLine: 1,
            endLine: 1,
            contentRange: { channel: 'TEXT', start: 0, end: 5 }
          },
          {
            path: 'a',
            startLine: 3,
            endLine: 3,
            contentRange: { channel: 'TEXT', start: 7, end: 13 }
          },
          { path: 'b', contentRange: { channel: 'TEXT', start: 7, end: 7 } },
          { path: 'c' },
          { path: 'd', error: { code: 'ENOENT', message: 'not found' } },
          { path: 'empty-cut', empty: true }
        ]
      }
    };
    expect(readFileDetail(value, 'a')).toContain('first');
    expect(readFileDetail(value, 'a')).toContain('second');
    expect(readFileDetail(value, 'a')).not.toContain('😀');
    expect(readFileDetail(value, 'b')).toContain('No output');
    expect(readFileDetail(value, 'c')).not.toContain('No output');
    expect(readFileDetail(value, 'd')).toContain('ENOENT: not found');
    expect(readFileDetail(value, 'empty-cut')).toContain('No output');
    expect(
      readFileDetail({ toolPresentation: { kind: 'READ', paths: ['old'] } }, 'old')
    ).toBeUndefined();
  });
  it('renders structured detail-only facts without changing outer presentation', () => {
    localePreferenceService().setLocale('en-US');
    expect(
      detailOnlyToolText(payload({ kind: 'TOOL_SEARCH', query: 'files', tools: ['mcp__files'] }))
    ).toContain('mcp__files');
    expect(
      detailOnlyToolText(payload({ kind: 'TOOL_SEARCH', query: 'none', tools: [] }))
    ).toContain('No results');
    expect(detailOnlyToolText(payload({ kind: 'COMPACT_REQUEST', accepted: true }))).toContain(
      'accepted'
    );
    expect(
      detailOnlyToolText(
        payload({
          kind: 'IMAGE_VIEW',
          path: 'photo.png',
          width: 300,
          height: 200,
          mimeType: 'image/png'
        })
      )
    ).toContain('300 × 200');
  });
  it('does not repeat structured web search sources as raw output', () => {
    const value = {
      ...payload({
        kind: 'WEB_SEARCH',
        query: 'example',
        sourcesOnly: true,
        sources: [{ url: 'https://example.com', title: 'Example' }]
      }),
      outputSummary: 'Example https://example.com'
    };
    expect(toolPresentationDetails(value)).not.toContain('Example https://example.com');
    expect(
      toolPresentationDetails({
        ...value,
        toolPresentation: {
          kind: 'WEB_SEARCH',
          query: 'example',
          sources: [{ url: 'https://example.com', title: 'Example' }]
        }
      })
    ).toContain('Example https://example.com');
  });
  it('shows truncated search output while retaining structured source links', () => {
    localePreferenceService().setLocale('en-US');
    const url = 'https://example.com/search';
    const value = {
      ...payload({
        kind: 'WEB_SEARCH',
        query: 'example',
        sources: [{ url, title: 'Example' }]
      }),
      output: {
        blocks: [
          {
            channel: 'TEXT',
            text: `Search results (truncated):\n1. Example\nURL: ${url}\nSearch snippet: Partial`
          }
        ],
        truncation: 'SOURCE'
      }
    };

    const detail = conversationItemDetail('tool_call', value);
    expect(detail).toContain('Search results (truncated):');
    expect(detail).toContain('[Truncated]');
    expect(toolPresentationSources(value)).toMatchObject([{ url, href: url, title: 'Example' }]);
  });
  it.each(['READ', 'WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP', 'GENERIC', 'SUBAGENT'])(
    'uses authoritative output across snapshots and terminal replacement for %s',
    (kind) => {
      localePreferenceService().setLocale('en-US');
      const base = {
        ...payload({ kind }),
        ...(kind === 'SUBAGENT' ? { subagentOperation: 'STATUS', subagentId: 'child' } : {})
      };
      const label = kind === 'SUBAGENT' ? 'Result' : 'Output';
      const detail = (output?: { text: string; truncated: boolean }) =>
        conversationItemDetail('tool_call', { ...base, ...(output ? { output } : {}) });
      expect(detail()).toContain(`${label}:\nOriginal output`);
      let current = mergeConversationPayload(
        base,
        { output: { text: '  live\n', truncated: false } },
        'output'
      );
      current = mergeConversationPayload(
        current,
        { output: { text: '\nnext\n', truncated: false } },
        'output'
      );
      const live = conversationItemDetail('tool_call', current);
      expect(live).toContain(`${label}:\n  live\n\nnext\n`);
      expect(live).not.toContain('Original output');
      expect(live).not.toContain('Truncated');
      current = mergeConversationPayload(
        current,
        { output: { text: '  final tail\n', truncated: true } },
        undefined
      );
      const terminal = conversationItemDetail('tool_call', current);
      expect(terminal).toContain(`${label}:\n  final tail\n\n[Truncated]`);
      expect(terminal).not.toContain('live');
      expect(terminal).not.toContain('Original output');
      const empty = detail({ text: '', truncated: false });
      expect(empty).not.toContain(`${label}:`);
      expect(empty).not.toContain('Original output');
      expect(detail({ text: '', truncated: true })).toContain('Truncated');
    }
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'preserves tool output without interpreting truncation markers or adding notices in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      for (const kind of ['READ', 'SKILL', 'WEB_FETCH', 'WEB_SEARCH', 'SLEEP']) {
        for (const output of [
          'Original output',
          '  Partial output... [tool event summary truncated]\n',
          'Partial output [truncated]\n',
          '[truncated]\nMore output follows',
          '输出已截断\nOutput truncated'
        ]) {
          const original = Object.freeze({ ...payload({ kind }), outputSummary: output });
          const detail = toolPresentationDetails({ ...original, truncated: true });
          expect(detail).toBe(toolPresentationDetails(original));
          expect(detail).toContain(output);
        }
      }
    }
  );

  it('keeps fixed-title tool rows visible even before helper facts arrive or after failure', () => {
    for (const kind of ['WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'])
      for (const status of ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'])
        expect(
          displayConversationItem({
            id: 'tool',
            kind: 'tool_call',
            status,
            payload: payload({ kind })
          })
        ).toBe(true);
    expect(
      displayConversationItem({ id: 'empty', kind: 'tool_call', status: 'COMPLETED', payload: {} })
    ).toBe(false);
  });
  it.each([
    ['zh-CN', ['网页搜索', '网页内容', '加载技能', '等待'], ['执行中', '已完成', '失败', '已取消']],
    [
      'en-US',
      ['Web search', 'Web content', 'Load skill', 'Sleep'],
      ['Running', 'Completed', 'Failed', 'Cancelled']
    ]
  ] as const)('localizes fixed titles and separate states in %s', (locale, titles, states) => {
    localePreferenceService().setLocale(locale);
    ['WEB_SEARCH', 'WEB_FETCH', 'SKILL', 'SLEEP'].forEach((kind, index) =>
      expect(conversationItemLabel('tool_call', payload({ kind }))).toBe(titles[index])
    );
    ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'].forEach((status, index) =>
      expect(toolPresentationStatus(status)).toBe(states[index])
    );
    expect(toolPresentationStatus('INTERRUPTED')).toBe(states[3]);
  });
  it('keeps calls without explicit process membership independent', () => {
    const items = [
      'ordinary-a',
      'WEB_SEARCH',
      'WEB_FETCH',
      'SKILL',
      'SLEEP',
      'WEB_SEARCH',
      'ordinary-b'
    ].map((kind, index) => ({
      id: `item-${index}`,
      kind: 'tool_call',
      status: 'COMPLETED',
      payload: kind.startsWith('ordinary') ? { toolName: kind } : payload({ kind })
    }));
    const displayed = conversationDisplayItems(items);
    expect(displayed.filter((item) => item.type === 'item')).toHaveLength(5);
    const groups = displayed.filter((item) => item.type === 'tool_group');
    expect(groups).toHaveLength(2);
    expect(groups.map((item) => item.items.map((entry) => entry.id))).toEqual([
      ['item-0'],
      ['item-6']
    ]);
    expect(
      conversationDisplayItems([
        { id: 'legacy', kind: 'tool_call', status: 'COMPLETED', payload: { toolName: 'sleep' } }
      ])[0]?.type
    ).toBe('tool_group');
  });
  it.each([
    ['zh-CN', '读取文件', 'Tool: native-tool\nInput: Original input\nOutput:\nOriginal output'],
    ['en-US', 'Read', 'Tool: native-tool\nInput: Original input\nOutput:\nOriginal output']
  ] as const)('localizes Read while preserving raw details in %s', (locale, title, details) => {
    localePreferenceService().setLocale(locale);
    const read = payload({ kind: 'READ', paths: ['src/example.ts'] });

    expect(conversationItemLabel('tool_call', read)).toBe(title);
    expect(toolPresentationDetails(read)).toBe(details);
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'deduplicates Read titles by full path without changing the original ranges in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const paths = ['src/first.ts', 'src/first.ts', 'test/first.ts'];
      const inputSummary = JSON.stringify({
        reads: [
          { path: paths[0], offset: 1, limit: 20 },
          { path: paths[1], offset: 90, limit: 10 },
          { path: paths[2] }
        ]
      });
      const read = { ...payload({ kind: 'READ', paths }), inputSummary };
      const original = structuredClone(read);
      expect(conversationItemText('tool_call', read)).toBe(
        locale === 'zh-CN' ? 'first.ts · 另 1 个文件' : 'first.ts · 1 more file'
      );
      expect(toolPresentationDetails(read)).toContain(inputSummary);
      expect(read).toEqual(original);
      expect(
        conversationItemText('tool_call', payload({ kind: 'READ', paths: paths.slice(0, 2) }))
      ).toBe('first.ts');
      expect(
        conversationItemText('tool_call', payload({ kind: 'READ', paths: ['C:\\src\\file.ts'] }))
      ).toBe('file.ts');
      expect(
        conversationItemText('tool_call', payload({ kind: 'READ', paths: ['', '目录/文件.ts'] }))
      ).toBe('文件.ts');
      expect(conversationItemText('tool_call', payload({ kind: 'READ', paths: [] }))).toBe('');
      expect(
        conversationItemText(
          'tool_call',
          payload({ kind: 'READ', paths: ['a/x.ts', 'b/y.ts', 'c/z.ts'] })
        )
      ).toBe(locale === 'zh-CN' ? 'x.ts · 另 2 个文件' : 'x.ts · 2 more files');
    }
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'preserves free text and distinguishes unknown and empty sources in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const text = (facts: object, status = 'COMPLETED') =>
        conversationItemText(
          'tool_call',
          payload({ kind: 'WEB_SEARCH', query: '原始 query', ...facts }),
          status
        );
      expect(text({})).toBe('原始 query');
      expect(text({ sourceCount: 0 })).toBe(
        locale === 'zh-CN' ? '原始 query · 未找到结果' : '原始 query · No results found'
      );
      expect(text({ sourceCount: 2 })).toBe(
        locale === 'zh-CN' ? '原始 query · 2 个来源' : '原始 query · 2 sources'
      );
      expect(text({ sourceCount: 2 }, 'IN_PROGRESS')).toBe('原始 query');
      const fetch = payload({
        kind: 'WEB_FETCH',
        requestUrl: 'https://example.com/a',
        title: '原始 Page Title'
      });
      expect(conversationItemText('tool_call', fetch, 'IN_PROGRESS')).toBe('example.com');
      expect(conversationItemText('tool_call', fetch, 'COMPLETED')).toBe('原始 Page Title');
      expect(
        conversationItemText('tool_call', payload({ kind: 'SKILL', name: '原始-skill' }))
      ).toBe('原始-skill');
    }
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'keeps skill and sleep previews separate from their status labels in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const skill = payload({ kind: 'SKILL', name: 'Original skill' });
      for (const status of ['PENDING', 'IN_PROGRESS', 'COMPLETED'])
        expect(conversationItemText('tool_call', skill, status)).toBe('Original skill');
      for (const status of ['FAILED', 'CANCELLED', 'INTERRUPTED']) {
        expect(conversationItemText('tool_call', skill, status)).toBe('Original skill');
        expect(conversationItemText('tool_call', payload({ kind: 'SLEEP' }), status)).toBe('');
      }
    }
  );
  it('shows a static local deadline from the real start and includes the date across midnight', () => {
    localePreferenceService().setLocale('en-US');
    vi.useFakeTimers();
    const base = { kind: 'SLEEP', durationMs: 1800000 };
    const waiting = (facts: object) =>
      conversationItemText('tool_call', payload({ ...base, ...facts }), 'IN_PROGRESS');
    expect(waiting({})).toBe('30 min');
    const startedAt = new Date(2026, 9, 20, 14, 5).toISOString();
    expect(waiting({ startedAt })).toBe('30 min · until about 14:35');
    vi.setSystemTime(new Date(2026, 9, 25));
    expect(waiting({ startedAt })).toBe('30 min · until about 14:35');
    expect(waiting({ startedAt: new Date(2026, 9, 20, 23, 50).toISOString() })).toBe(
      '30 min · until about 2026-10-21 00:20'
    );
    expect(
      conversationItemText('tool_call', payload({ ...base, elapsedMs: 192000 }), 'COMPLETED')
    ).toBe('Waited 3 min 12 sec');
  });
  it('keeps metadata and output in details and exposes only webpage URLs as source links', () => {
    const sources = toolPresentationSources(
      payload({
        kind: 'WEB_SEARCH',
        sources: [
          { url: 'https://example.com/page', title: '原始 title', snippet: '<plain text>' },
          { url: 'javascript:alert(1)' }
        ]
      })
    );
    expect(sources[0]).toMatchObject({
      href: 'https://example.com/page',
      host: 'example.com',
      title: '原始 title',
      snippet: '<plain text>'
    });
    expect(sources[1]?.href).toBeUndefined();
    localePreferenceService().setLocale('en-US');
    expect(toolPresentationDetails(payload({ kind: 'SKILL', name: 'skill' }))).toContain(
      'Output:\nOriginal output'
    );
    expect(
      toolPresentationDetails(
        payload({
          kind: 'SLEEP',
          durationMs: 1800000,
          elapsedMs: 192000,
          wakeReason: 'subagent_message'
        })
      )
    ).toContain('Wake reason: New public subagent message');
  });
});
