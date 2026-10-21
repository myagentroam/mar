---
title: Production Deployment and Reverse Proxy
lastUpdated: 2026-10-11
---

# Production Deployment and Reverse Proxy

Set `MAR_PUBLIC_ORIGIN` to the exact browser-facing HTTPS origin. Compose stores Server data below its `./data` binding; protect and back up that directory. Point `MAR_SERVER_SSH_DIR` to a dedicated deployment account's `.ssh` directory and grant it only the repository access Server needs.

Proxy the complete site to host port `5190`, which maps directly to the unified Server listener on the same port. Server serves Web, `/docs/`, API, and WebSocket traffic without a separate product Web/Nginx service. Keep all paths on the same browser-facing origin. Preserve `Upgrade` and `Connection` headers and use timeouts long enough for Agent runs and terminals.

Expose only HTTPS publicly. Keep MySQL, Server loopback ports, Node private storage, SSH keys, and deployment environment files private.
