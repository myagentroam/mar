---
title: Terminal Connection Issues
lastUpdated: 2026-10-29
---

# Terminal Connection Issues

1. Confirm that Node is online and you have terminal access to the Workspace.
2. Verify that the Node service account can start its default shell: the account shell on Linux/macOS, or Command Prompt/PowerShell on Windows.
3. Close unused tabs if the running-terminal limit is reached: 10 per Node and 5 per Workspace.
4. Ensure the reverse proxy supports WebSocket Upgrade and long-lived connections. Short interruptions should reconnect automatically with limited output replay.

If takeover is reported, another page attached to the same terminal. Continue there or explicitly request takeover when the UI allows it. Restarting Node closes all terminal processes.

An explicitly closed terminal or one terminated by lost authorization cannot resume its original process. After reconnecting, check the expected working directory and stable input/output; previously sent input should not be executed again. Mobile background restrictions can interrupt connections, so prefer desktop for long terminal work.

When diagnosing a shell, avoid commands that print the entire environment. Check the service, executable path, and minimal non-sensitive output instead.
