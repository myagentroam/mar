---
title: Sessions, Runs, and Message Queues
lastUpdated: 2026-09-20
---

# Sessions, Runs, and Message Queues

- A **session** is a persistent conversation that can be reopened later.
- A **run** starts when one message begins execution and ends when the Agent completes, fails, or is stopped.
- A **conversation turn** contains your message and the following Agent responses and tool records.

Only one run executes in a session at a time. Messages sent during a run enter that session's queue; different sessions may run concurrently. Stopping pauses subsequent queued messages. `Ctrl+Enter` stops the current run and prioritizes the new message.

While editing a queued message, press `Enter` to save, `Shift+Enter` or `Alt+Enter` to insert a line break, and `Ctrl+Enter` to run it immediately. Clicking **Run now** or pressing `Ctrl+Enter` while editing first saves the current editor content and then runs that message. If saving fails, the message is not run.

| Status  | Meaning                        | Suggested action             |
| ------- | ------------------------------ | ---------------------------- |
| Working | Starting, running, or stopping | Wait, inspect tools, or stop |
| Idle    | No active run                  | Send the next message        |
| Queued  | Waiting behind an active run   | Edit, remove, or wait        |

Restarting Node ends active runs, queues, and terminals. Agent history already written remains readable. Refreshing Web does not stop work still running on Node.

Next: [Create and Manage Sessions](../workbench/sessions.md).
