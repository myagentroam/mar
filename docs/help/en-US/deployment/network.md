---
title: Network, TLS, and WebSocket
lastUpdated: 2026-11-10
---

# Network, TLS, and WebSocket

The HTTPS entry point and `MAR_PUBLIC_ORIGIN` configuration below apply to separately managed deployments. [npm Quick Start](../getting-started/npm-quick-start.md#remote-access) defaults to loopback HTTP with a fixed application Origin; it does not read that environment variable override. When accessing it through a secure tunnel, preserve the same browser-side loopback address and port rather than applying the environment variable configuration below.

Browsers and Nodes use the same HTTPS origin. `MAR_PUBLIC_ORIGIN` must exactly match its scheme, host, and port. Server serves Web, help, API, and WebSocket traffic on one HTTP listener. External infrastructure terminates TLS. The reverse proxy must present a trusted certificate, forward the complete site, and support WebSocket Upgrade for Workbench and terminal relays.

Nodes initiate outbound HTTPS/WSS connections and expose no browser HTTP API. Ordinary Workspace files, Git, and terminals can use an authorized LAN connection when their respective capabilities are available; hosted conversations do not use this path. When enabled, WebRTC ICE obtains one UDP port from `directTransfer.udpPortRangeBegin..udpPortRangeEnd`, which defaults to `49152-49215`, and ICE UDP Mux reuses that port. Permit the configured range only from the actual browser LAN and never expose it to the public Internet. Set both values to the same port for an exact firewall rule, and use different ports for multiple Nodes on one host. If the port is blocked, traffic can use the Server relay without taking the Node offline; a transfer already in progress can still fail and need a retry.

Allow long-lived Server connections and timeouts suitable for Agent runs. Disable caching for authenticated API responses and upgraded traffic.

When connections fail, test DNS, system time, certificate chains, proxy headers, and outbound firewall policy from both the browser network and Node host.
