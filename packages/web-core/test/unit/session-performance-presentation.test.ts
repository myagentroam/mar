import { afterEach, describe, expect, it } from 'vitest';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import { sessionPerformanceDetails } from '../../src/util/session-performance-presentation.js';

afterEach(() => localePreferenceService().setLocale('en-US'));

describe('Session performance details', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'uses the same English labels and separators in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const value = {
        runId: 'run',
        latencyMs: 6180,
        tokensPerSecond: 52.4,
        usage: {
          inputTokens: '24000',
          outputTokens: '1280',
          cacheReadTokens: '19200'
        }
      };
      expect(sessionPerformanceDetails(value)).toBe(
        'Latency: 6.18 s · TPS: 52.4\nInput: 24,000 · Output: 1,280 · Cache Hit Rate: 80.0%'
      );
      expect(sessionPerformanceDetails(value, true)).toBe('Latency: 6.18 s · TPS: 52.4');
    }
  );

  it('distinguishes unknown cache usage from a recorded zero and handles zero input', () => {
    expect(sessionPerformanceDetails({ runId: 'r', usage: { inputTokens: '100' } })).toBe(
      'Input: 100 · Output: — · Cache Hit Rate: —'
    );
    expect(
      sessionPerformanceDetails({
        runId: 'r',
        usage: { inputTokens: '100', outputTokens: '0', cacheReadTokens: '0' }
      })
    ).toBe('Input: 100 · Output: 0 · Cache Hit Rate: 0.0%');
    expect(
      sessionPerformanceDetails({ runId: 'r', usage: { inputTokens: '0', cacheReadTokens: '0' } })
    ).toContain('Cache Hit Rate: 0.0%');
  });

  it('formats exact token counts beyond the JavaScript safe integer range', () => {
    expect(
      sessionPerformanceDetails({
        runId: 'r',
        usage: { inputTokens: '9007199254740993', cacheReadTokens: '4503599627370496' }
      })
    ).toBe('Input: 9,007,199,254,740,993 · Output: — · Cache Hit Rate: 50.0%');
  });
});
