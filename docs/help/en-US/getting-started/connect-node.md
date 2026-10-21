---
title: Connect Your First Node
lastUpdated: 2026-10-11
---

# Connect Your First Node

Register a Node on the host that stores your Workspace and runs Agents.

The Server includes a Node named `MyAgentRoam`. ADMIN can select it immediately and register a Workspace under the service account's home. Hosting is enabled by default, subject to Linux/Bubblewrap requirements; no second registration or installation is needed. The procedure below connects another device.

## Procedure

1. Open **Admin → Nodes**, select **Register Node**, and create a registration key with a name and owner. On success, the form closes and a separate confirmation dialog shows the key, instructions, and deployment guide. Copy and save the registration key before closing, then follow the deployment guide to register your device.
2. Install `@myagentroam/node` on the target host and create its private configuration file.
3. Run `mar-node run --config <config-file>` in the foreground for initial verification.
4. Confirm that the Node is online. Open its management details and verify that the reported Agents match the host. Configure systemd, Task Scheduler, or launchd only after this check succeeds.

**Success:** Node details show the correct platform, Node.js version, and supported Agents.

Registration keys are single use. If registration fails, create a new registration key. For an offline Node, check `serverUrl`, system time, outbound TLS/WSS, and service logs. If an Agent is missing, verify its installation, `PATH`, and authentication under the actual Node service account.

Next: [Install and Register a Node](../deployment/node-installation.md), then [Register a Workspace](register-workspace.md).
