---
title: Network, TLS, and WebSocket
lastUpdated: 2026-10-11
---

# Network, TLS, and WebSocket

Browsers and Nodes use the same HTTPS origin. `MAR_PUBLIC_ORIGIN` must exactly match its scheme, host, and port. Server serves Web, help, API, and WebSocket traffic on one HTTP listener. External infrastructure terminates TLS. The reverse proxy must present a trusted certificate, forward the complete site, and support WebSocket Upgrade for Workbench and terminal relays.

Nodes initiate outbound HTTPS/WSS connections and expose no browser HTTP API. Ordinary Workspace file direct transfer is the only LAN data-plane exception: at startup, WebRTC ICE obtains one UDP port from `directTransfer.udpPortRangeBegin..udpPortRangeEnd`, which defaults to `49152-49215`, and ICE UDP Mux reuses that port for every Probe and file transfer in the Node process. Permit the configured range only from the actual browser LAN and never expose it to the public Internet. Set both values to the same port for an exact firewall rule, and use different ports for multiple Nodes on one host. If the port is blocked, file operations fall back completely to the Server relay without taking the Node offline.

Allow long-lived Server connections and timeouts suitable for Agent runs. Disable caching for authenticated API responses and upgraded traffic.

When connections fail, test DNS, system time, certificate chains, proxy headers, and outbound firewall policy from both the browser network and Node host.
