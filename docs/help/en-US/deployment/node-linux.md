---
title: Linux Node and systemd
lastUpdated: 2026-10-29
---

# Linux Node and systemd

Create a dedicated unprivileged account, install the Server-compatible Node package for that account, and store configuration and data in account-owned private directories. Verify registration in the foreground using [Install and register a Node](node-installation.md) before creating the service.

Run `mar-node supervise --config <config-file>` from a systemd unit so remote upgrades can install, validate, and switch the managed Node child process. Set the working directory, environment, restart policy, and absolute executable paths explicitly; do not rely on an interactive shell profile.

For example, run the following as the Node service account, replacing `ubuntu` and `/home/ubuntu` with that account and its home directory. Generate the unit as that account, then use `sudo` only to install and start it. `mar-node install` also prepares the Web Fetch browser and may download it; see [browser preparation](node-installation.md#web-fetch-browser-preparation). If an Agent needs write access outside the data directory and configured roots, edit the temporary unit's `ReadWritePaths` before running `sudo install`, adding only existing paths that are actually required. Ensure each writable path belongs to the appropriate account.

```bash
mkdir -p "$HOME/.config/myagentroam" "$HOME/.local/share/myagentroam" "$HOME/workspaces"
chmod 700 "$HOME/.config/myagentroam" "$HOME/.local/share/myagentroam"
chmod 600 "$HOME/.config/myagentroam/mar-node.json"
unit_file=$(mktemp)
mar-node install --config "$HOME/.config/myagentroam/mar-node.json" --output "$unit_file"
node_bin_dir=$(dirname "$(command -v node)")
sed -i \
  -e 's|^User=mar-node$|User=ubuntu|' \
  -e '/^User=ubuntu$/a SetLoginEnvironment=false' \
  -e '/^ExecStart=/i Environment=HOME=/home/ubuntu' \
  -e "/^ExecStart=/i Environment=PATH=${node_bin_dir}:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "$unit_file"
sudo install -o root -g root -m 0644 "$unit_file" /etc/systemd/system/myagentroam-node.service
rm -f "$unit_file"
sudo systemctl daemon-reload
sudo systemctl enable --now myagentroam-node.service
sudo systemctl status myagentroam-node.service --no-pager
sudo journalctl -u myagentroam-node.service -f
```

The example PATH includes the service account's `~/.local/bin`, matching the user-level npm prefix in the installation guide. If you use a different installation directory, adjust both the unit and diagnostic commands so that they check the same environment.

The generated `ReadWritePaths` includes the data directory and configured roots. Before installing the unit, add any other existing Agent configuration directories that actually require write access, and ensure the service account has permission; do not copy unused or nonexistent Agent paths. The account needs access to its npm configuration and writable Node data directory; Supervisor does not invoke sudo. After changing configuration or manually upgrading the npm package, regenerate and install the unit, then reload and restart it.

Inspect `systemctl cat myagentroam-node.service` and `systemctl show myagentroam-node.service -p User -p ExecStart -p Environment`: verify the account, `supervise --config`, `HOME`, `PATH`, and writable paths. Check required executables under that same account and environment; unused optional Agents and tools need not be installed. If discovery differs from an interactive shell, check the unit environment and sign-in configuration rather than switching to root.

Enable and start the unit, then verify logs, automatic reconnection after a service restart, Agent discovery, file access, and one terminal. A host reboot must return the same Node identity without a new registration token.

After updating Server, follow [Upgrade MyAgentRoam](upgrade.md) to push the highest published stable Node version that meets the business baseline and does not exceed the Server version. Versioned installations live under `dataDirectory/node-versions/<version>/`; do not put that directory in `ReadOnlyPaths` or pre-create it under another account. Remote upgrade does not run sudo or modify the systemd unit.
