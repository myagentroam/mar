---
title: Connect Your First Node
lastUpdated: 2026-11-12
---

# Connect Your First Node

Register a Node on the host that stores your Workspace and runs Agents.

Server does not include a Node executor. Install and register Node separately, even when it runs on the same host as Server. Hosted conversations also require Linux and Bubblewrap.

## Prerequisites

- You can sign in to MyAgentRoam, and the host meets the [Node prerequisites](prerequisites.md).
- You are authorized to create a Node registration key and can install and run the program under the Node service account on the target host.

## Procedure

1. Open **Admin → Nodes**, select **Register Node**, and create a registration key with a name and owner. On success, the form closes and a separate confirmation dialog shows the key, instructions, and deployment guide. Copy and save the registration key before closing, then follow the deployment guide to register your device.
2. Install `@myagentroam/node` on the target host and create its private configuration file.
3. Run `mar-node run --config <config-file>` in the foreground for initial verification.
4. Confirm that the Node is online. Open its management details and verify that the reported Agents match the host. Configure systemd, Task Scheduler, or launchd only after this check succeeds.

**Success:** Node details show the correct platform, Node.js version, and supported Agents.

Registration keys are single use. If registration fails, create a new registration key. For an offline Node, check `serverUrl`, system time, outbound HTTP/WS or HTTPS/WSS, and service logs. If an Agent is missing, verify its installation, `PATH`, and authentication under the actual Node service account.

Next: [Install and Register a Node](../deployment/node-installation.md), then [Register a Workspace](register-workspace.md).
