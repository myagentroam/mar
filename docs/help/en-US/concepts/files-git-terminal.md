---
title: Files, Git, and Terminals
lastUpdated: 2026-11-06
---

# Files, Git, and Terminals

File, Git, and terminal operations use the Node Workspace as their working context; the complete Workspace is not uploaded to Server.

On desktop, the auxiliary work surface (Aside) sits beside the main conversation. If the window is too narrow for both, Aside temporarily hides instead of splitting the available height in half. Widen the window or collapse the left resource panel to restore it. The active tab, drafts, and width preferences are preserved, and open terminals keep running. On mobile, use **Open auxiliary work surface** to open the overlay, then go back to continue the main conversation.

- An `@` **reference** asks the Agent to use a Workspace file or folder. It is not an upload.
- An **attachment** supplies content from outside the Workspace to the current message.
- **File preview** reads a file. Git text changes and conversation file changes open a diff by default. Supported images, audio, video, PDF, and Office formats in Git Changes / Git History open directly in a preview of the corresponding worktree or selected commit.
- A **terminal** runs under the Node service account. Collapsing the panel or switching Workspaces does not terminate it; closing its tab or restarting Node does.

Use references for existing code, attachments for external input, diffs to review changes, and terminals for controlled local commands. These do not grant additional MAR resource access. Individual file operations have their own path and authorization rules, while terminals and Agent tools run with the Node service account's permissions. Workspace and `allowedRoots` are not host confidentiality boundaries: authorized absolute-path reads may access other files readable by that account. Protect sensitive directories with operating-system accounts and file permissions.

Check Git status before renaming, moving, or deleting files. MyAgentRoam does not provide an implicit recycle bin.
