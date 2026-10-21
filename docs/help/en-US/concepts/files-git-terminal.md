---
title: Files, Git, and Terminals
lastUpdated: 2026-08-24
---

# Files, Git, and Terminals

File, Git, and terminal operations execute inside the Node Workspace; the complete Workspace is not uploaded to Server.

- An `@` **reference** asks the Agent to use a Workspace file or folder. It is not an upload.
- An **attachment** supplies content from outside the Workspace to the current message.
- **File preview** reads a file. Git Changes and conversation file changes open a diff by default.
- A **terminal** runs under the Node service account. Collapsing the panel or switching Workspaces does not terminate it; closing its tab or restarting Node does.

Use references for existing code, attachments for external input, diffs to review changes, and terminals for controlled local commands. All remain limited by `allowedRoots`, Workspace registration, and authorization.

Check Git status before renaming, moving, or deleting files. MyAgentRoam does not provide an implicit recycle bin.
