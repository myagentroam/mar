---
title: What Is MyAgentRoam?
lastUpdated: 2026-10-11
---

# What Is MyAgentRoam?

MyAgentRoam is a privately deployed, shared Agent workbench for teams with two ways to work: **Work** and **Conversation**. Configure Agents, models, project directories, and toolchains once on team-owned Windows, Linux, or macOS hosts. Work mode provides the complete Node, Workspace, Agent session, file, Git, and terminal environment; Conversation mode lets members start directly from a published template. The environment does not need to be rebuilt on every personal device. Hosted conversations require Bubblewrap and therefore run only on Linux Nodes.

Source code, Agent credentials, and terminals remain on your hosts. Browsers connect only to Server; each Node opens an outbound connection to Server, so work hosts do not need public inbound access.

## Four components

| Component | Location       | Responsibility                                                     |
| --------- | -------------- | ------------------------------------------------------------------ |
| Web       | Browser        | Workbench, conversations, files, and terminal UI                   |
| Server    | Your server    | Sign-in, Node registration, authorization, and browser connections |
| Node      | Each work host | Workspaces, Agents, files, Git, and terminals                      |
| Agent     | On the Node    | Performs work using your configured Agent and model                |

Each Workspace belongs to one Node. Files, terminals, and sessions never cross Node boundaries.

## Interface Language

The homepage, Console, and documentation center use the language saved in the current browser. Opening documentation from Console takes you to the matching language. When you sign in or return to Console, the browser's language is synchronized to your account and used for notifications created afterward; changing the language in Settings also updates the account preference. A notification keeps the final text generated when it was created, so later language changes do not rewrite it. Switching languages in the documentation center opens the matching version of the current page; a direct documentation link takes precedence over the saved language.

## Fastest path to success

1. Complete [Before You Deploy](prerequisites.md), then deploy Server and Web.
2. Sign in as `admin` and change the initial password.
3. Install and register a Node on a work host.
4. Register a Workspace and confirm that an Agent is available.
5. Create a session and send the first message.

**Success:** Work mode shows the Node online, the Workspace file tree opens, and a new session can send messages.

Community Edition is intended for individual use and does not limit the number of registered Nodes. Enterprise licenses add organizations, roles, sharing, SSO, and auditing. See [Users, Organizations, and Access](../concepts/permissions-and-sharing.md).

Next: [Before You Deploy](prerequisites.md) or [Next Steps](next-steps.md).
