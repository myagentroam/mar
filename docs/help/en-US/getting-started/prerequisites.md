---
title: Before You Deploy
lastUpdated: 2026-11-10
---

# Before You Deploy

Use this checklist to confirm host, network, and Agent requirements.

## Requirements

- A Server host that can run Docker Compose, or an environment where you manage MySQL 8.4, Server, and Web yourself.
- An HTTPS hostname for browsers. Production deployments should terminate TLS at a reverse proxy.
- Node.js `>=22.13` on every Windows, Linux, or macOS work host, plus a Workspace writable by the Node service account. Hosted conversations require a Linux Node with Bubblewrap.
- For built-in MAR Agent, no external Agent CLI is required. An administrator must [configure, enable, and authorize a model](../runners/mar-agent.md), and the user must be within its bound credential scope.
- For Codex, Claude Code, or OpenCode, install only the required Agent CLI and complete authentication or provider configuration under the same Node service account.

## Checklist

1. Choose `MAR_PUBLIC_ORIGIN`, such as `https://mar.example.com`. It must exactly match the browser-facing origin.
2. Prepare strong, separate passwords for the MySQL root and application accounts.
3. Confirm that Server can serve HTTPS and every Node can make outbound HTTPS/WSS connections to it.
4. Under the final Node service account, check `node --version` and `npm --version`. For MAR Agent, test the model in management; for external Agents, also check the corresponding CLI version.
5. Record the exact Workspace paths. Never use an entire disk as `allowedRoots`.

**Success:** every Node resolves and reaches the Server hostname, and its service account can enter the target Workspace.

If an Agent works in an interactive shell but not as a service, the service account likely has a different home directory or `PATH`. Follow [Install and Register a Node](../deployment/node-installation.md).

Next: [Deploy Server and Web](server-installation.md).

Formal deployments require a valid real host UUID in both Community and Enterprise states. Containers must mount `/sys/class/dmi/id/product_uuid` read-only at `/license-host/product_uuid`; the source must exist. Native formal deployments may use `MAR_LICENSE_HOST_PATH` to select the real UUID file. The local-only [npm Quick Start](npm-quick-start.md) does not require a UUID and cannot be activated.
