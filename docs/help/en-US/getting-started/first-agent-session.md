---
title: Start Your First Agent Session
lastUpdated: 2026-11-21
---

# Start Your First Agent Session

Use an already registered Workspace to send the first MyAgentRoam-managed Agent message.

## Prerequisites

- The Workspace is selected and its Node reports at least one available Agent.
- For built-in MAR Agent, an administrator has configured and enabled a model that you may use, and you are within its bound credential scope; no external CLI is required.
- For Codex, Claude Code, or OpenCode, authenticate or configure the corresponding CLI under the Node service account.

## Procedure

1. Select a Workspace whose Node reports at least one available Agent.
2. Select **New Session**.
3. Under **What should we do?**, select the Agent name in **Start a new session with …** to switch Agents. Choose the model, reasoning level, and permissions in Composer.
4. Enter a small, verifiable request such as “Inspect the project structure and identify the entry file without changing files.”
5. Send it. Observe the `Working` state, response, and tool cards until the session returns to `Idle`.

**Success:** your message and the Agent response appear, and the session can be reopened after refreshing the page.

For missing Agents or models, see [Agent or Model Unavailable](../runners/runner-troubleshooting.md). The first message to external history validates continuation automatically; if it returns an error, check Node, the local Agent state, and the Workspace path. For unfinished runs, first verify that the Node is online, then see [Session Troubleshooting](../troubleshooting/session-run.md).

Next: [Messages and Composer](../workbench/composer.md) and [Choose an Agent](../runners/overview.md).
