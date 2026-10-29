---
title: Statuses and Common Errors
lastUpdated: 2026-10-29
---

# Statuses and Common Errors

`Online` means Server currently has a live Node connection; `Offline` preserves registration but blocks live operations. Session `Working`, `Idle`, and `Queued` states are explained in [Sessions, Runs, and Queues](../concepts/session-run-turn.md).

Errors written in uppercase with underscores are stable diagnostic codes. Before retrying, record the code, affected Node/Workspace/session, time and timezone, displayed Server request ID, Node request ID when available, and redacted details. Use [Quick Diagnosis](../troubleshooting/quick-diagnosis.md) to correlate logs. Authentication errors require signing in again; authorization errors require ownership or a grant; timeout/offline errors require checking Node and network state. A conflict or busy error should be resolved at the named target instead of retried concurrently.

`CONVERSATION_HOSTING_STORAGE_FULL` means the filesystem containing the hosted conversation directory has reached at least 95% usage and Node rejected a new conversation after a live capacity check. Existing hosted conversations remain usable. Ask an administrator to preview and permanently clean inactive conversations from Node details, or expand/free the filesystem before retrying creation.

`CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS` means a hosted Run is still active or starting, so Node cannot safely disable hosting. Wait for the Run to finish, or have that conversation's user stop it, then retry. Disable never cancels the Run automatically.

`EXTERNAL_SESSION_ACTIVE` means the external Agent is still running and Node cannot safely continue that Session. Wait for external work to end before sending again; do not repeatedly submit the message.

`SESSION_ACTIVATION_REQUIRED` means a nonstandard direct Runner request bypassed first-message activation. Send through the Session message entry point instead of directly starting a Run for external history.

Never work around path, identity, CSRF, OAuth state, or permission errors by editing browser storage or private credentials.

`NODE_UPGRADE_PACKAGE_UNAVAILABLE` means the published npm versions cannot be queried, no stable version satisfies both the Server version ceiling and business baseline, or the Server version is invalid. Check the Server version, registry access, network, and publication status, then refresh. Supervisor receives the selected exact version, never a floating tag; see [Upgrade MyAgentRoam](../deployment/upgrade.md).
