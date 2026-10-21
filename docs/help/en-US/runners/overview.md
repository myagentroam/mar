---
title: Choose an Agent
lastUpdated: 2026-09-24
---

# Choose an Agent

MyAgentRoam uses the built-in MAR Agent and the Agent installations already present on each Node. The UI lists only Agents, models, reasoning levels, permission modes, and commands that the selected Node currently reports. New sessions prefer MAR Agent and list available Agents in the order MAR Agent, Codex, Claude Code, and OpenCode; if one is unconfigured, uninstalled, or unavailable, the next available Agent is selected.

- **MAR Agent** is built into Node and uses enabled Server model connections authorized for the current user. System administrators can manage every model, but actual use remains limited by the bound credential's scope. Managing or using a model does not automatically grant access to credential details or management. It provides the MAR SDK runtime, tools, MCP, and subagents. See [Configure and Use MAR Agent](mar-agent.md).
- **Codex** uses the Codex CLI account and App Server capabilities, including supported planning, compact, and fast modes.
- **Claude Code** uses the Claude Agent SDK and the service account's Claude configuration.
- **OpenCode** uses provider/model configurations in the Node service account's global OpenCode configuration and supports its native Plan Agent.

Choose based on the project's existing toolchain and account policy. Sessions remain native to their Agent; switching the new-session Agent does not convert existing history.
