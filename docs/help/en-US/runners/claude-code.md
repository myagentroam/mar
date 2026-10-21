---
title: Install, Configure, and Use Claude Code
lastUpdated: 2026-09-12
---

# Install, Configure, and Use Claude Code

Claude Code must use official authentication or your compatible API configuration under the Node service account. MyAgentRoam does not copy, convert, or host Claude Code account configuration.

## Installation

Run as the actual Node service account, without `sudo npm install -g`:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
claude doctor
```

Run `claude` under the same account to complete Anthropic authentication or configure a supported provider following the official documentation. On Windows, WSL or Git for Windows may be used; consult the [official setup guide](https://code.claude.com/docs/en/setup) for requirements.

When moving to another Node service account, migrate only the required Claude Code configuration and authentication and restrict access to that account. Do not copy history, caches, project sessions, or another account's complete home directory. Following the Node platform service guide, verify `claude --version` under the service's actual HOME/PATH, restart Node, and confirm availability in Node details.

## Optional configuration

To override the displayed context window, set `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS` to a positive integer in the Node service environment. Without an override, the default is 200000 tokens; the same variable can also be read from the account's Claude configuration.

## Procedure

1. Restart Node and confirm that **Supported Agents** includes Claude Code.
2. Create a session and select a model, reasoning level, and permission mode offered by the UI.
3. Use `/plan` for native planning. Close planning or select **Implement** before allowing changes.

**Success:** the session returns content, context usage updates when provided by Claude Code, and the plan card offers a continuation into implementation.

## Troubleshooting

- Agent unavailable: check the version, authentication, HOME/PATH, and network under the service account.
- Unexpected context total: set `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS` correctly and restart Node.
- Missing external history details: confirm that the history belongs to the actual Node service account, then refresh the session.

Next: [Agent Troubleshooting](runner-troubleshooting.md).
