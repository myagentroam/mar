---
title: Upgrade MyAgentRoam
lastUpdated: 2026-10-29
---

# Upgrade MyAgentRoam

Server, Web, EE, shared cores, Node, Agent, and Protocol share one version, starting at `0.10.1`. Code Navigation, marctl, and Computer Use Runtime also start at `0.10.1` and retain independent patch releases.

The unified product preserves the existing enterprise schema, migration history, License activation, and private data directory. Community and Enterprise use the same installation; activation does not migrate the database. No migration from the retired personal product is provided.

Use the matching Server, Web, and Node delivery version. After switching versions, refresh open browser pages to load the matching Web. A registered Node below the current business baseline cannot continue Workspace, session, or other business operations. An older Node that supports push upgrades can still connect so an authorized user can request or cancel an upgrade. Do not rely on it for business operations until the upgrade completes. Node SQLite and Server MySQL retain their existing migration chains; back up before migration, since databases are not automatically downgraded.

## Legacy database formats

The first transition from the combined Server is not a routine automatic upgrade. Stop all writers, verify that backups can be restored, and rehearse the target version's operations procedure on an isolated restored copy. Prepare the old database to combined schema v49, validate its tables, migration history and references, apply reviewed conversion SQL, then verify data and License activation history. Never replace version markers or clear License state to bypass checks.

`SERVER_DATABASE_LEDGER_UNSUPPORTED` means the new Server does not accept the old ledger format; deleting the migration table is not a remedy. Do not downgrade an enterprise database to a Core-only schema. Supported upgrades after this transition apply incremental Core/Enterprise migrations automatically. On failure, keep services stopped and restore a backup with its matching application version.

## Routine upgrades

1. Back up MySQL, every Node's private configuration and SQLite data, required Workspaces, and Agent-specific configuration/history.
2. Choose a maintenance window without critical runs or terminals.
3. Upgrade Server and Web first; confirm migrations and `/health`.
4. Server queries the published `@myagentroam/node` versions using its service account's npm configuration and selects the highest stable version that does not exceed the current Server version and meets the current business baseline. If the exact Server version is unpublished, a lower published version is eligible only if it meets both conditions. It never upgrades beyond Server or sends a floating `latest` tag to Supervisor. Checks and installation use each service account's own npm configuration; no separate registry setting is required.
5. Supervisor-managed Nodes can receive **Push Upgrade** from Node details. The Node drains active runs and rejects new runs, queue dispatch, and terminals while preparing. You may cancel while waiting for runs, but not after installation starts. On an older Node, first upgrade the npm package manually and configure `mar-node supervise` through [Linux systemd](node-linux.md), [Windows Task Scheduler](node-windows.md), or [macOS launchd](node-macos.md).
6. Supervisor installs the exact package, rebuilds `node-pty` for the target platform, validates the entry point, and switches the child process. A failed installation retains the previous entry.
7. After reconnection, verify a new session, file read, terminal, and automatic startup after a service or host restart.

The system does not automatically upgrade or downgrade Nodes. **Target npm package unavailable** means the published versions cannot be queried, no stable package satisfies both the Server ceiling and business baseline, or the Server version is invalid. Check the Server version, registry access, network, and publication status, then refresh.

## Upgrade status and recovery

- **Upgrade available** identifies an eligible target for a Node with Supervisor support. The Node must also be online and enabled before a push.
- **No upgrade needed** means the Node has reached or exceeded the selected target; the system does not downgrade it. An unknown or unsupported version requires checking the Node installation. If Supervisor is not enabled, follow the platform instructions above to configure it manually.
- **Waiting for runs** means the request was accepted and active runs are draining; cancellation is available before handoff. A request whose result is unconfirmed is not proof of acceptance: do not blindly push it again.
- **Upgrading** shows closing the old Node, installing, or waiting for it to come online. Installation alone is not success. An interrupted progress stream means the result is unconfirmed, not that installation failed. If reconnection takes a long time, inspect the host rather than starting an overlapping upgrade.
- **Completed** means the target Node authenticated on its control connection for this attempt. A later disconnect does not undo that result.
- **Failed** provides the reason. Inspect Node and Supervisor logs and the result in the Node data directory. Retry only after the old operation has ended and the Node is online; otherwise investigate on the host. Installation failure before the entry switch retains the old entry; a subsequent startup failure does not automatically roll back.

Live progress and the exit-timeout fallback require support from Server, Node, and the Supervisor actually running on the host. Updating only the Node child does not update an already running Supervisor. To enable the capability initially, update Server first, then update the Supervisor startup entry and restart the service in a maintenance window using the platform instructions. An older Supervisor continues the existing upgrade flow without live progress; a previously stuck old process requires separate intervention.

If the push action is absent, check that your account can manage that Node, the enterprise License is not frozen, and the Node is online and enabled. Remote upgrade only installs the Node package and switches its child process: it does not install Node.js, configure a system service, elevate permissions, or update Server/Web. Server and Node service accounts must each be able to access the selected npm package.

If a database migration fails, stop the upgrade and restore a matching backup rather than modifying the schema by hand. See [Backup and restore](backup-restore.md).
