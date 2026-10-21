---
title: Ports, Paths, and Data
lastUpdated: 2026-10-11
---

# Ports, Paths, and Data

| Item                              | Default or location                   | Exposure                        |
| --------------------------------- | ------------------------------------- | ------------------------------- |
| Server (Web/API/WebSocket/health) | TCP `5190` inside and outside Compose | External HTTPS proxy target     |
| MySQL host mapping in Compose     | TCP `13006`                           | Administrator/internal only     |
| Node file direct transfer         | UDP `49152-49215`                     | Browser LAN sources only        |
| Server persistent data            | Compose `./data` binding              | Private and backed up           |
| Node data                         | Configured `dataDirectory`            | Private to Node service account |
| Workspaces                        | Registered paths below `allowedRoots` | Never served directly           |

Node data contains SQLite state and structured logs. Agent credentials and native histories stay in each Agent's official configuration directories. Terminal text is relayed live and is not retained as a Server transcript.

Confirm paths from the Node service account's perspective. Linux systemd, Windows Task Scheduler, and macOS launchd often use a different home directory or `PATH` from an interactive shell.

The private Node JSON can override the direct-transfer range with `directTransfer.udpPortRangeBegin` and `directTransfer.udpPortRangeEnd`. Configure both values and use no more than 256 non-privileged ports. Each Node process obtains one port from the range and uses ICE UDP Mux for every Probe and file transfer. Multiple Nodes can share the default pool and select separate free ports, or use non-overlapping ranges for isolation; set both values to the same value for a fixed port. Restart the Node and update the host firewall for LAN sources only.
