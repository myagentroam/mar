import { afterEach, describe, expect, it, vi } from 'vitest';
import { localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import { displayConversationItem } from '../../src/util/conversation-domain.js';
import {
  conversationDisplayItems,
  conversationItemLabel,
  conversationItemText
} from '../../src/util/conversation-presentation.js';
import {
  toolPresentationDetails,
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
  it('keeps every specialized call independent while ordinary tools still aggregate', () => {
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
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['item-0', 'item-6']);
    expect(
      conversationDisplayItems([
        { id: 'legacy', kind: 'tool_call', status: 'COMPLETED', payload: { toolName: 'sleep' } }
      ])[0]?.type
    ).toBe('tool_group');
  });
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
      const completed = locale === 'zh-CN' ? '已完成' : 'Completed';
      const running = locale === 'zh-CN' ? '执行中' : 'Running';
      expect(text({})).toBe(completed + ' · 原始 query');
      expect(text({ sourceCount: 0 })).toBe(
        locale === 'zh-CN'
          ? '已完成 · 原始 query · 未找到结果'
          : 'Completed · 原始 query · No results found'
      );
      expect(text({ sourceCount: 2 })).toBe(
        locale === 'zh-CN' ? '已完成 · 原始 query · 2 个来源' : 'Completed · 原始 query · 2 sources'
      );
      expect(text({ sourceCount: 2 }, 'IN_PROGRESS')).toBe(running + ' · 原始 query');
      const fetch = payload({
        kind: 'WEB_FETCH',
        requestUrl: 'https://example.com/a',
        title: '原始 Page Title'
      });
      expect(conversationItemText('tool_call', fetch, 'IN_PROGRESS')).toBe(
        running + ' · example.com'
      );
      expect(conversationItemText('tool_call', fetch, 'COMPLETED')).toBe(
        completed + ' · 原始 Page Title'
      );
      expect(
        conversationItemText('tool_call', payload({ kind: 'SKILL', name: '原始-skill' }))
      ).toBe('原始-skill');
    }
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'keeps skill and sleep captions quiet but preserves failures in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const skill = payload({ kind: 'SKILL', name: 'Original skill' });
      for (const status of ['PENDING', 'IN_PROGRESS', 'COMPLETED'])
        expect(conversationItemText('tool_call', skill, status)).toBe('Original skill');
      for (const status of ['FAILED', 'CANCELLED', 'INTERRUPTED']) {
        expect(conversationItemText('tool_call', skill, status)).toBe(
          toolPresentationStatus(status) + ' · Original skill'
        );
        expect(conversationItemText('tool_call', payload({ kind: 'SLEEP' }), status)).toBe(
          toolPresentationStatus(status)
        );
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
      'Output: Original output'
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
