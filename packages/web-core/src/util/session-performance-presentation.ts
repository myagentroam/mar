import type { RunPerformance } from '@myagentroam/protocol';
import { currentLocale, translate } from '../service/locale-preference-service.js';
import { cacheHitRate } from './usage-statistics-presentation.js';

export function sessionPerformanceDetails(
  value: RunPerformance | undefined,
  compact = false
): string {
  if (value === undefined) return '';
  const timing = [
    ...(value.latencyMs === undefined
      ? []
      : [
          translate('generated.conversationTimeline.modelResponseLatency', {
            value:
              value.latencyMs < 1_000
                ? `${value.latencyMs} ms`
                : `${(value.latencyMs / 1_000).toFixed(value.latencyMs < 10_000 ? 2 : 1)} s`
          })
        ]),
    ...(value.tokensPerSecond === undefined
      ? []
      : [
          translate(
            compact
              ? 'generated.conversationTimeline.compactOutputTps'
              : 'generated.conversationTimeline.providerOutputTps',
            {
              value: value.tokensPerSecond.toFixed(1)
            }
          )
        ])
  ].join(' · ');
  if (compact || value.usage === undefined) return timing;
  const usage = value.usage;
  const count = (tokens: string | undefined) =>
    tokens === undefined ? '—' : new Intl.NumberFormat(currentLocale()).format(BigInt(tokens));
  const rate =
    usage.inputTokens === undefined || usage.cacheReadTokens === undefined
      ? '—'
      : cacheHitRate(usage.cacheReadTokens, usage.inputTokens, currentLocale(), 1);
  return [
    timing,
    [
      translate('generated.conversationTimeline.performanceInput', {
        value: count(usage.inputTokens)
      }),
      translate('generated.conversationTimeline.performanceOutput', {
        value: count(usage.outputTokens)
      }),
      translate('generated.conversationTimeline.performanceCacheHitRate', { value: rate })
    ].join(' · ')
  ]
    .filter(Boolean)
    .join('\n');
}
