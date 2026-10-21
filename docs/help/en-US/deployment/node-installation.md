---
title: Install and Register a Node
lastUpdated: 2026-10-21
---

# Install and Register a Node

Only one Node runtime may use a local data directory at a time. A duplicate start exits with `NODE_DATA_DIRECTORY_IN_USE`. Stop the original instance normally through its service or terminal before starting another; do not delete `node-owner.sqlite` to bypass ownership. Supervisor stops its internal retry for that duplicate start, but an external service manager may still restart the service according to its own policy.

Normal restarts and managed upgrades hand over after the old instance exits. An ordinary disconnect does not stop accepted executions, and a replaced control connection does not prove that execution on the old host has ended. Local directory ownership does not fence identities copied to another directory or host; do not copy credentials to bypass a duplicate-instance error.

Use Node.js `>=22.13`, an HTTPS Server URL, a dedicated service account, and real Workspace roots writable by that account. Windows, Linux, and macOS work hosts are supported. Hosted conversations require Bubblewrap and run only on Linux Nodes.

For a first connection, you can use [built-in MAR Agent](../runners/mar-agent.md) without an external Agent CLI; an administrator configures and authorizes its model. If you use Codex, Claude Code, or OpenCode, install and configure the corresponding CLI under the same service account.

1. Confirm `commonVersion` in the current product release manifest and install that exact `@myagentroam/node` version. Server/Web, Node, Agent, and Protocol share one version baseline; the manifest's `productVersion` and `commonVersion` must match. Still install the manifest's exact version, not npm's floating `latest`. If the manifest is unavailable, ask the deployment administrator for the exact version. Matching version numbers do not replace protocol and capability compatibility checks.
2. In **Admin → Nodes**, create a registration key. Save the key from the separate success dialog before closing it, then set `registrationToken` in the target Node configuration. The dialog also provides instructions and a deployment guide. Creating a registration key does not connect the Node.
3. Create a private configuration containing `serverUrl`, the token for first registration, `dataDirectory`, narrowly scoped `allowedRoots`, and optionally a `directTransfer` UDP range. The default pool is `49152-49215`; set the range start and end to the same value when the Node must use one fixed firewall port.
4. Restrict the configuration and entire data directory to the service account. They contain Node credentials, SQLite data, and logs; keep them out of npm package directories, Git, and chats.
5. Verify in the foreground with `mar-node run --config <config-file>`, then configure a Supervisor-backed service for production.

For step 1, replace the placeholder before running:

```bash
common_version='<commonVersion from the product release manifest>'
npm install --global "@myagentroam/node@${common_version}"
npm list --global "@myagentroam/node@${common_version}" --depth=0
```

Supervisor stores versioned installations in the service account's writable Node data directory without sudo or UAC. After initial service setup, management upgrades only to the highest published stable npm version not exceeding the current Server version, following explicit confirmation, and sends the selected exact version to Supervisor. See [Upgrade MyAgentRoam](upgrade.md).

After registration, open a Workspace and verify files, terminals, and Agent sessions. The Node needs outbound HTTPS/WSS and exposes no browser HTTP API. For ordinary Workspace direct transfer, permit the configured UDP range only from the browser LAN; otherwise files automatically use the Server relay. Each Node process uses ICE UDP Mux so all of its Probe and transfer PeerConnections reuse one selected port. Multiple Nodes on one host can share the default pool and select separate free ports; assign distinct fixed ports or non-overlapping ranges when each Node needs isolation. For missing Agents, reproduce discovery under the service account; for MCP or Python failures, verify the exact `npx`, Python, and pip commands reported in Node details.

Configure automatic startup for the target platform: [Linux systemd](node-linux.md), [Windows Task Scheduler](node-windows.md), or [macOS launchd](node-macos.md).

## Web Fetch browser preparation

The Node npm package runs `postinstall` to prepare Chromium for its pinned Playwright version, reusing matching caches. Managed upgrades explicitly prepare the browser before switching versions even when npm lifecycle scripts are disabled; preparation failure keeps the previous version active. `mar-node install` / `upgrade` also run preparation. Ordinary startup and tool calls never download browsers.

Install under the final service account. The default cache belongs to the installation account. If installation and execution use different accounts, set the same `PLAYWRIGHT_BROWSERS_PATH` in both environments and grant the service account read/execute access. Offline deployments can prepopulate matching platform/version Chromium binaries and set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Skipping does not establish browser availability. For manual preparation, run `scripts/install-web-browser.mjs` inside the installed Node package.

The npm control library, browser binaries, and Linux system libraries are separate. Node downloads browser binaries but never runs sudo/UAC or installs system packages automatically. For `MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE`, first check matching caches, account access, and paths. Minimal Linux hosts may also need Chromium system libraries installed by an administrator. HTTP mode does not require Chromium; errors never trigger an automatic mode switch.

Generated services default to `web-browsers/` in the Node data directory and use the same path for preparation and execution, preserving an explicit `PLAYWRIGHT_BROWSERS_PATH`. Linux units retain `ProtectSystem=strict` and allow writes to that cache; managed upgrades inherit the service environment. Existing services adopting this flow must regenerate and apply their service definitions using the platform guide. Node does not modify deployed services or accounts automatically. The final service account still needs read/execute access.
