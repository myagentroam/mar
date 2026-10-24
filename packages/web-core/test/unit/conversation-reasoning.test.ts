import { describe, expect, it } from 'vitest';
import {
  normalizeReasoningPreview,
  selectReasoningPreview
} from '../../src/util/conversation-reasoning.js';

describe('Reasoning preview normalization', () => {
  it.each([
    ['\n First clause，后续内容\nSecond line', 'First clause'],
    ['检查实现。随后测试', '检查实现'],
    ['Check implementation: then test', 'Check implementation'],
    ['Check implementation; then test', 'Check implementation'],
    ['Check implementation, then test', 'Check implementation'],
    ['Check implementation. Then test', 'Check implementation'],
    ['Check implementation! Then test', 'Check implementation'],
    ['Check implementation? Then test', 'Check implementation'],
    ['检查实现：然后测试', '检查实现'],
    ['检查实现；然后测试', '检查实现'],
    ['检查实现！然后测试', '检查实现'],
    ['检查实现？然后测试', '检查实现'],
    ['Checking the context…', 'Checking the context'],
    ['Narrowing the search...', 'Narrowing the search'],
    ['First line\nLater line: detail\n\n**Later heading**', 'First line'],
    ['\r\n\tFirst\t line  \r\nMore detail', 'First line'],
    ['## **Inspect files**\nMore detail', 'Inspect files'],
    ['**Inspect files**\nMore detail', 'Inspect files'],
    ['**Inspect files**: then test', 'Inspect files'],
    ['**unfinished reasoning', '**unfinished reasoning'],
    ['Intro **emphasis** remains', 'Intro **emphasis** remains'],
    ['Inspect `SessionStore.read_state`: details', 'Inspect `SessionStore.read_state`'],
    ['Inspect `a, b: c. d` now; details', 'Inspect `a, b: c. d` now'],
    [
      'Inspect C:\\work\\src\\a.ts and /tmp/a-b_c.ts: details',
      'Inspect C:\\work\\src\\a.ts and /tmp/a-b_c.ts'
    ],
    ['Inspect https://example.com/v0.11.14: details', 'Inspect https://example.com/v0.11.14'],
    ['Inspect https://example.com. Then test', 'Inspect https://example.com'],
    ['Inspect https://example.com。随后测试', 'Inspect https://example.com'],
    [
      '检查 https://example.com/search?q=one,two；然后测试',
      '检查 https://example.com/search?q=one,two'
    ],
    ['Inspect ../src/a.ts: details', 'Inspect ../src/a.ts'],
    ['Inspect ../../src/a.ts and ./b.ts: details', 'Inspect ../../src/a.ts and ./b.ts'],
    [
      'Inspect https://example.com/search?q=one,two&next=2: details',
      'Inspect https://example.com/search?q=one,two&next=2'
    ],
    [
      'Inspect https://example.com/search?q=one,two&next=2, then test',
      'Inspect https://example.com/search?q=one,two&next=2'
    ],
    [
      'Inspect https://example.com/search?q=one,two&next=2',
      'Inspect https://example.com/search?q=one,two&next=2'
    ],
    [
      'Inspect (https://example.com/search?q=one,two); details',
      'Inspect (https://example.com/search?q=one,two)'
    ],
    ['Version 0.11.14 and 3.14 are supported', 'Version 0.11.14 and 3.14 are supported'],
    [': leading punctuation\nNext line', ': leading punctuation'],
    ['思'.repeat(120), '思'.repeat(120)],
    ['🧠'.repeat(120), '🧠'.repeat(120)]
  ])('uses the first non-empty thinking line and clause (%s)', (text, expected) => {
    expect(normalizeReasoningPreview('thinking', text, 'visible_thinking')).toEqual({
      id: 'thinking',
      text: expected,
      representation: 'visible_thinking'
    });
  });

  it('preserves explicit summary extraction and does not clause-trim summaries', () => {
    expect(
      normalizeReasoningPreview(
        'summary',
        '**Earlier**\n\n**Latest: inspect files**\nDetails',
        'summary'
      )
    ).toEqual({ id: 'summary', text: 'Latest: inspect files', representation: 'summary' });
    expect(
      normalizeReasoningPreview('summary', 'Earlier\n\nLatest, full summary\nDetails', 'summary')
        ?.text
    ).toBe('Latest, full summary');
  });

  it('leaves empty previews absent and unspecified thinking distinct from summaries', () => {
    expect(normalizeReasoningPreview('empty', ' \n\t', 'summary')).toBeUndefined();
    expect(normalizeReasoningPreview('empty', ' \n\t', 'visible_thinking')).toBeUndefined();
    expect(normalizeReasoningPreview('unknown', 'First: detail\n\nLater', undefined)).toEqual({
      id: 'unknown',
      text: 'First',
      representation: 'unspecified'
    });
  });

  it('selects the latest valid summary before thinking without changing source representation', () => {
    const earlier = normalizeReasoningPreview('earlier', 'Earlier: details', 'visible_thinking');
    const latest = normalizeReasoningPreview('latest', 'Latest: details', 'unspecified');
    const summary = normalizeReasoningPreview('summary', '**Public summary**', 'summary');
    const nextSummary = normalizeReasoningPreview('next-summary', '**Next summary**', 'summary');
    expect(selectReasoningPreview(undefined, earlier)).toBe(earlier);
    expect(selectReasoningPreview(earlier, latest)).toBe(latest);
    expect(selectReasoningPreview(latest, summary)).toBe(summary);
    expect(selectReasoningPreview(summary, latest)).toBe(summary);
    expect(selectReasoningPreview(summary, nextSummary)).toBe(nextSummary);
    expect(selectReasoningPreview(summary, undefined)).toBe(summary);
    expect(selectReasoningPreview(undefined, undefined)).toBeUndefined();
  });
});
