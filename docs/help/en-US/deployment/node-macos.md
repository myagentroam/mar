---
title: macOS Node and launchd
lastUpdated: 2026-09-12
---

# macOS Node and launchd

Run Node as the fixed macOS user that owns the Agent sign-in state and Workspace permissions. First verify the foreground connection in [Install and Register a Node](node-installation.md). A macOS Node supports Workspaces, Agents, files, Git, and POSIX PTY terminals. Hosted conversations require Bubblewrap and still need a Linux Node.

## Setup

Run the following as the target macOS user, never with `sudo`, root, or a different login account. Keep configuration and data in that user's private directories:

```bash
config="$HOME/.config/myagentroam/mar-node.json"
plist="$HOME/Library/LaunchAgents/com.myagentroam.node.plist"

mkdir -p "$(dirname "$config")" "$HOME/Library/Application Support/MyAgentRoam" "$(dirname "$plist")"
chmod 700 "$(dirname "$config")" "$HOME/Library/Application Support/MyAgentRoam"
chmod 600 "$config"

mar-node install --config "$config" --output "$plist"
plutil -lint "$plist"
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/com.myagentroam.node"
launchctl print "gui/$(id -u)/com.myagentroam.node"
```

`mar-node install` writes a LaunchAgent that starts `mar-node supervise --config`; `launchctl bootstrap` registers and starts it. The generated plist includes the common Homebrew and system directories in `PATH`. If `node`, `npm`, `mar-node`, or an external Agent CLI is installed through nvm, Volta, or another custom directory, edit `EnvironmentVariables.PATH` in the plist, then repeat `bootout`, `bootstrap`, and `kickstart`. Do not rely on interactive shell initialization files.

## Verify automatic startup and remote upgrades

Confirm all of the following:

- `launchctl print` shows `com.myagentroam.node` loaded and `ProgramArguments` contains `supervise --config`, not `run --config`;
- the target user can read and write the configuration, `dataDirectory`, and Workspace, and can read that user's Agent sign-in and npm configuration;
- `node`, `npm`, and `mar-node` resolve in that user's non-interactive environment; check `npx`, `git`, `python3`/`python`, `pip3`/`pip`, `opencode`, `codex`, and `claude` as needed;
- after the user signs in again or after `launchctl kickstart -k "gui/$(id -u)/com.myagentroam.node"`, the Node reconnects under the same identity and Node details do not report that Supervisor needs manual setup.

Supervisor installs remote upgrades in `dataDirectory/node-versions/<version>/` and switches the Node child process inside the LaunchAgent. Management does not create or modify a LaunchAgent and never elevates privileges; initial automatic-start setup must be completed on the macOS host.

**Success:** the Node page shows the Node online; restarting the LaunchAgent or signing in again reconnects it automatically; Node details show Supervisor enabled; and a Workspace, terminal, and configured Agent all open successfully.

If Node does not start, inspect the exit status from `launchctl print`, the plist's `ProgramArguments` and `PATH`, the configuration path, the target user's home directory, and Workspace permissions. Do not switch to root to bypass Agent sign-in or path problems.
