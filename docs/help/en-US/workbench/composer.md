---
title: Messages and Composer
lastUpdated: 2026-10-29
---

# Messages and Composer

Composer combines the message editor, Agent configuration, attachments, context status, queue, and send/stop actions.

Press `Enter` to send and `Shift+Enter` for a newline on desktop. During a managed run, ordinary messages are queued. `Ctrl+Enter` adds information with priority. Node decides delivery from its actual state: when MAR Agent can accept a native addition, the message appears immediately and takes effect after the complete response and tool batch without interrupting generation. Managed waits may return early without stopping background tasks; other tools still finish normally. Other Agents or incompatible configuration changes keep the stop-then-send flow. The body is marked as information received while working; when idle it sends normally. The wrapper is hidden from messages, while attachments and references keep their existing behavior. On mobile, Enter always inserts a newline and the send button submits. When you switch models, the reasoning level changes to the target model's default; you can still select another level exposed by that model.

Type `/` to open commands supported by the current Agent and, under the skills group, the skills already loaded in the current workspace. Clicking a command, or pressing Enter while the menu cursor is on its match, runs it. Unknown `/xxx` input is sent as a regular message; supported slash commands can also accept arguments, such as `/goal <objective>`. Selected skills appear as removable tags above the message body without being sent immediately. Click a tag's close control to remove it. When the message body is empty and the caret is at the start, Backspace removes selected skills from last to first. Sending supplies the selected skills as resource inputs in selection order, without displaying them in the sent message. Files and folders selected with `@` also appear as removable Composer tags and are hidden after sending; uploaded attachments still display a file list. Configuration controls are disabled when the active run requires a fixed mode. The first message to external history validates continuation automatically; a failed validation does not create a Run.

Create a phrase and prompt in **Settings → Quick Prompts**. Type `#phrase` to filter and insert the prompt body. Matching is case-insensitive: exact matches come before prefix matches, followed by substring matches; ties keep their original order. The first result is selected by default; press Enter on desktop to insert it. Selecting one replaces only the matching `#phrase`; it does not send the message or remove the remaining draft or attachments.

Pasting regular text keeps plain text only and remains undoable as one native edit with `Ctrl/Command+Z`. Text reaching either 100 lines or 10,000 characters is converted to a TXT attachment before it enters the editor, preventing large logs or code blocks from freezing the page. Conversion preserves the existing draft, and a message body is still required before sending.

Uploaded attachments that have not been sent remain available for one hour. Add them again after they expire.

During the short sending window, the input stays visible but is temporarily read-only so the next message cannot mix with the previous one. Success clears the submitted content; failure or the five-second timeout restores editing. For ordinary workspace messages, a late success removes sent attachments while preserving subsequently edited text and newly added attachments, without switching sessions. Removing an attachment while a request is in flight only changes the next draft; it does not withdraw the message already sent.

In an existing ordinary session, a timeout or unknown network outcome preserves the draft. Sending the unchanged draft again reuses the original message identity. Within its bounded in-process retention window, Node returns the original acceptance result without executing again, even if that Run has ended. After a Node restart, record eviction, or explicit history clearing/session deletion, a manual retry can still execute twice; check the session history and actual outcome first. This guarantee does not cover the first request that creates a session and is not permanent deduplication.

An idle session starts a sent message immediately and displays it in the conversation. During a run, an ordinary message first appears in the queue above the editor and enters the conversation when execution begins. Selecting Stop enters the stopping state and pauses the session queue; confirm the outcome before resuming or changing the queue.

On desktop, drag a queued message to change its order. On mobile, press and hold a queue item, then choose Move up or Move down.

While editing a queued message, press `Esc` to discard unsaved changes and exit that editor without stopping the run.

When you select **Steer** for a queued message, Node rechecks its actual state: during active work it delivers the message with priority as gentle additional information (steer); when idle it sends normally. It uses the latest saved text without adding another wrapper to an existing steer. The page still shows only the body and resources. Automatic delivery in queue order does not become steer, and special inputs such as Goal activation and automatic Goal continuation retain their existing semantics.

## Prompt Tab

Prompt Tab triggers Composer Prediction: generating a complete prompt from the conversation and your draft intent. The status bar below the editor shows idle, Generating, or Prediction ready with the relevant shortcuts and action. Generation animates unless reduced motion is requested.

An administrator first configures a model and reasoning effort under **Admin → MAR Agent Models → Advanced → Prompt Tab**. The global capability is enabled by default, but an unconfigured model never triggers a request or falls back to the conversation model. Enable **Composer Prediction** under **Settings → Appearance**. The dropdown offers **Off / On**, defaults to on when no preference is saved, and applies only to Work mode. A saved Off choice remains off. Changes apply immediately and stay in this browser; this preference is not uploaded or synchronized across browsers.

With the editor focused and the browser in the foreground, press `Tab` twice quickly (within about 300ms), or select **Generate**. An empty editor shows the next-message suggestion in its placeholder. With a draft, ghost text previews a complete new prompt based on your intent without changing the original text. Press `Tab` or select **Accept** to replace the draft, then send it yourself. Native undo restores the original draft. Cursor position and selection do not affect generation; IME composition and open Composer menus prevent requests.

Press `Tab` once while generating to cancel. `Esc` cancels prediction without stopping the Agent. A ready suggestion has a separate **Cancel** button beside **Accept**. Editing the text or cancelling clears it; moving focus, switching windows, or returning to the page does not. Expiry, resource changes, and lost permissions still invalidate suggestions. The editor always consumes plain `Tab`, even when prediction is disabled or temporarily unavailable; `Shift+Tab` keeps its original behavior.

With an empty draft, a visible and focused browser page, and Node support, the current conversation uses these automatic triggers:

- Entering the current conversation: after about one second of staying, check without requiring editor focus, whether the Agent is running or finished. Switching away cancels the pending check. If history is still loading, check once it is ready without another full delay.
- New public Agent reply: the editor must be focused when the reply arrives and still focused before generation. Replies received without editor focus are not replayed as new replies.
- Current turn ending: editor focus is not required. Background pages do not request predictions; an ending already received can be processed on returning to the foreground.
- Editor changes from unfocused to focused: check during execution or after the turn ends. Reuse a valid candidate or in-flight request covering the latest context.

Overlapping signals are coalesced and rate-limited; continuous updates do not restart the conversation-entry delay. Each entry checks once, and a different conversation does not inherit the previous conversation's request cooldown. Eligible context changes during generation retain at most one follow-up refresh without interrupting or overlapping requests. Automatic refresh preserves a still-valid candidate until the new result is ready, without changing the draft or taking focus. Existing suggestions do not block new reply or ending events. History loading establishes a baseline rather than replaying old events; focusing before history is ready does not lose the entry check. Starting another turn discards the previous queued ending, but not the current conversation's entry or focus check. Manual generation, editing and cancellation clear the pending automatic batch; the Cancel button returning focus does not immediately retry. Later eligible events can still trigger prediction. The entry delay determines when generation starts, not when a suggestion is guaranteed to appear.

All four Work-mode Runners share this capability; hosted conversations do not support Prompt Tab. You can request it while the Agent is running. Requests send the draft, current conversation, a bounded execution snapshot, and authorized Workspace user-message references to the configured model. References are not filtered by author. Node maintains bounded in-memory caches; refreshing references does not call the model. Actual model usage belongs to the requesting user as prompt-prediction usage. Review suggestions before accepting; they are not evidence that work has finished.

Each Node stores local UTC daily analysis records under `prompt-completion/` in its data directory, including input drafts, bounded context, prediction output, status, and duration. Only the current day and previous six days are retained. Records are not uploaded to Server or added to conversation history. They can contain sensitive text and should be treated as private data.

Candidates are written as your message to the Agent: a request, question, or change of emphasis, rather than the Agent reporting its own plan. Manual Generate requests one nonempty candidate even with an empty draft or a completed task; when the next step is unclear, it favors a relevant read-only follow-up or clarification. Automatic prediction may still return no suggestion. Each prediction uses one generation call. The prompt guides the user perspective and task relevance; there is no separate model review or code-based semantic filter. Node checks output structure, completeness, and bounded length and characters. Invalid or incomplete manual output is reported as a generation failure; it is not replaced with a canned suggestion. Review the candidate before accepting it.

Each request generates a fresh prediction, rather than reusing the previous suggestion. Node caches loaded reference conversations and refreshes them on use when the refresh interval expires. Conversation messages, Goals, queue changes, and run-state updates do not interrupt generation; the next request uses the updated state.

Nodes supporting this context extension can use files and diffs viewed on this page within the last three minutes, plus known Goal, pending/waiting work, and queue state. Node rechecks file access and versions; unverifiable content is omitted, and diffs contribute browsing metadata only. Viewing a resource does not authorize changes. Running tasks favor intervention suggestions; completed tasks favor next steps. Unknown state is never treated as completed.

Automatic abstention or failure silently returns to the idle state without an empty-result notice, notification, or automatic retry. Manual generation retains explicit feedback; if a Node unexpectedly returns an empty result, “No suitable prediction right now” appears briefly.

If unavailable, check personal preferences, Node compatibility and capability, model/credential access, and resource permissions. See [MAR Agent](../runners/mar-agent.md) for configuration and access details.

## Goals

### Before starting

MAR Agent, Codex, Claude Code, and OpenCode support Goals with no execution-count limit. **Entering this mode clears pending regular queue items. MAR Agent retains its current Auto / Full access setting; other Agents switch to their confirmation-free permission, which does not revert when the Goal ends or is removed.** Check the objective, directories, and permission boundaries first, and restore the desired permission manually in Composer afterward.

`/goal` uses MAR compatibility semantics, managed by the Node for all four Agents; it is distinct from native Codex Goal. The bare command waits for an objective, `/goal <objective>` sets or edits it, and `/goal --clear` removes it. Native Goal pause, resume, and budget controls are not provided; a native Goal created and completed within the current managed Codex execution also ends this Goal.

| Agent       | Goal permission    |
| ----------- | ------------------ |
| MAR Agent   | Current setting    |
| Codex       | Full access        |
| Claude Code | Bypass permissions |
| OpenCode    | Automatic approval |

### Start and inspect

1. Run `/goal` to show a pending Goal tag.
2. Send the next message as the objective. The tag disappears and the queue area shows a Goal heading and objective row. Running `/goal` again only reports that this mode is already active.
3. Hover or focus a shortened objective to read its tooltip, or select **View** for the full objective, execution count, and revision.

The first execution, or a restart after editing the objective, shows `Goal Start` followed by the full objective on the next line. Automatic continuation shows only `Goal Continue`, without repeating the objective. Working time continues accumulating during handoffs and failed-run retry waits.
A Goal's wall-clock time starts with its first objective and does not reset on edits; it includes waiting and retries, not just model or tool execution. When the Agent marks it completed or finally blocked, it receives the elapsed time through that status update and should summarize the work, verification, and remaining issues in the same turn. The subsequent summary and Run shutdown are not included in that measurement. Automatic blocking after Runner failures may leave no Agent available to summarize.

### Steer, update, and exit

| Action        | Effect                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Enter / Send  | Queues the message to run in the order received after the Goal exits and the current turn finishes; it does not steer the active Goal      |
| Ctrl+Enter    | Stops the current execution and sends with priority, preserving other queued messages and the objective                                    |
| Edit → Update | Changes the objective, stops the current execution, and immediately restarts with the revised objective; Cancel or `Esc` discards the edit |
| Remove        | Exits Goal and stops automatic continuation, but **does not stop the current execution**                                                   |
| Stop run      | Interrupts the current run and removes the Goal; no separate Remove action is needed                                                       |

Regular queued messages do not run between Goal continuation turns, during continuation preparation, or during failed-execution retry waits. They run after the Goal completes, finally blocks, or is removed, once the current turn finishes. Stopping the run still pauses the queue. To intervene immediately, use `Ctrl+Enter` or a queue item's **Execute now** action; other regular queued messages keep waiting for the Goal to exit.

Completion, three consecutive successful turns without tool activity, or final blocking exits the mode. Automatic no-progress completion stops continuation but does not prove the objective was achieved; check the Agent's results. In regular Workspaces, MAR Agent Goals can resume through an [orderly shutdown handoff](sessions.md#automatic-continuation-after-orderly-shutdown), preserving the objective, timing, and turn count. This does not cover other Agents, hosted conversations, or unexpected exits. Closing the page, removing an objective, or seeing an idle state after restart does not prove that the task completed.
After a successful Remove or Stop run, the UI shows the Node-confirmed status, wall-clock time through the action, and number of turns started. Neither action starts another Agent to produce a summary. A pending Goal without an objective has no elapsed time to report.

## Steer on mobile

Slide up from Send and release inside the Composer to submit. New and idle conversations send normally; while a run is active, the hint changes to **Release to steer** and releasing steers with the message. Only moving above the Composer switches to **Release to cancel**; move back inside to restore sending. The cancellation boundary follows the actual Composer height rather than a fixed swipe distance. Tapping, holding without sliding up, or returning to the starting position retains ordinary sending and queueing during a run. Nothing is submitted before release, and touching Send does not move focus away from the editor. Cancelling, switching Workspaces or sessions, or losing permission to send preserves the draft. Steering uses the same delivery intent as desktop `Ctrl+Enter` and does not guarantee interruption-free delivery for every Agent. You can also queue the message normally and use its **Steer** action in the queue.
