---
title: Install, Configure, and Use Codex
lastUpdated: 2026-09-20
---

# Install, Configure, and Use Codex

Use the Node service account's own Codex authentication to create sessions that can send, stop, and continue work.

## Installation

Run as the account that actually runs Node:

```bash
npm install -g @openai/codex
codex --version
```

Run `codex` under the same account and follow its instructions to sign in with ChatGPT or configure a supported authentication method. See the [official Codex CLI documentation](https://developers.openai.com/codex/cli) for installation options and authentication requirements. Node does not read another account's login when its service account uses a different HOME.

## Procedure

1. Start or restart Node and wait for **Supported Agents** to update.
2. Confirm that Node details include Codex.
3. Open a Workspace, create a session, and select Codex plus a model, reasoning level, and permission mode offered by the UI.
4. Send a message. Use Compact when the current session offers it.

**Success:** the session displays responses, tools, and file changes, and the same session can be reopened and continued after refresh.

## Troubleshooting

- Not discovered: check `codex --version`, authentication, HOME/PATH, and Node logs under the service account.
- Usage unavailable: account usage is shown only when the current authentication method supports querying it; unavailable usage does not prevent conversation.
- External history cannot continue: the first message validates the Codex continuation path automatically. If it returns an error, check the service-account authentication, Workspace path, and local Codex state.

Next: [Agent Troubleshooting](runner-troubleshooting.md).
