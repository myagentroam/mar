import type { RunPerformance } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';

export function sessionPerformanceDetails(
  value: RunPerformance | undefined,
  compact = false
): string {
  if (value === undefined) return '';
  return [
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
}
