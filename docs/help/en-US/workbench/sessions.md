---
title: Create and Manage Sessions
lastUpdated: 2026-10-21
---

# Create and Manage Sessions

A regular work session must execute in the selected Workspace's valid root or a subdirectory. An independently registered Git worktree uses its own Workspace. Node rejects new execution if the directory disappears, the registered root is replaced, or a link escapes the Workspace; it does not silently switch directories. If queued messages are paused for this reason, restore a valid directory and use **Resume** in the queue. Messages and attachments are retained and can still be removed through the existing queue controls. This check does not make work mode a host filesystem sandbox or change hosted-conversation isolation.

Select **New Session** to prepare an Agent, model, reasoning level, and permission mode before the first message. A session is created only when that message is accepted.

The session list initially loads up to 30 sessions. Choose **Load more** to read up to 30 additional sessions at a time.

Use the session list to reopen, rename, pin, reorder, or delete sessions. On supported Nodes, title search is executed by Node against the selected Workspace's native Agent sessions, so it can find sessions that have not been loaded into the browser. Clear the search to restore the normal list. Search and pagination stay within the selected Workspace. Deleting removes the native Agent session record and cannot be undone; it does not delete Workspace files.

Working sessions hide Delete. If a session starts working during deletion confirmation, the operation is not submitted. Rename and Pin remain available.

On supported Nodes, choose **Session Prompt** from an existing session's More menu to save multiline instructions of up to 20,000 characters. Leave it blank and save to clear it. The setting belongs only to that session and survives reopening or a Node restart. It is appended after the sender's shared and Agent-specific personal instructions, without replacing account settings or appearing as an ordinary message.

Changes do not interrupt the current execution. They apply from the next execution, including queued messages, Goal continuation, and messages sent to that session through marctl. marctl has no prompt-editing command. Clearing stops future injection; it does not remove old instructions already in the Agent's conversation history. Start a new session if you need to isolate old instructions completely. Hosted conversations do not offer this setting.

Sessions discovered from an external Agent appear normally. Their first message automatically validates and activates a safe continuation path; if validation fails, no Run is created.

The first session load after a Node restart waits for native Agent discovery. Sessions can appear in separate batches as each Agent finishes; a slower Agent does not delay sessions already discovered. Custom titles are preserved when the corresponding session is found, rather than showing undiscovered historical sessions as new sessions first.

## Clean up sessions

Choose **Clean up sessions** from the current Workspace session list's More menu, enter 1–365 days (30 by default), and confirm. Sessions whose activity predates the selected cutoff and sessions with unknown activity times, shown as `—`, are included. Unknown activity times are included regardless of the number of days. Pinned, running, queued, restarting, or currently viewed sessions are kept. Internal records without a discovered native session are removed only after an available Agent confirms the native session no longer exists.

Cleanup permanently deletes matching native sessions and cannot be undone; it does not delete Workspace files. The dialog shows the actual deleted, skipped, and failed counts, including deletions by Agent.

## Share a work session

Choose **Share conversation** from a regular work session's More menu. Expiration is optional; leaving it blank creates a permanent link. Creation shows share text containing the link and a random six-digit password. Choose **Copy** to copy the entire text. Existing records appear below; you can copy the same complete share text at any time, open their links, or delete them. For older records without a recoverable password, enter the original password once when copying. After verification, future copies work directly; the original link and password remain unchanged.

The header shows the session title and Workspace name. Visitors enter the password to open a standalone chat without a Console account. Access credentials, the anonymous visitor identity, and the name requested before the first message are saved in that browser and restored after refresh or reopening. The Participants panel lists the sharer first, followed by participants viewing any share link for the same session. Anonymous identity and name are shared across links in the same browser. Use the edit button beside your own visitor name to change it across open share pages. Canceling leaves the name unchanged and does not send a message. Visitor names match message authors and are never merged or hidden by Console sign-in; unnamed visitors appear anonymously. The fixed sharer entry shows the account nickname, falling back to the username. The sharer’s green dot appears only while they have a share page open and disappears when their last page closes. Display names do not grant authorization.

Visitors see the original session's entire history and future messages. They use its Agent and settings as the sharer, including messages, attachments, file and skill references, queuing, insertion, and interruption. Concurrent control uses the same shared state and mutual exclusion as opening the session in multiple browsers. The share page hides the model, reasoning effort, access mode, and context usage and its tooltip. There is no input prediction or Workspace management area. File links still open readonly previews, including separate file windows and Markdown or HTML rendering. Readonly viewing does not change executable HTML behavior or its existing warnings.

**Give the link and password only to people you trust.** Signing out as the sharer does not revoke a link; delete its record to stop access. Deletion or expiration immediately disables that link's chat pages and rejects further reads and messages, without stopping already accepted tasks or retracting content visitors have read. Other links and the original Console remain available.

## Automatic continuation after orderly shutdown

In regular Workspaces, MAR Agent can continue after Node receives `SIGTERM` or `SIGINT`, finishes an orderly shutdown, and starts again. A later manual start after a normal stop also qualifies. After reconnecting to Server, Node rechecks current user and model authorization before restoring unfinished work, Goals, and the message queue in the same native session. A previously paused queue stays paused. New messages and queue changes are temporarily blocked for that session during recovery.

Ordinary runs show a “System restart continuation” history entry, not a message attributed to manual user input. An active Goal gets one Goal continuation without an additional ordinary continuation. The prompt asks the Agent to inspect the current state after a system restart before continuing. Old tool processes, terminals, approvals, questions, and background cells are not restored, and external actions are not guaranteed to happen exactly once. Queued inputs are prepared again in their original order, including their attachments; old attachment preview URLs are not guaranteed to remain valid.

Unexpected exits, forced kills, power loss, failed handoffs, other Agents, hosted conversations, and administrator-controlled upgrades are excluded. Lost access, unavailable models, or inputs that cannot be rebuilt never bypass validation; check Node diagnostics and take over manually. A handoff is consumed once, not retried on every startup.

## Navigation and scheduled tasks

Workspace tabs follow the [unread, active-task, then last-session priority](navigation.md); an already open target keeps its reading position. Clicking the selected Workspace tree entry, or selecting the current session again from the session list or Quick Open, does not refresh content or change your reading position. Repeated selections also leave an in-progress load alone. Use the corresponding refresh action when you need updated data.

Choose **Scheduled task** from a session's More menu and enter a task prompt. If no task exists, the dialog shows **Not configured** with the enable switch off; repeat and time values are only unsaved form defaults. Enable the task and save to allow automatic execution. Simple mode uses a time picker for hourly, daily, or weekly schedules; Cron mode accepts a standard five-field expression with numbers, ranges, lists, and steps. The task runs in the Node time zone; no time zone setting is needed. The dialog shows the notification recipient by nickname or account name. Saving a task makes you both its execution identity and notification recipient. You can enable terminal run notifications (off by default). Enabling a task pins the session and shows a clock in the list. Pausing or deleting the task leaves the pin in place. The dialog shows the next run, recent results, and proposed changes. Recent results are shown in pages of 10; changing pages preserves unsaved task edits.

Node starts scheduled runs in the same session as the last user to save the task, using the session's current Runner, model, and permission settings. A busy session, Node restart, unavailable Server, or lost access for that user skips the occurrence without a catch-up run. The current notification recipient receives skipped or failed occurrence alerts; enabling terminal notifications also reports completed runs without duplicating failure alerts. Recent runs remain visible to their initiating user, subject to access, even if someone edits the task later. Scheduled runs automatically approve tool permission requests, including third-party MCP tools; questions requiring user input still need an answer. Every regular Workspace conversation loads the MAR scheduled task MCP, so a new conversation can create its own task and manual chats can change that task's prompt or time. Other users' MCP changes require the last editor's confirmation in the dialog. The Workspace session list labels it “Injected during execution” under “Loaded MCP”; it is not an MCP you need to install. This MCP manages only the current MyAgentRoam session's MAR scheduled task; it does not manage repository cron jobs, CI schedules, or other projects' schedulers.
