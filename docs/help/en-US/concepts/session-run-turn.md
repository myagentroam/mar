---
title: Sessions, Runs, and Message Queues
lastUpdated: 2026-10-29
---

# Sessions, Runs, and Message Queues

- A **session** is a persistent conversation that can be reopened later.
- A **run** starts when one message begins execution and ends when the Agent completes, fails, or is stopped.
- A **conversation turn** contains your message and the following Agent responses and tool records.

Only one run executes in a session at a time. Messages sent during a run enter that session's queue; different sessions may run concurrently. Stopping pauses subsequent queued messages. `Ctrl+Enter` prioritizes a message; delivery depends on the Agent and execution state. MAR Agent may accept a native steer at a safe boundary, while other situations may stop the current run first. See [Composer](../workbench/composer.md).

While editing a queued message, press `Enter` to save, `Shift+Enter` or `Alt+Enter` to insert a line break, and `Ctrl+Enter` to run it immediately. Clicking **Run now** or pressing `Ctrl+Enter` while editing first saves the current editor content and then runs that message. If saving fails, the message is not run.

| Status  | Meaning                        | Suggested action             |
| ------- | ------------------------------ | ---------------------------- |
| Working | Starting, running, or stopping | Wait, inspect tools, or stop |
| Idle    | No active run                  | Send the next message        |
| Queued  | Waiting behind an active run   | Edit, remove, or wait        |

Restarting Node ends active processes and terminals, while Agent history already written remains readable. An orderly shutdown can conditionally hand off unfinished MAR Agent work, Goals, and queues in regular Workspaces; recovery after abnormal exit or from an arbitrary backup is not guaranteed. See [session recovery](../workbench/sessions.md#automatic-continuation-after-orderly-shutdown). Refreshing Web does not stop work still running on Node.

Next: [Create and Manage Sessions](../workbench/sessions.md).
