---
title: Start a Conversation from a Template
lastUpdated: 2026-10-24
---

# Start a Conversation from a Template

**Conversation** mode creates and continues conversations from templates that an administrator published and granted to you. The target Linux Node hosts each conversation with separate persistent storage and a Bubblewrap isolation environment. Each run receives a temporary virtual HOME that contains no host or session-storage content. The template provides a complete read-only Workspace image and controls models, MCP servers, network mode, and quotas.

## Create a conversation

1. Open **Chat** from the main menu to enter Conversation mode. The entry is always visible and does not require you to select or receive access to any Node or Workspace.
2. If an existing conversation is open, select **+ New chat** above the history search field to show the temporary Composer start area in the center. The page does not open a dialog.
3. Select a published template granted to your current organization or one of its ancestors from the Composer toolbar. A template grant is sufficient to create and continue your own hosted conversations; it does not also grant access to the hosting Node, source Workspace, files, or terminal. A grant to the root organization makes the template available to everyone in the enterprise. This browser remembers the most recently selected template and selects it by default while it remains in the current catalog.
4. If no remembered selection can be restored and only one template is available, the page may preselect that template but never creates a conversation automatically. Review the template name, then explicitly send a message or attachment. The page creates the conversation, uploads any draft attachments, and sends the first message in that order.
5. If the creation response is interrupted, retry directly. Unless you switch templates or reload the catalog, the retry remains part of the same creation intent and does not create a duplicate.

Creation binds the template version available at that time. Later draft edits do not affect the conversation, and publishing a new version does not switch it immediately. Before each new Run, Node queries and fully validates the latest available version, then starts the Run with that candidate. The switch becomes atomic only after the Run starts successfully and the message is accepted. Disabling, archiving, or deleting a template does not rewrite the template-name snapshot or last active version of an existing conversation.

## Use the three-pane workspace

Opening an existing conversation displays three areas:

- **Chat history:** Does not require a Node selection. Server reads conversations owned by the current account from valid hosting Nodes; the hosting Node does not need to appear in your ordinary resource directory. Pinned conversations appear first; all remaining conversations are ordered by latest activity. Search matches titles only, and each entry contains its title and one last-interaction line. A green status dot appears while a conversation is starting, running, or stopping; idle conversations do not show a gray dot. An unread marker appears when the conversation has unread terminal notifications, and opening it clears all of its unread notifications. Scrolling near the bottom automatically continues through the unified directory, with a small ring while a page is pending. A failure keeps the loaded conversations and pauses automatic loading; select **Retry** at the bottom to continue. Title filtering searches loaded conversations only and pauses automatic loading until cleared. No matches does not mean the entire directory has no matching conversations. Offline, capability-invalid, version-invalid, failed, or schema-invalid Nodes are skipped silently. If no Node returns a valid result, the page shows a normal empty directory instead of per-Node failures or partial results.
- **Main conversation:** Shows authoritative history and realtime messages from the Node. The composer always uses MAR Agent Full Access but does not display the fixed Agent or access value. It provides only model, attachments, send, and stop controls. Reasoning uses the model default. You cannot select an Agent, access mode, slash command, Skill, or Workspace file reference.
- **Related files:** Shows only Node-projected `inbox/` uploads and `output/` files. Ordinary paths or natural-language text in an Agent response never create file entries. An explicit Markdown file link opens only when it targets `/workspace/inbox`, `/workspace/output`, or uniquely matches a current related-file projection. Drop multiple files into the upload area or click it to choose files. Selecting a file row or valid message link opens the same unified read-only file preview used by the regular Workbench, including download. Text larger than 512 KiB shows only its first range; images, PDFs, audio/video, and supported Office files preview through a controlled content stream and use the same file's download endpoint.

On desktop, conversation history uses the same left-side menu area as other pages. Select **Fold** to fold both the brand area and conversation history so the main conversation moves left; select **Expand** to restore conversation history. Related files remain on the right of the main conversation.

Before creation, **Related files** shows only an explanation and has no upload target without a conversation. Once the first send creates the conversation, the upload area and file list become available in place.

Mobile does not show the global **Expand/Fold** control or three tabs. Select **Chat** in the top navigation again to open the history drawer, and use the **Files** button at the top-right of the main conversation to open related files. Selecting a conversation or the scrim outside a drawer closes it.

## Send messages and attachments

1. Enter a message in the main conversation. Press Enter to send or Shift+Enter for a new line.
2. Choose a concrete model configuration currently available to your account within the template's allowed upstream-model range. If the current configuration disappears, Node first falls back to an available configuration for the template default, then to the first available model in template order. The operation fails when no model intersects. If an update fails, the page keeps the configuration confirmed by the Node.
3. Use the paperclip to add attachments. A message can contain up to 32 attachments. Each file must finish uploading to the current conversation before it can be sent. Dropping local files into the main conversation input first asks you to confirm the upload; choosing files with the paperclip and pasting from the clipboard start uploading directly.
4. Retry or remove a failed attachment from its attachment row. A retry creates a new upload request instead of reusing a cancelled temporary upload. Files with the same name are saved with an incrementing suffix before the extension, for example `image.png` and `image (1).png`; the attachment row shows the final name assigned by the Node.
5. While a task is in progress, you can still edit the Composer and use **Stop**. With the Composer focused, press `Esc` to stop the current task; no second stop request is sent while it is stopping or a message is sending. On a host that supports it, `Ctrl+Enter` on desktop adds the current message with priority. When MAR Agent can accept it natively, the message appears immediately and takes effect after the complete response and tool batch without interrupting generation. Managed waits may return early without stopping background tasks; other tools still finish normally. If the target is not ready or you explicitly change settings such as the model, the original stop-then-send flow applies. Its body is marked as additional information received while working; when idle it sends normally. The wrapper is hidden from the conversation. Ordinary Enter does not queue a hosted-conversation message. On older hosts, on mobile, or while a task is stopping, select **Stop** and wait for it to finish before sending. Direct uploads and deletion in **Related files** are not disabled as a group by an active task.

After an explicit request error, correct the input and retry. If the network disconnects while the result is unknown, the page keeps the same send intent to avoid duplicate execution.

History loading, inline retry, and Run duration follow the [session reading behavior](sessions.md). Sending appears beside the send controls without replacing an active Run's status. Connection hints use the page connection state; they do not mean the Agent failed or restarted.

## Roll back conversation history

When the hosting Node supports hosted-conversation Rollback, a **Rollback conversation** action appears beside terminal user messages. Hosted conversations do not provide a Rewind branch action. After confirmation, the system permanently deletes that user message and all later history in the current conversation's original Session, then restores the message text to the composer so you can edit and send it again.

Rollback does not modify or delete `inbox/`, `output/`, or any item in **Related files**, and it does not create a new conversation or Session. Rollback is unavailable while a Run is starting, active, or settling. Unsupported Node versions do not show the action; if the boundary changed or the request failed, the page keeps the existing history and draft and shows the actual error.

## Manage related files

1. Drop one or more files onto the upload area in **Related files**, or click the area and choose one or more files from the system file picker. Files upload sequentially to the current conversation's `inbox/`, and one failed file does not prevent later files from uploading.
2. Direct upload updates only the related-file list. It does not add files to the composer or attach them to the next message. Use the paperclip when a file must be sent with a message.
3. Select a file row, or an explicit Agent-message file link that resolves to the current authoritative file list, to view it in the unified preview, jump to a text line, download it, or close it. Unknown, ambiguous, and plain-text paths never trigger a file read.
4. Both user uploads in `inbox/` and Agent outputs in `output/` can be deleted manually from their file rows. After confirmation, the page replaces the list with the complete authoritative result returned by the Node. Deleting the file currently being previewed also closes the preview.
5. Deletion may race with Agent writes during an active Run. The operation that completes first takes effect. If the target was deleted, replaced, or changed first, the later operation shows a not-found or conflict message; retry based on the refreshed file list.

The Agent treats `output/` as the current deliverable set rather than appending a history for every Run. When the same document or artifact needs another revision, it keeps editing the existing canonical file and stable path instead of creating successive `v2`, dated, or `final` copies. It archives a prior version under `output/bak/` only when that version has meaningful rollback value or you explicitly request history; small edits do not create backups automatically. Images and other resources used by current deliverables go into meaningful subdirectories such as `output/assets/`, while exploratory or disposable files remain in `/tmp`. The Agent removes only files it created during the current work and confirmed are unused; it does not delete user uploads or unrelated pre-existing files as cleanup.

## Automatically maintain conversation requirements

The Agent automatically recognizes requirements that you directly or indirectly indicate should continue to apply to later work in the current hosted conversation; you do not have to use the word “remember.” For example, “use Chinese for later reports,” “keep revising the existing file,” and “check links before every delivery” are continuing requirements. The Agent first reads the existing `/workspace/inbox/AGENTS.md`, then maintains a concise set of current rules: it preserves unrelated guidance, avoids duplicates, and replaces or removes rules contradicted, cancelled, or superseded by newer guidance. Later Runs read the file again when they start.

Appropriate saved content includes delivery formats, terminology, naming conventions, quality checks, communication preferences, and recurring workflows. Requirements limited to the current task, quoted or third-party material you ask the Agent to inspect, preferences inferred only by the Agent, secrets such as passwords or tokens, and language that attempts to pre-authorize later deletion, commits, pushes, publication, or other external side effects are not saved automatically. `inbox/AGENTS.md` belongs to the current conversation rather than the template. It appears in related files, counts toward persistent quota, and can be previewed, downloaded, edited, or deleted by you. Conversation-history Rollback does not roll back this file.

If a rule should apply to every user and conversation created from the template, ask a template administrator to edit `AGENTS.template.md` in the source Workspace, test the draft, and publish a new version. The Agent inside a hosted conversation can only read the current immutable template snapshot and cannot directly change the reusable template.

## Workspace and network

- The Agent’s logical workspace is always `/workspace`. For scripts that depend on the original absolute path, the canonical source Workspace path recorded at publication is also mounted as a compatibility alias. Both paths refer to the same active snapshot and never expose writable access to the live source Workspace.
- Template files, empty directories, root `AGENTS.md`, `.agents/skills/`, and symbolic links allowed at publication come from the active version and remain read-only.
- `/workspace/inbox` and `/workspace/output` are writable overlays. The same directories under the original-path alias refer to those overlays. Attachments and the current conversation's `AGENTS.md` belong in `inbox/`; current final results and assets belong in `output/`, and prior versions worth retaining may go under `output/bak/`.
- `/tmp` is temporary working storage for the current conversation. Later Runs in the same conversation can reuse it, but the host may clear it at any time. Its contents do not appear in related files and do not count toward persistent quota. `/workspace/output/tmp` has no special lifecycle or semantics.
- Node injects a non-editable hosted-workflow instruction describing the actual directory permissions and network capabilities. Workspace instructions still load but cannot expand Host-enforced boundaries.
- **No network** blocks sandboxed processes from using the network and disables Web and remote HTTP MCP. **Unrestricted** allows sandboxed processes, Web capabilities, and remote HTTP MCP captured in the published template version to reach networks available to the Node. Local stdio MCP can start in either mode but cannot use the network in **No network** mode.

## Realtime and availability states

The conversation page reuses the page's single Workbench WebSocket and subscribes only to the current conversation. Switching conversations, leaving the page, or replacing the browser connection releases the old subscription. After reconnecting, the page obtains a new authoritative Node snapshot instead of inferring a Run result from missing events.

After a Run succeeds, fails, or ends because of an unexpected interruption, Notification Center retains a notification for that hosted conversation for 24 hours. Explicitly selecting **Stop**, or deleting the conversation while it is running, cancels the Run without creating a terminal notification. Selecting a notification switches to Conversation mode and opens the matching conversation. Hosted conversations do not appear in the **Recent Sessions** list.

The page shows an action message in these cases:

- The hosting service is temporarily unreachable or realtime subscription fails: loaded content remains visible; reopen the conversation later.
- Automatic template upgrade fails: the current send fails, but the old version, history, and writable state remain intact. The next send queries the latest available version at that time and attempts the upgrade again.
- Related-file synchronization fails: message history remains available; reopen the conversation later and contact an administrator if the problem continues.

## Titles, pinning, and deletion

The new-conversation panel and a newly created conversation initially show the current interface language's **New conversation** label instead of the template name; switching the interface language updates this default title immediately. After the first non-empty message is accepted, the page uses that message as a temporary title; an attachment-only first send keeps the default title. When MAR Agent completes its first automatic title, the history directory and top bar update. Automatic and manual titles remain in their original text instead of being translated with the interface. You can set a manual title from the **More** menu beside a history entry; a manual title takes priority and is not replaced by a late automatic title. Editing the title or changing pin state does not change the last-interaction time. Pinned entries always appear before regular entries.

When you select **Delete**, the confirmation states that the action cannot be undone. After confirmation, the Node stops any active Run or upload for that conversation and permanently deletes its history, related files, and hosted directory. Deleting the current conversation clears the selection and opens the new-conversation panel; deleting another history entry keeps the current conversation and realtime subscription unchanged. Both cases refresh the history directory. This is not template archiving, and there is no recovery window or restore action.

## Availability

- At 95% filesystem usage, the Node blocks only new conversation creation. Existing conversations remain available for opening, runs, uploads, exports, and deletion.
- A template disappears from your new-conversation catalog after it becomes unpublished, disabled, archived, deleted, or no longer granted to you.
- A template grant does not add the hosting Node or source Workspace to **Work**. Ordinary Workspace, file, terminal, or Node operations still require a separate resource grant.
- The page stores only the most recently selected template ID in this browser and safely ignores it when that template is no longer available. It never creates a conversation silently when opened, refreshed, or reduced to one template. **+ New chat** only opens the temporary center panel.

**Success:** the page shows the new conversation title and first message, and **Related files** is available.

If no template is selectable, ask an administrator to check template publishing and template access. If creation reports a hosting, version, isolation, or storage-capacity problem, an administrator should inspect the corresponding Node. Administrators can see [Manage Conversation Templates](../administration/conversation-templates.md).
