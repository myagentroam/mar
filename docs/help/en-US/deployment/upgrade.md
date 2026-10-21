---
title: Upgrade MyAgentRoam
lastUpdated: 2026-10-11
---

# Upgrade MyAgentRoam

Server, Web, EE, shared cores, Node, Agent, and Protocol share one version, starting at `0.10.1`. Code Navigation, marctl, and Computer Use Runtime also start at `0.10.1` and retain independent patch releases.

The unified product preserves the existing enterprise schema, migration history, License activation, and private data directory. Community and Enterprise use the same installation; activation does not migrate the database. No migration from the retired personal product is provided.

## Legacy database formats

The first transition from the combined Server is not a routine automatic upgrade. Stop all writers, verify that backups can be restored, and rehearse the target version's operations procedure on an isolated restored copy. Prepare the old database to combined schema v49, validate its tables, migration history and references, apply reviewed conversion SQL, then verify data and License activation history. Never replace version markers or clear License state to bypass checks.

`SERVER_DATABASE_LEDGER_UNSUPPORTED` means the new Server does not accept the old ledger format; deleting the migration table is not a remedy. Do not downgrade an enterprise database to a Core-only schema. Supported upgrades after this transition apply incremental Core/Enterprise migrations automatically. On failure, keep services stopped and restore a backup with its matching application version.

## Routine upgrades

1. Back up MySQL, every Node's private configuration and SQLite data, required Workspaces, and Agent-specific configuration/history.
2. Choose a maintenance window without critical runs or terminals.
3. Upgrade Server and Web first; confirm migrations and `/health`.
4. Server queries the published `@myagentroam/node` versions using its service account's npm configuration and selects the highest stable version that does not exceed the current Server version. If the exact Server version is unpublished, it selects an eligible lower published version. It never upgrades beyond Server or sends a floating `latest` tag to Supervisor. Checks and installation use each service account's own npm configuration; no separate registry setting is required.
5. Supervisor-managed Nodes can receive **Push Upgrade** from Node details. The Node drains active runs and rejects new runs, queue dispatch, and terminals while preparing. You may cancel while waiting for runs, but not after installation starts. On an older Node, first upgrade the npm package manually and configure `mar-node supervise` through [Linux systemd](node-linux.md), [Windows Task Scheduler](node-windows.md), or [macOS launchd](node-macos.md).
6. Supervisor installs the exact package, rebuilds `node-pty` for the target platform, validates the entry point, and switches the child process. A failed installation retains the previous entry.
7. After reconnection, verify a new session, file read, terminal, and automatic startup after a service or host restart.

The system does not automatically upgrade or downgrade Nodes. **Target npm package unavailable** means the published versions cannot be queried, no stable package satisfies the Server ceiling, or the Server version is invalid. Check the Server version, registry access, network, and publication status, then refresh.
