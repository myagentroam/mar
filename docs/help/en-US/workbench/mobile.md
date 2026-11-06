---
title: Continue on Mobile
lastUpdated: 2026-11-06
---

# Continue on Mobile

Mobile Workbench keeps the current Agent conversation as the main Work surface. Selecting **Work** or **Chat** when that mode is not active switches modes and restores the existing content without opening a resource or history menu. If nothing is selected, the existing empty state is shown. Selecting the active **Work** entry toggles the Node → Workspace resource tree; selecting the active **Chat** entry toggles its history drawer. Admin and Settings retain their existing category-menu behavior. Select **More** in the conversation title bar to reopen the auxiliary work surface at its last active tab. Choose Files, Search, Git, or Terminal within that surface instead of separate title-bar buttons.

The **Sessions & notifications** icon opens one custom panel with separate **Recent Sessions** and **Notifications** tabs; there is no separate bell. Its upper-right number counts unread notifications, and its lower-right green dot indicates running workspace sessions. Each opening starts on Notifications when unread notifications exist, or Recent Sessions otherwise. Click or tap the icon, or use `Ctrl/Cmd+Shift+E`, to toggle it; click outside or press Escape to close. Hovering does not open or close it.

Other top-bar menus, such as Work, Admin, and Settings, have no additional X close button; use the scrim, Escape, or the active top-bar entry to dismiss them. Browser Back, including the browser's edge-swipe back gesture, closes the menu before leaving the current work surface. Switching menu entries replaces the current panel rather than stacking panels; switching to Work or Chat closes existing menus. **Mark all as read** remains available when there are unread notifications. Opening the list alone does not mark all notifications read. Brief previews of new notifications do not automatically open the full panel or mark notifications read.

Browser Back also dismisses the current session, file or terminal tool layer, or the topmost file/image preview or task dialog, keeping the underlying work surface. Editing follows the existing close policy. If a discard confirmation appears, Back cancels that confirmation and preserves the edits. Closing a preview does not download or delete a file, and hiding Terminal does not end its process. Gallery navigation, image zoom and horizontal content scrolling are not back gestures. Native browser or system dialogs retain their own behavior.

HTML previews use the same auxiliary work surface. Previewing from source temporarily hides the file window; return to source to continue editing the draft. See [file preview](files.md).

The Composer stays above the on-screen keyboard. Enter inserts a newline; use the send button to submit. Agent and model controls remain compact, while file previews and diffs use the full viewport.

Select **More** in the conversation title bar, then choose the **Terminal** tab in the auxiliary work surface. The surface covers the area below the top bar; its back button or browser Back returns to the conversation without ending the terminal. Reopening preserves its terminal tabs. Explicitly close a terminal tab to stop it. All desktop authorization and Workspace boundaries still apply.

After returning from the background or a network change, reopen the session and check its actual state; closing the page or backgrounding it does not automatically stop a run on Node. Confirm the target Node and Workspace before acting, and check the session's final status after opening a notification. Prefer desktop for destructive file operations and complex Diff review.

If a menu, drawer, or page remains unusable, refresh the current page once. If the problem persists, record the device and browser versions and see [Quick diagnosis](../troubleshooting/quick-diagnosis.md).
