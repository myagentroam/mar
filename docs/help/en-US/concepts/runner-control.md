---
title: Agents and Session Control
lastUpdated: 2026-09-20
---

# Agents and Session Control

MyAgentRoam shows only Agents that the selected Node actually discovers as available. Use the models, permissions, reasoning levels, and planning options shown in the current UI.

Sessions created in MyAgentRoam can normally send, stop, and queue messages. Historical sessions discovered from an Agent CLI or editor also appear as normal sessions. The first message atomically validates and activates continuation under the current Node, Workspace, and user authorization.

Activation neither copies history nor grants credentials from another system. It continues the same session under the current Node, Workspace, and user authorization.

Sessions can show queued, `Working`, `Idle`, and stopping states. If an external Agent is still running, its workspace does not match, or it is unavailable, the first message returns a stable error without creating a Run. Refreshing cannot change those facts.

Next: [Choose Codex, Claude Code, or OpenCode](../runners/overview.md).
