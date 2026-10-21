---
title: Linux Node and systemd
lastUpdated: 2026-08-24
---

# Linux Node and systemd

Create a dedicated unprivileged account, install the Server-compatible Node package for that account, and store configuration and data in account-owned private directories. Verify registration in the foreground before creating the service.

Run `mar-node supervise --config <config-file>` from a systemd unit so remote upgrades can install, validate, and switch the managed Node child process. Set the working directory, environment, restart policy, and absolute executable paths explicitly; do not rely on an interactive shell profile.

Enable and start the unit, then verify logs, automatic reconnection after a service restart, Agent discovery, file access, and one terminal. A host reboot must return the same Node identity without a new registration token.
