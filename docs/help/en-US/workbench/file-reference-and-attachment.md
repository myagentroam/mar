---
title: References, Folders, and Attachments
lastUpdated: 2026-11-11
---

# References, Folders, and Attachments

Type `@` to search Workspace files and folders. Selecting a result adds a removable Composer tag rather than inserting a path into the message body. References are sent to the Agent as resource inputs and shown as read-only tags in the sent message, without exposing XML. The Agent reads the original resources through its normal tools and permissions; references are not uploaded, copied, or subject to attachment cleanup.

In regular work mode, the same `@` picker also offers registered main Sessions in the current Node and Workspace. Matching Sessions appear before files, without type-switching tabs. Type `@session` or `@session keyword` to search only Sessions. A bare `@` shows the first Sessions; enter a path to search files. Each source shows only its first results, so refine the query when more are available. The current Session and child Sessions are excluded. Hosted conversations and shared-session entries do not expose the ordinary Session directory.

Selecting a Session works like selecting a file: it removes the query at the caret and adds a removable Session reference tag without inserting markup into the body. The tag retains the Session ID and its name at selection time. Session and file references are sent together as XML resource inputs and displayed as read-only tags without exposing XML. Selecting the same Session twice does not duplicate it; different Sessions with matching names remain distinct by ID. Up to 128 Session, file, and folder references can be selected together and restored with the current Workspace draft. Click a tag to remove it, or press Backspace with an empty body to remove the last reference. Editing a queued message's body preserves reference metadata. References do not import history, send collaboration messages, or automatically read the source Session. Any actual read still uses the Agent's existing tools and permissions.

Use the attachment action for files outside the Workspace. The first message accepts up to five files, each larger than zero and no larger than 5 MiB, with a combined limit of 10 MiB. Wait for every upload to complete before sending.

When pasted clipboard text reaches either 100 lines or 10,000 characters, Composer automatically creates a TXT attachment while preserving the existing draft.

In regular Workspaces and hosted conversations, BMP attachments are converted to PNG in the browser before upload, preserving their resolution. The attachment name changes to `.png`; your local source file is unchanged. Both the source and the converted file must fit within 5 MiB, and the image must not exceed 16 megapixels. Images are not automatically resized. If conversion fails or exceeds a limit, save a smaller PNG and add it again. PNG, JPEG, GIF, and WebP are not converted.

Sent image attachments appear as thumbnail cards without filename text or filename tooltips; other attachments appear as file icons and names. Click an image to enlarge it in a dialog, or Ctrl/Cmd+Click to open a separate window. If a thumbnail cannot load, it falls back to an image placeholder; clicking still checks whether the attachment is available. Other files use the normal Workspace preview. Supported images are also supplied through the Agent's native visual input, not just as paths.

## Quote a selected excerpt

Unlike `@file`, a quote saves the text you see as a snapshot. It does not require the Agent to read the current file again.

- Select text in a file or Diff, then choose **Quote** in its existing context menu. **Select all** selects only the loaded body of the current page, including text outside the viewport. It does not read other files, add a quote, or send a message. On mobile, open the same menu from the file's bottom action group.
- Select text within one Agent reply in Chat. A floating **Quote** button appears near the selection on desktop and mobile. Browsers that emit a text-selection context-menu event show the standard Copy/Quote menu instead. The two surfaces are mutually exclusive; mobile does not depend on that event or place Quote in the message action area. Links, images, and non-body content keep their normal menus.
- Adding a quote creates a compact first-line tag capped at 32 characters and a maximum width. Hover, focus, or click to preview the excerpt; a separate button removes it. Your opinion and existing references remain unchanged. A successful file or Diff quote closes the entire source preview window and returns to the originating conversation; a rejected quote leaves it open. Unsaved changes still require confirmation before closing; cancelling keeps both the edits and the added quote. Write feedback and send when ready; a quote-only message is also allowed.
- Quotes go to the draft associated with the source surface, not an unrelated Main or Aside conversation. If the target changes while a menu is open, reopen it in the current target. A companion file window does not deliver quotes into another window.
- Unsaved edits, historical versions, and streaming replies retain their source descriptions. A captured quote does not update when the source changes. Each excerpt allows up to 8,000 characters; all references share a 128-item limit and an encoded-size limit. Reduce the selection or remove references when necessary; text is never silently truncated.
- Sent quotes display their source and a read-only excerpt above your opinion, preserving line breaks. Multiline previews can be expanded or collapsed. Sent excerpts and hover previews share a 500-character limit with an ellipsis for longer text; the saved snapshot, Agent input, and copied content remain complete. Ordinary `@` references remain length-limited tags, and XML stays hidden. Copying that user message retains the quote XML from its public input. Regular Workspace quotes follow the existing Workspace draft restoration rules; hosted and shared entries retain their own draft lifecycle and file-access boundaries.

## Attachment retention

- Sent files remain available while the Session is preparing, queued, or executing work, then for 30 minutes after it becomes idle.
- An accepted follow-up message pauses cleanup and starts a fresh interval when the Session becomes idle again. Viewing history, switching Sessions, or opening previews does not extend retention.
- The message's file list remains after cleanup, but clicking reports "File has expired". Upload the file again if needed. Normal Node shutdown also removes temporary attachments, so old preview URLs are not guaranteed across restarts. In regular Workspaces, MAR Agent [orderly shutdown handoffs](sessions.md#automatic-continuation-after-orderly-shutdown) retain unsent attachment content and prepare it again during recovery.
- Completed uploads that have not been sent expire after one hour. Removing an attachment deletes its temporary upload early.

References and attachments never grant additional access. Check the selected tags before sending, verify missing paths in the Workspace file tree, and do not upload credentials or secret files. Next: [Browse, search, and manage files](files.md).

Attachments are stored under `temp-files/` in the Node private data directory, without creating a Workspace `.mar` directory or changing Git ignore rules. Message attachments remain available for preview and download while retained, but cannot be edited as Workspace files.
