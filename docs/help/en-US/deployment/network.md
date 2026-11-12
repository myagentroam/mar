---
title: Network, TLS, and WebSocket
lastUpdated: 2026-11-12
---

# Network, TLS, and WebSocket

Server supports external HTTP/HTTPS with WS/WSS respectively, without additional public-network, LAN, or loopback restrictions. `MAR_PUBLIC_ORIGIN` must exactly match the browser-facing scheme, host, and port. [npm Quick Start](../getting-started/npm-quick-start.md#remote-access) defaults to loopback binding and also supports an external entry point through environment variables.

Browsers and Nodes use the configured public origin. Server serves Web, help, API, and WebSocket traffic on one HTTP listener. You may expose HTTP directly or terminate TLS in external infrastructure. A reverse proxy must forward the complete site and WebSocket Upgrade, with suitable long-connection timeouts. Keep Web, API, and WebSocket on the same public entry point; do not connect an HTTPS page to plaintext HTTP APIs or WS. Cookie Secure defaults to the public origin scheme, without an additional HTTP opt-in. HTTPS protects against network interception and tampering and is recommended on untrusted networks.

Nodes initiate outbound HTTP/WS or HTTPS/WSS connections and expose no browser HTTP API. Ordinary Workspace files, Git, and terminals can use an authorized LAN connection when their respective capabilities are available; hosted conversations do not use this path. When enabled, WebRTC ICE obtains one UDP port from `directTransfer.udpPortRangeBegin..udpPortRangeEnd`, which defaults to `49152-49215`, and ICE UDP Mux reuses that port. Permit the configured range only from the actual browser LAN and never expose it to the public Internet. Set both values to the same port for an exact firewall rule, and use different ports for multiple Nodes on one host. If the port is blocked, traffic can use the Server relay without taking the Node offline; a transfer already in progress can still fail and need a retry.

Allow long-lived Server connections and timeouts suitable for Agent runs. Disable caching for authenticated API responses and upgraded traffic.

When connections fail, test DNS, system time, certificate chains, proxy headers, and outbound firewall policy from both the browser network and Node host.

## Browser capabilities

The online workbench works over HTTP; internal UUID and SHA-256 do not depend on a secure context. Clipboard, PWA installation, Service Worker offline caching, system notifications, and Web Push depend on browser APIs, permissions, and external services. Unavailable capabilities degrade without blocking other operations. Ordinary external HTTP generally lacks secure-context browser capabilities; loopback addresses may be an exception. Configure an independent Web Push contact with `MAR_WEB_PUSH_SUBJECT` (`mailto:` or HTTPS); HTTPS sites default to their public origin when it is unset.
