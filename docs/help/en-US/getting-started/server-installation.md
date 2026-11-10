---
title: Deploy MyAgentRoam Server and Web
lastUpdated: 2026-11-10
---

# Deploy MyAgentRoam Server and Web

The public product repository's single root `compose.yaml` runs MySQL, SearXNG, and Server with its bundled Web application. Your reverse proxy provides the production HTTPS entry point.

## Formal deployment

The formal deployment uses the single product source and build, with `mar-server/`, `mar-web-console/`, and the root `compose.yaml`. Without activation it is Community, with Workspace sessions, files, Git, terminals, model and credential management, Skill/MCP configuration, personal templates, and hosted conversations. A valid Enterprise license enables organizations, users, sharing, SSO, and auditing in the same installation without replacing images. For another installation option, see [npm Quick Start](npm-quick-start.md).

Both license states use `/console` for the workbench and `/docs/` for documentation. Existing links to `/` keep working: the browser opens the same product at `/console`, preserving query parameters and fragments. Verify sign-in and a Workspace operation rather than treating `/health` alone as proof that the full workbench is usable.

## Procedure

1. In an administrator-only source deployment directory, copy the root template and protect it:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

   Edit every blank value before continuing. Set `MAR_PUBLIC_ORIGIN` to your external HTTPS origin, generate separate strong MySQL root/application passwords and a long random `MAR_SEARXNG_SECRET`, and set `MAR_SERVER_SSH_DIR` to an existing absolute directory. Use a URL-safe application password because Compose embeds `MAR_MYSQL_PASSWORD` in a database URL. The template intentionally has no working secrets; Compose rejects missing required values.

   `MAR_SERVER_SSH_DIR` must be the deployment account's absolute `.ssh` path. Compose mounts it read-only. Create a correctly protected empty directory even if SSH skill sources are not yet used.

2. Restrict the directory and private keys to the deployment account. If using an SSH Skill source, verify non-interactive access as that account on the deployment host, replacing the example with a repository you are authorized to access:

   ```bash
   GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null' \
     git ls-remote git@<repository-host>:<owner>/<repository>.git HEAD
   ```

   This command contacts an external repository and, like Server's SSH Skill source, skips host fingerprint verification. That permits server impersonation; use it only for trusted networks and repositories, and do not set this option as a global SSH default. In `.ssh/config`, use `~/.ssh/key-name` for `IdentityFile`. The host deployment UID should match the image `node` user UID (`1000` by default).

3. Start and inspect the services:

   ```bash
   docker compose up -d --build
   docker compose ps
   curl -fsS http://127.0.0.1:5190/health
   ```

4. Proxy HTTPS traffic to the unified Server host port `5190`. Allow Upgrade/WebSocket requests and do not cache `/api/` or upgraded connections.
5. Open `MAR_PUBLIC_ORIGIN` in a browser.

**Success:** all three Compose services—MySQL, SearXNG, and Server—are healthy, and `/console` opens for sign-in through the HTTPS site.

For failures, inspect `docker compose logs mysql`, verify the external origin, certificate chain, `/api/` proxying, and outbound HTTPS/WSS from Nodes. The Node control connection does not require a public inbound HTTP API; see [Network, TLS, and WebSocket](../deployment/network.md) for optional LAN direct-transfer UDP requirements.

Keep `.env` out of Git, chats, and the Web root because it contains database credentials.

Next: [First Sign-in](first-login.md). See also [Network, TLS, and WebSocket](../deployment/network.md).

Formal deployments require a valid real host UUID in both Community and Enterprise states. Containers must mount `/sys/class/dmi/id/product_uuid` read-only at `/license-host/product_uuid`; the source must exist. Native formal deployments may use `MAR_LICENSE_HOST_PATH` to select the real UUID file. The [npm Quick Start](npm-quick-start.md) does not require a UUID and cannot be activated.

## Connect an independent Node

In this formal deployment, Server hosts Web and API only; it does not include a Node executor. Before using Workspaces, Agents, files, terminals or hosted conversations, [install and register a separate Node](../deployment/node-installation.md). Configure hosting and browser execution dependencies on the Node host, not in the Server image.
