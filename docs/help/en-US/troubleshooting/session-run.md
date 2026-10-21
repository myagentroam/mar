---
title: Session Stuck in Working or Idle
lastUpdated: 2026-09-20
---

# Session Stuck in Working or Idle

1. Confirm that Node is online. A browser reconnect does not stop work that is still running on Node.
2. Open the session and wait for status and final history synchronization; refresh its Workspace session list when necessary.
3. If `Working` persists, inspect the latest tool card and local Agent state. Stop only when the work is no longer needed, then wait for `Idle`.
4. If the first message to external history returns a continuation error, do not repeatedly submit it. Check the local Agent state, service-account authentication, and Workspace path; create a new session if it cannot continue.
5. After Compact, wait for context and final state synchronization before sending again.

Restarting Node terminates active runs and queues. Use that only after reviewing the impact on every user of the Node.
