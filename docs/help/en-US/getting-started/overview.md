---
title: What Is MyAgentRoam?
lastUpdated: 2026-10-29
---

# What Is MyAgentRoam?

MyAgentRoam is a privately deployed, shared Agent workbench for teams with two ways to work: **Work** and **Conversation**. Configure Agents, models, project directories, and toolchains once on team-owned Windows, Linux, or macOS hosts. Work mode provides the complete Node, Workspace, Agent session, file, Git, and terminal environment; Conversation mode lets members start directly from a published template. The environment does not need to be rebuilt on every personal device. Hosted conversations require Bubblewrap and therefore run only on Linux Nodes.

Workspace source, external Agents' local credentials, and terminals remain on your hosts. Server-managed model and credential configuration is stored on Server. MyAgentRoam lets authorized members share the work environment and continue work with clear data and permission boundaries.

## Four components

| Component | Location       | Responsibility                                                     |
| --------- | -------------- | ------------------------------------------------------------------ |
| Web       | Browser        | Workbench, conversations, files, and terminal UI                   |
| Server    | Your server    | Sign-in, Node registration, authorization, and browser connections |
| Node      | Each work host | Workspaces, Agents, files, Git, and terminals                      |
| Agent     | On the Node    | Performs work using your configured Agent and model                |

Browsers authenticate and obtain authorization through Server, while each Node opens an outbound control connection. Authorized ordinary Workspace data can also use direct WebRTC; see [Network, TLS, and WebSocket](../deployment/network.md) for its requirements and fallback. Each Workspace belongs to one Node; files, terminals, and sessions do not cross Node boundaries.

## Interface Language

Console and the documentation center use the language saved in the current browser. The independent marketing website has a separate language preference. Opening documentation from Console takes you to the matching language. When you sign in or return to Console, the browser's language is synchronized to your account and used for notifications created afterward; changing the language in Settings also updates the account preference. A notification keeps the final text generated when it was created, so later language changes do not rewrite it. Switching languages in the documentation center opens the matching version of the current page; a direct documentation link takes precedence over the saved language.

## Fastest path to success

1. Complete [Before You Deploy](prerequisites.md), then deploy Server and Web.
2. Sign in as `admin` and change the initial password.
3. Install and register a Node on a work host.
4. Register a Workspace and confirm that an Agent is available.
5. Create a session and send the first message.

**Success:** Work mode shows the Node online, the Workspace file tree opens, and a new session can send messages.

Community Edition is intended for individual use and does not limit the number of registered Nodes. Enterprise licenses add organizations, roles, sharing, SSO, and auditing. See [Users, Organizations, and Access](../concepts/permissions-and-sharing.md).

If Server is already available, start with [First Sign-in](first-login.md), [Connect a Node](connect-node.md), or [Your First Agent Session](first-agent-session.md). Administrators deploying the product can start with [Before You Deploy](prerequisites.md).
