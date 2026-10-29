---
title: Context, Compact, and Plan
lastUpdated: 2026-10-29
---

# Context, Compact, and Plan

When an Agent reports context usage, Composer shows used and maximum tokens. Use `/compact` only when offered and no run is active; compaction is performed by the Agent and becomes part of its session history.

Before compacting a long conversation, preserve important decisions in files, a plan, or a clear follow-up. Wait for the operation's completion status rather than assuming a page refresh means failure. Compact does not delete the original conversation history and is not a redaction tool: review secrets, attachments, and tool output separately.

MAR Agent Context GC differs from Compact: deterministic rules reclaim stale or otherwise eligible tool content from the active context sent to later requests, while Compact organizes semantic information for continuation. Neither provides unlimited memory or guarantees that every old detail remains visible. Preserve important decisions in project files or explicit task instructions.

Tap context usage on a touchscreen to open the compact confirmation with full usage details. Compact runs only after confirmation. While compaction is unavailable, including during a run, tapping still shows full usage and the unavailable notice.

MAR Agent also supports Smart Compaction: when valid context usage is already large, the main model may request background compaction before sustained new work if prior details have low continuation value. This community capability is automatic, requires no extra setting, and does not replace fixed capacity protection. The task can continue during background generation; existing compaction status items show its lifecycle without exposing the internal summary. Temporary questions and unresolved work are not reasons to compact. Usage may remain unknown after compaction until a foreground request reports a new measurement. See [MAR Agent](../runners/mar-agent.md#dedicated-compact-model) for thresholds and limits.

Plan mode asks the Agent to analyze without making changes and produce a structured plan. Review the latest plan card; when **Implement** appears and the session can start another turn, select it to continue in the same session. The latest plan may come from an earlier turn, but older plan cards do not show this action.

OpenCode and Claude Code support `/plan`; subsequent messages are used for analysis until you leave the mode or select **Implement**. For Codex, use the plan actions actually offered on the page. If an operation is unavailable, check that the Agent is online and the session is not read-only; see [Session Troubleshooting](../troubleshooting/session-run.md).

Context values and plan capabilities come from the selected Agent. Missing values do not imply unlimited context.
