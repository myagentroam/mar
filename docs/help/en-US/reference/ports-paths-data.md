---
title: Ports, Paths, and Data
lastUpdated: 2026-11-12
---

# Ports, Paths, and Data

| Item                              | Default or location                          | Exposure                                                              |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Server (Web/API/WebSocket/health) | Container TCP `5190`; configurable host port | Direct HTTP entry point or external HTTPS proxy target                |
| MySQL host mapping in Compose     | TCP `13006`                                  | Mapped on the host by default; restrict access, never expose publicly |
| Node direct connection            | UDP `49152-49215`                            | Files, Git, and terminals; browser LAN sources only                   |
| Server persistent data            | Compose `./data` binding                     | Private and backed up                                                 |
| Node data                         | Configured `dataDirectory`                   | Private to Node service account                                       |
| Workspaces                        | Registered paths below `allowedRoots`        | Authorized access; direct transfer or Server relay                    |

Node data contains SQLite state and structured logs. External Runner credentials and native histories follow each Runner's configuration directories; MAR Agent model credentials configured in the product are stored by Server. Terminal text is transmitted live through an authorized direct connection or Server relay and is not retained as a Server transcript.

Confirm paths from the Node service account's perspective. Linux systemd, Windows Task Scheduler, and macOS launchd often use a different home directory or `PATH` from an interactive shell.

The private Node JSON can override the direct-transfer range with `directTransfer.udpPortRangeBegin` and `directTransfer.udpPortRangeEnd`. Configure both values and use no more than 256 non-privileged ports. Each Node process obtains one port from the range and reuses it through ICE UDP Mux. Multiple Nodes can share the default pool and select separate free ports, or use non-overlapping ranges for isolation; set both values to the same value for a fixed port. Restart the Node and update the host firewall for LAN sources only.
