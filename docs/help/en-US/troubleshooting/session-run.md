---
title: Session Stuck in Working or Idle
lastUpdated: 2026-10-29
---

# Session Stuck in Working or Idle

1. Confirm that Node is online. A browser reconnect does not stop work that is still running on Node.
2. Open the session and wait for status and final history synchronization; refresh its Workspace session list when necessary.
3. If `Working` persists, inspect the latest tool card and local Agent state. Stop only when the work is no longer needed, then wait for `Idle`.
4. If the first message to external history returns a continuation error, do not repeatedly submit it. Check the local Agent state, service-account authentication, and Workspace path; create a new session if it cannot continue.
5. After Compact, wait for context and final state synchronization before sending again.

If a historical image file is missing or unreadable, MAR Agent omits that image from the model context and continues with the text. Your source files are not deleted. If the task still needs the image, attach it again or ask the Agent to read the source file again; you do not need to create a new session.

Stopping a run does not automatically execute queued messages. `Ctrl+Enter` delivers a new message with priority; depending on the Agent and current run, Node uses a gentle addition or stops before sending. See [Composer](../workbench/composer.md). Do not repeatedly refresh, stop, or resend to wake a session; wait for a clear idle or failure state and inspect the Agent logs instead.

Restarting Node affects active processes. An orderly shutdown can conditionally hand off eligible MAR Agent work and queues, but does not promise recovery of every run or after an unexpected exit. Review the impact on all Node users first; see [automatic continuation](../workbench/sessions.md#automatic-continuation-after-orderly-shutdown).
