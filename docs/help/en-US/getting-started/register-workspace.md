---
title: Register Your First Workspace
lastUpdated: 2026-10-10
---

# Register Your First Workspace

A Workspace is a real directory on one Node. It is not a copy and cannot be used across Nodes.

The Node must be online, the directory must be inside an `allowedRoots` entry, and the Node service account must have the required permissions.

1. Open **Work**, expand the online Node, and select the add-Workspace action. Registration opens in a dialog with an explicit host target, without changing the active Workspace.
2. Choose a directory returned by the Node and give it a recognizable display name.
3. Saving immediately activates the Workspace tab and loads its content in the background. Canceling the dialog leaves the original Workspace selected.
4. Open Files and, for a Git repository, Git Changes.

**Success:** the Workspace appears under its Node and the file tree is readable. Git repositories also show the current branch and Git Changes.

If a Workspace registered by someone else is missing, right-click an empty area of the resource tree and select **Refresh workspaces** to update Nodes and loaded Workspace lists. You can also right-click a Node and select **Refresh workspaces** to update only that Node.

Never bypass `allowedRoots` with a symbolic link. Correct the private Node configuration and restart it instead. Fix filesystem ownership or ACLs when files are unreadable. A non-Git directory remains a valid Workspace, but Git views are unavailable.

Next: [Start Your First Agent Session](first-agent-session.md).

## Git override policy

Supported Nodes offer **Do not override Git parameters** during registration. It is unchecked by default; selecting it preserves existing Node/repository identity and authentication for new executions. Registering an existing directory again does not reset its saved policy. Workspace managers can change it in details. See [Personal Git identity and credentials](../workbench/terminal.md#personal-git-identity-and-credentials).
