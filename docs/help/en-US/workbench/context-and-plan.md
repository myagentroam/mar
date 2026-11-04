---
title: Context, Compact, and Plan
lastUpdated: 2026-11-04
---

# Context, Compact, and Plan

The context indicator in Workspace sessions stays visible. Before valid usage is available, it shows a `0%` placeholder with `0 / maximum` tokens in the details. If capacity is also unknown, the details show `0 / —`; the browser does not guess model capacity. This placeholder is not a measured zero. The indicator updates when the Agent reports context usage. Use `/compact` only when offered and no run is active; compaction is performed by the Agent and becomes part of its session history.

Before compacting a long conversation, preserve important decisions in files, a plan, or a clear follow-up. Wait for the operation's completion status rather than assuming a page refresh means failure. Compact does not delete the original conversation history and is not a redaction tool: review secrets, attachments, and tool output separately.

MAR Agent Context GC differs from Compact: deterministic rules reclaim stale or otherwise eligible tool content from the active context sent to later requests, while Compact organizes semantic information for continuation. Neither provides unlimited memory or guarantees that every old detail remains visible. Preserve important decisions in project files or explicit task instructions.

The indicator details always show the GC count and reclaimed tokens. Missing statistics use the placeholder `GC: 0 · 0 tokens`; each missing value also defaults to `0` for display. This does not mean a measured zero or GC support, and does not change stored statistics. MAR Agent's actual statistics cover only the period since the latest successful Compact, or the session start before its first Compact. Tokens sum measured decreases between pre-GC and post-GC request inputs. Intervening additions affect this value; it is not an exact deletion count or billing savings. Refreshing preserves the statistics; successful Compact resets both, while failed or cancelled Compact does not. Skipped or failed GC attempts are not counted. Clear, rollback and fork use the retained session records.

Tap context usage on a touchscreen to open the compact confirmation with full usage details. Compact runs only after confirmation. While compaction is unavailable, including during a run, tapping still shows full usage and the unavailable notice.

MAR Agent also supports Smart Compaction: when valid context usage is already large, the main model may request background compaction before sustained new work if prior details have low continuation value. This community capability is automatic, requires no extra setting, and does not replace fixed capacity protection. The task can continue during background generation; existing compaction status items show its lifecycle without exposing the internal summary. Temporary questions and unresolved work are not reasons to compact. Usage may remain unknown after compaction until a foreground request reports a new measurement. See [MAR Agent](../runners/mar-agent.md#dedicated-compact-model) for thresholds and limits.

Plan mode asks the Agent to analyze without making changes and produce a structured plan. Review the latest plan card; when **Implement** appears and the session can start another turn, select it to continue in the same session. The latest plan may come from an earlier turn, but older plan cards do not show this action.

OpenCode and Claude Code support `/plan`; subsequent messages are used for analysis until you leave the mode or select **Implement**. For Codex, use the plan actions actually offered on the page. If an operation is unavailable, check that the Agent is online and the session is not read-only; see [Session Troubleshooting](../troubleshooting/session-run.md).

Context values and plan capabilities come from the selected Agent. Missing values do not imply unlimited context.
