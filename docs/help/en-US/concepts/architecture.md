---
title: Server, Node, Web, and Agent
lastUpdated: 2026-10-21
---

# Server, Node, Web, and Agent

MyAgentRoam separates browser administration from local execution:

```text
Browser Web ── HTTPS / WebSocket ── Server ── outbound Node connection ── Agent / Workspace / terminal
```

- **Server** handles identity, authorization, managed model credentials, enterprise administration, and controlled relay. It is not the authority for Workspace files or session content.
- **Node** owns local execution and Workspace storage: files, Git, terminals, Agent tasks, and local session integration. It initiates outbound connections to Server; no general-purpose inbound Node API is exposed to browsers.
- **MAR Agent** is the shared runtime behind its SDK, CLI, and Node integration. It manages model execution, tools, context, and session continuation. External runners (Codex, Claude Code, and OpenCode) retain their native account and history mechanisms; their supported controls are projected into the workbench.
- **Web** presents capabilities and necessary browser UI state. Business APIs and control signaling go through Server. Ordinary Workspace files and terminals may use a Server-authorized direct data channel, with relay fallback; hosted conversations remain relayed. The browser does not hold Node/Runner execution credentials.

## Why Agent-first?

The Agent is the primary worker, not an accessory to a browser IDE. People define goals,
steer execution, inspect files and diffs, and review results. Files, Git, and terminals
support that workflow; MAR does not aim to reproduce a complete IDE or turn every CLI
operation into a dedicated button. Agent tools can execute commands without a user
opening Web Terminal, within the configured permissions and execution environment.

Self-hosting does not mean model context stays offline: configured providers receive
the context sent to them. Server and Node have different storage responsibilities;
protect both hosts and their service accounts. See [Data and Security](data-and-security.md)
and [Sessions, Runs, and Message Queues](session-run-turn.md) for the user-facing boundaries.

Next: [Nodes and Workspaces](node-and-workspace.md) and [Data and Security](data-and-security.md).
