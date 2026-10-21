---
title: Configuration Reference
lastUpdated: 2026-10-11
---

# Configuration Reference

Server deployment configuration includes the public HTTPS origin, MySQL connection/credentials, persistent data directory, and optional read-only SSH directory for repository sources. Secrets belong in protected environment or deployment files, never in Web assets.

`MAR_SEARXNG_SECRET` is required by Compose and must contain a long random value used only by the private SearXNG service.

Node private configuration includes the Server URL, first-registration token or persisted identity credentials, data directory, and `allowedRoots`. The Node writes identity after registration; protect the complete file and data directory. Agent and provider configuration remains owned by each Agent under the Node service account. Configure sensitive values through [Environment Secrets](../administration/secrets.md), not in public examples or Git.

Under **System Configuration > HTML preview origin**, an administrator can set an HTTPS origin on a different hostname, such as `https://preview.example.com`. Set the Console's `MAR_PUBLIC_ORIGIN` first, then configure DNS, TLS, and a reverse proxy that forwards only the same Server's preview resource routes. Changing the port alone does not isolate cookies. An empty setting uses the Console origin: HTML/JS then runs with the signed-in account's permissions, without workbench isolation. HTML can load files in its directory and subdirectories and make external requests; run only trusted files.

Ordinary Workspace file direct transfer uses the shared UDP port pool `49152-49215` by default. At startup, each Node process obtains one free port from its configured range and uses ICE UDP Mux so every Probe and file-transfer PeerConnection in that process reuses the same port. Override the pool with both `directTransfer.udpPortRangeBegin` and `directTransfer.udpPortRangeEnd`; values must be within `1024..65535`, ordered, and span no more than 256 ports. Set both values to the same port for a fixed single-port deployment, or assign non-overlapping ports or ranges when multiple Nodes require isolation. Permit the configured range only from the actual browser LAN. Exhausted or blocked ranges cause complete Server-relay fallback and do not prevent the Node from connecting.

On a supported online Linux Node, a system administrator can enable Bubblewrap-hosted conversations from Node details. The Node writes `conversationHosting.enabled` to its private configuration and initializes hosting immediately. Existing directory and retention settings are preserved; when absent, the Node uses `hosted-conversations` and `60` days. `conversationHosting.storeDirectory` must be a non-empty relative directory inside `dataDirectory`; absolute paths, `.` and `..` segments, and paths that escape the private data directory are rejected. `conversationHosting.inactiveRetentionDays` accepts `1` through `365`.

Node details can also disable hosting. Disable preserves the hosted directory, SQLite index, and conversation history, but Node rejects the request while a hosted Run is active or starting; it never cancels that Run. Stop Node and back up the private data before changing the directory or retention setting. Automatic inactivity cleanup permanently deletes threshold-qualified conversations. A user-confirmed conversation deletion is also immediately permanent and has no recovery window.

`computerUse.enabled` defaults to `false` when omitted. Use the Node details switch instead of editing it manually. Enabling validates the locked managed runtime included with the Node release and probes the current interactive desktop asynchronously; it never invokes pip or downloads packages. A missing or damaged managed runtime leaves the capability unavailable with a stable reason instead of falling back to another Python installation. `computerUse.runtimeExecutable` is reserved for development and validation overrides and should not be used in production configuration.

Use the exact names and examples in the current release deployment files. Restart the owning service after changing startup configuration and verify health before proceeding.

`MAR_AGENT_WEB_FETCH_ALLOW_UNTRUSTED_TLS` defaults to `1`, so MAR Agent Web Fetch accepts self-signed or otherwise untrusted HTTPS certificates. Set it to `0` in the Node service environment to enforce certificate verification, then restart the Node. This setting is security-sensitive.

All deployments require a valid real host UUID. Containers must mount `/sys/class/dmi/id/product_uuid` read-only at `/license-host/product_uuid`; the source must exist. Native deployments may use `MAR_LICENSE_HOST_PATH` to select the real UUID file. Community and Enterprise share this requirement.
