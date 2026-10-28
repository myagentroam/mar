---
title: References, Folders, and Attachments
lastUpdated: 2026-10-29
---

# References, Folders, and Attachments

Type `@` to search Workspace files and folders. Selecting a result adds a removable Composer tag rather than inserting a path into the message body. References are sent to the Agent as resource inputs and hidden in the sent message. The Agent reads the original resources through its normal tools and permissions; references are not uploaded, copied, or subject to attachment cleanup.

In regular work mode, the same `@` picker also offers registered main Sessions in the current Node and Workspace. Use the All, Files, or Sessions filter, or type `@session` or `@session keyword` to search only Sessions. A bare `@` shows the first Sessions; enter a path to search files. Each source shows only its first results, so refine the query when more are available. The current Session and child Sessions are excluded. Hosted conversations and shared-session entries do not expose the ordinary Session directory.

Selecting a Session inserts ordinary text, `<mar-session: Session name>`, at the caret. You can edit or undo it. It does not import history, send a message, or automatically read the source Session. Names are not unique: after a rename or when names match, the Agent may need to use existing tools to find the ID. Any actual read remains subject to the Agent's existing permissions. File tags and Session text can be used together in one message.

Use the attachment action for files outside the Workspace. The first message accepts up to five files, each larger than zero and no larger than 5 MiB, with a combined limit of 10 MiB. Wait for every upload to complete before sending.

When pasted clipboard text reaches either 100 lines or 10,000 characters, Composer automatically creates a TXT attachment while preserving the existing draft.

Sent image attachments appear as thumbnail cards without filename text or filename tooltips; other attachments appear as file icons and names. Click an image to enlarge it in a dialog, or Ctrl/Cmd+Click to open a separate window. If a thumbnail cannot load, it falls back to an image placeholder; clicking still checks whether the attachment is available. Other files use the normal Workspace preview. Supported images are also supplied through the Agent's native visual input, not just as paths.

## Attachment retention

- Sent files remain available while the Session is preparing, queued, or executing work, then for 30 minutes after it becomes idle.
- An accepted follow-up message pauses cleanup and starts a fresh interval when the Session becomes idle again. Viewing history, switching Sessions, or opening previews does not extend retention.
- The message's file list remains after cleanup, but clicking reports "File has expired". Upload the file again if needed. Normal Node shutdown also removes temporary attachments, so old preview URLs are not guaranteed across restarts. In regular Workspaces, MAR Agent [orderly shutdown handoffs](sessions.md#automatic-continuation-after-orderly-shutdown) retain unsent attachment content and prepare it again during recovery.
- Completed uploads that have not been sent expire after one hour. Removing an attachment deletes its temporary upload early.

References and attachments never grant additional access. Check the selected tags before sending, verify missing paths in the Workspace file tree, and do not upload credentials or secret files. Next: [Browse, search, and manage files](files.md).

Attachments are stored under `temp-files/` in the Node private data directory, without creating a Workspace `.mar` directory or changing Git ignore rules. Message attachments remain available for preview and download while retained, but cannot be edited as Workspace files.
