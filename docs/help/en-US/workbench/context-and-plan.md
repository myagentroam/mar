---
title: Context, Compact, and Plan
lastUpdated: 2026-10-16
---

# Context, Compact, and Plan

When an Agent reports context usage, Composer shows used and maximum tokens. Use `/compact` only when offered and no run is active; compaction is performed by the Agent and becomes part of its session history.

MAR Agent also supports Smart Compaction: when valid context usage is already large, the main model may request background compaction before sustained new work if prior details have low continuation value. This community capability is automatic, requires no extra setting, and does not replace fixed capacity protection. The task can continue during background generation; existing compaction status items show its lifecycle without exposing the internal summary. Temporary questions and unresolved work are not reasons to compact. Usage may remain unknown after compaction until a foreground request reports a new measurement. See [MAR Agent](../runners/mar-agent.md#dedicated-compact-model) for thresholds and limits.

Plan mode asks the Agent to analyze without making changes and produce a structured plan. Review the latest plan card; when **Implement** appears and the session can start another turn, select it to continue in the same session. The latest plan may come from an earlier turn, but older plan cards do not show this action.

Context values and plan capabilities come from the selected Agent. Missing values do not imply unlimited context.
