---
title: Install and Register a Node
lastUpdated: 2026-11-12
---

# Install and Register a Node

Only one Node runtime may use a local data directory at a time. A duplicate start exits with `NODE_DATA_DIRECTORY_IN_USE`. Stop the original instance normally through its service or terminal before starting another; do not delete `node-owner.sqlite` to bypass ownership. Supervisor stops its internal retry for that duplicate start, but an external service manager may still restart the service according to its own policy.

Normal restarts and managed upgrades hand over after the old instance exits. An ordinary disconnect does not stop accepted executions, and a replaced control connection does not prove that execution on the old host has ended. Local directory ownership does not fence identities copied to another directory or host; do not copy credentials to bypass a duplicate-instance error.

Use Node.js `>=22.13`, an HTTP or HTTPS Server URL, a dedicated service account, and real Workspace roots writable by that account. Windows, Linux, and macOS work hosts are supported. Hosted conversations require Bubblewrap and run only on Linux Nodes.

For a first connection, you can use [built-in MAR Agent](../runners/mar-agent.md) without an external Agent CLI; an administrator configures and authorizes its model. If you use Codex, Claude Code, or OpenCode, install and configure the corresponding CLI under the same service account.

1. Confirm `commonVersion` in the current product release manifest and install that exact `@myagentroam/node` version. Server/Web, Node, Agent, and Protocol share one version baseline; the manifest's `productVersion` and `commonVersion` must match. Still install the manifest's exact version, not npm's floating `latest`. If the manifest is unavailable, ask the deployment administrator for the exact version. Matching version numbers do not replace protocol and capability compatibility checks.
2. In **Admin → Nodes**, create a registration key. Save the key from the separate success dialog before closing it, then set `registrationToken` in the target Node configuration. The dialog also provides instructions and a deployment guide. Creating a registration key does not connect the Node.
3. Create a private configuration containing `serverUrl`, the token for first registration, `dataDirectory`, narrowly scoped `allowedRoots`, and optionally a `directTransfer` UDP range. The default pool is `49152-49215`; set the range start and end to the same value when the Node must use one fixed firewall port.
4. Restrict the configuration and entire data directory to the service account. They contain Node credentials, SQLite data, and logs; keep them out of npm package directories, Git, and chats.
5. Verify in the foreground with `mar-node run --config <config-file>`, then configure a Supervisor-backed service for production.

For example, on Linux create a private JSON file, replacing every placeholder with your Server address, service account paths, and one-time registration key:

```json
{
  "serverUrl": "https://mar.example.com",
  "allowedRoots": ["/home/mar-node/workspaces"],
  "dataDirectory": "/home/mar-node/.local/share/myagentroam",
  "directTransfer": { "udpPortRangeBegin": 49152, "udpPortRangeEnd": 49215 },
  "registrationToken": "registration-key-from-console"
}
```

On Windows or macOS, use absolute paths appropriate to that service account; see the platform guides below. After registration, Node writes its ID and credential back to the configuration; the used `registrationToken` can be removed. When upgrading a configuration using the old `databasePath`, replace it with the containing `dataDirectory` and confirm the database is named `node-runtime.sqlite`; Node rejects the old field and does not move the data automatically.

For step 1, replace the placeholder before running:

```bash
common_version='<commonVersion from the product release manifest>'
npm install --global "@myagentroam/node@${common_version}"
npm list --global "@myagentroam/node@${common_version}" --depth=0
```

Supervisor stores versioned installations in the service account's writable Node data directory without sudo or UAC. After initial service setup, management upgrades only to the highest published stable npm version that meets the business baseline and does not exceed the current Server version, following explicit confirmation, and sends the selected exact version to Supervisor. See [Upgrade MyAgentRoam](upgrade.md).

After setting up automatic startup, restart the service or host and confirm that Node reconnects and its upgrade status is not **Enable Supervisor manually**. A Node without Supervisor must first be installed manually at a version meeting the current business baseline and have its startup entry changed; it cannot bootstrap Supervisor through an unsupported remote operation.

After registration, open a Workspace and verify files, terminals, and Agent sessions. The Node needs outbound HTTP/WS or HTTPS/WSS and exposes no browser HTTP API. For authorized ordinary Workspace file, Git, and terminal direct connections, permit the configured UDP range only from the browser LAN; the Server relay remains available when direct connection cannot be established. A transfer already in progress can still fail and need a retry. Each Node process uses ICE UDP Mux to reuse one selected port. Multiple Nodes on one host can share the default pool and select separate free ports; assign distinct fixed ports or non-overlapping ranges when each Node needs isolation. For missing Agents, reproduce discovery under the service account; for MCP or Python failures, verify the exact `npx`, Python, and pip commands reported in Node details.

Configure automatic startup for the target platform: [Linux systemd](node-linux.md), [Windows Task Scheduler](node-windows.md), or [macOS launchd](node-macos.md).

## Web Fetch browser preparation

The Node npm package runs `postinstall` to prepare Chromium for its pinned Playwright version, reusing matching caches. Managed upgrades explicitly prepare the browser before switching versions even when npm lifecycle scripts are disabled; preparation failure keeps the previous version active. `mar-node install` / `upgrade` also run preparation. Ordinary startup and tool calls never download browsers.

Install under the final service account. The default cache belongs to the installation account. If installation and execution use different accounts, set the same `PLAYWRIGHT_BROWSERS_PATH` in both environments and grant the service account read/execute access. Offline deployments can prepopulate matching platform/version Chromium binaries and set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Skipping does not establish browser availability. For manual preparation, run `scripts/install-web-browser.mjs` inside the installed Node package.

The npm control library, browser binaries, and Linux system libraries are separate. Node downloads browser binaries but never runs sudo/UAC or installs system packages automatically. For `MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE`, first check matching caches, account access, and paths. Minimal Linux hosts may also need Chromium system libraries installed by an administrator. HTTP mode does not require Chromium; errors never trigger an automatic mode switch.

Generated services default to `web-browsers/` in the Node data directory and use the same path for preparation and execution, preserving an explicit `PLAYWRIGHT_BROWSERS_PATH`. Linux units retain `ProtectSystem=strict` and allow writes to that cache; managed upgrades inherit the service environment. Existing services adopting this flow must regenerate and apply their service definitions using the platform guide. Node does not modify deployed services or accounts automatically. The final service account still needs read/execute access.
