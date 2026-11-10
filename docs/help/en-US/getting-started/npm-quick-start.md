---
title: Local npm Quick Start
lastUpdated: 2026-11-10
---

# Local npm Quick Start

Quick Start runs a fixed Community Server on your own computer for local evaluation. It uses loopback HTTP, a private MySQL instance and, by default, a local Node and SearXNG where managed search is supported. It does not install an operating-system service, require a host UUID or support license activation. For a shared or internet-facing installation, use the [Docker Compose deployment](server-installation.md) with HTTPS instead.

The verified installer targets are Linux x64 with glibc 2.28 or later, `tar` and `dpkg-deb` (such as a supported Debian or Ubuntu system), and Windows x64 with `tar` available. Use Node.js 24.12 or later and npm. Installing native dependencies may require an existing build toolchain; installation and setup never install system packages or request elevated privileges. Browser preparation and the selected components require network access. Other native platforms have not been verified for this Quick Start.

The terminal dependency is pinned to `node-pty@1.2.0-beta.18`, which includes prebuilt files for Linux x64/arm64, macOS x64/arm64 and Windows x64/arm64. On the verified Linux x64 target, its default installation does not require GCC, make or Python, including program and HOME paths with spaces. Do not set `npm_config_build_from_source=true` or globally skip installation scripts: the former forces compilation, while the latter may leave other dependencies unprepared. Other native dependencies or targets without matching prebuilds may still need build tools. Included prebuilds do not establish full Quick Start validation for those platforms.

## Install and start

After the Server package and its required dependencies are available in your npm registry, run as a normal user:

```bash
npm install @myagentroam/server
npx --no-install mar-server setup
npx --no-install mar-server run
```

Server depends normally on the matching Node. npm installs its native dependencies and prepares Chromium through Node's normal lifecycle, even if you later use `--no-node`. Installation and `mar-server --help` do not configure, register or start a local Node. Setup downloads the selected fixed components and initializes its own database; it does not use an existing MySQL server or accept `MAR_DATABASE_URL`. To skip local search, use `--no-searxng`; both options can be combined. Search preparation is optional, and failure is reported without discarding the other components.

`--no-node` persists the disabled choice but does not remove Node dependencies from the Server package. To enable the local Node later, stop run, set `node.enabled` to `true` in `server.json`, preserve its identity, and rerun setup.

Run stays in the foreground and prints the local browser address. Stop it with Ctrl+C and wait for its children to exit. Run never downloads missing components. Setup and run for the same data directory cannot run concurrently. Do not expose the local HTTP endpoint to other machines; it is not a substitute for HTTPS or a production service.

The managed Node in Windows Quick Start uses IPv4 for direct connections. When only IPv6 connectivity is available, file and terminal traffic falls back to the Server relay.

## Sign in and start work

Follow [First Sign-in and Password Change](first-login.md). Change the initial administrator password immediately. Wait for the local Node to report online, then [register a Workspace](register-workspace.md) under the deployment's `workspace` directory. Local Node access is restricted to that directory by default; hosted conversations are not enabled automatically. Configure a model and credentials before [starting a session](first-agent-session.md); an online Node or `/health` alone does not prove an Agent can execute.

The local Node initially allows only this deployment's `workspace/` directory. To use other projects, stop run and edit only the `allowedRoots` array in `node-data/node.json` under the deployment data directory. Supply one or more absolute paths, then start run again. For example, use `"allowedRoots": ["/home/alice/project", "/srv/work"]` on Unix or `"allowedRoots": ["C:\\Projects", "D:\\Work"]` on Windows. Do not replace the whole file or remove identity fields such as `nodeId`, credentials, or `serverUrl`. Allowed roots do not grant operating-system permissions; the account still needs access to those files. The npm program directory is separate from the deployment data directory, which defaults to `~/.myagentroam/quick-start/` and can be selected with `--config`.

After an unsuccessful first registration, stop and restart `run`. If `node.json` contains only a registration token and no identity, Quick Start reuses an unused valid token or replaces an expired unused token while preserving allowed roots and data settings. `QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED` means the token was consumed or its state cannot be confirmed; Quick Start will not register another Node automatically. Keep `node-data/node.json` and restore the existing identity from a backup, or first inspect and resolve the previous registration in the management page. Do not simply delete the configuration or data directory. Partial identity fields produce a configuration error rather than an automatic identity reset.

## Data and optional search

By default, private configuration, credentials and component data are under `~/.myagentroam/quick-start/`. To use another private location, pass the same `--config /path/to/server.json` to setup and run. Protect and back up this directory. Repeating setup preserves credentials, Node data, Workspace and other component versions. The managed Node program follows Server dependency updates rather than using a separate upgrade or active entrypoint.

The `search` object in `server.json` has one mode: `managed`, `disabled`, or `external`. Managed SearXNG is not supported on Windows; use an external service if search is needed. To use an existing SearXNG service, stop run, change only `search.mode` to `"external"` and `search.url` to the service URL, preserve any existing `search.installation` record, then restart. The endpoint must allow JSON searches. A failed JSON check disables client search for that run; it does not fall back to another endpoint. `web_fetch` and model-hosted search remain separate. `--no-searxng` does not erase an external address.

To retry local search after disabling it, stop run, set the search mode to `managed`, preserve any existing `installation` record, and rerun setup. On an unsupported platform, leave it disabled and use an external endpoint instead. See [Node installation](../deployment/node-installation.md) for separately managed Nodes and [production deployment](../deployment/production.md) for operational guidance.
