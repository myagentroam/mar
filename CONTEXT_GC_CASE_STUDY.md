# Context GC in a 50-Hour Engineering Session

MAR Agent uses incremental Context GC to replace stale tool history with deterministic, recoverable projections while a session continues. This case study measures the effect in one real, long-running self-hosted session developing an AI-native ERP system.

Observed over approximately 50 hours in September 2026, the session continuously moved through feature implementation, defect investigation, code review, testing, documentation, and repeated release verification. It represents sustained day-to-day product engineering rather than a synthetic prompt or isolated benchmark.

## Result

During that period, the session made 6,364 model requests across 511 executions with a 272,000-token runtime context window. Context GC created 106 checkpoints between 75 compactions.

| Metric                                     |         Result |
| ------------------------------------------ | -------------: |
| Actual context input                       |  1.089B tokens |
| Provider-reported cache reads              | 961.67M tokens |
| Weighted cache hit rate                    |         88.29% |
| Directly reclaimed context                 |   6.01M tokens |
| Requests using a GC projection             |          3,481 |
| Estimated cumulative context input avoided | 279.25M tokens |
| Estimated context input without GC         |  1.368B tokens |
| Estimated reduction versus no GC           |         20.41% |
| Estimated effective capacity gain          |         25.64% |

The important effect is cumulative. A tool result reclaimed once remains absent from later requests until the next compaction. In this session, 6.01M tokens of direct reclamation corresponded to an estimated 279.25M tokens of repeated context input avoided, an amplification of 46.46×.

Put another way, the session completed an estimated 25.64% more continuous work per actual context token than the no-GC projection. This supports the practical positioning that a 256K-class physical context window can provide roughly 300K–400K of effective continuous working capacity in suitable long-running workloads.

## Accounting method

The calculation is performed independently within each compaction interval:

1. Start the active reduction at zero.
2. Add each GC checkpoint's incremental reclaimed-token estimate.
3. For every later model request, add the current active reduction to cumulative avoided input.
4. Reset the active reduction when a successful compaction starts a new interval.

The estimated no-GC context input is:

```text
actual context input + estimated cumulative avoided context input
```

The reduction and effective-capacity metrics use different denominators:

```text
reduction versus no GC = avoided / estimated no-GC input
effective capacity gain = avoided / actual input
```

## What the numbers mean

- Direct reclamation is a local deterministic token estimate for content removed from the active model projection.
- Input, output and cache-read totals are aggregated from provider usage.
- The 279.25M-token figure estimates repeated context input avoided; it is not additional physical context removed from storage.
- Much of the avoided input would likely have been cache reads. Token-volume reduction therefore does not imply an equal billing reduction.
- This was an observational reconstruction from one production-like session, not a paired replay with an identical no-GC run. It does not establish a universal latency, cost or quality improvement.

## Privacy

The published case contains only frozen aggregate measurements and the accounting method. Session identifiers, workspace and project names, model configuration names, host paths, credentials, exact timestamps, and message or tool contents are intentionally excluded.
