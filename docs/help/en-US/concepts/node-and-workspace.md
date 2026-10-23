---
title: Nodes and Workspaces
lastUpdated: 2026-10-22
---

# Nodes and Workspaces

A Node is the Windows, Linux, or macOS host where Agents run. A Workspace is one registered real directory on that Node.

| Concept        | Meaning                                        | Boundary                                |
| -------------- | ---------------------------------------------- | --------------------------------------- |
| Node           | One host and its service-account environment   | Exposes no browser-facing port          |
| `allowedRoots` | Roots from which directories may be registered | Cannot be bypassed with arbitrary paths |
| Workspace      | A registered directory below an allowed root   | Never spans Nodes                       |
| Git Workspace  | A Workspace inside a Git repository            | Git is optional                         |

Files, Git operations, sessions, and terminals are bounded by the Workspace. Deleting a Node registration or unregistering a Workspace does not delete host files.

Workspace tabs show a green dot and an **Unread** label beside the Node name. The dot means that the Workspace has a starting, running, or stopping task in your account's recent sessions; **Unread** means that session notifications remain unread. Both can appear together, including on inactive tabs. They follow the [notification center](../workbench/conversation.md): opening a session from the session list marks that session's notifications read without clearing other sessions, while clicking one notification marks only that item. List refreshes and connection recovery synchronize the indicators; a short task may finish before its dot appears.

An underlined Node name on the active tab means that the peer-to-peer connection is connected. Hover over it for connection details. This does not indicate Node availability or session activity.

If a directory moves, permissions change, or a symbolic link crosses the boundary, correct the actual path and Node configuration before registering it again. See [Workspace Troubleshooting](../troubleshooting/workspace-files.md).
