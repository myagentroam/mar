---
title: Production Deployment and Reverse Proxy
lastUpdated: 2026-10-29
---

# Production Deployment and Reverse Proxy

Set `MAR_PUBLIC_ORIGIN` to the exact browser-facing HTTPS origin. Compose stores Server data below its `./data` binding; protect and back up that directory. Point `MAR_SERVER_SSH_DIR` to a dedicated deployment account's `.ssh` directory and grant it only the repository access Server needs.

Proxy the complete site to host port `5190`, which maps directly to the unified Server listener on the same port. Server serves Web, `/docs/`, API, and WebSocket traffic without a separate product Web/Nginx service. Keep all paths on the same browser-facing origin. Preserve `Upgrade` and `Connection` headers and use timeouts long enough for Agent runs and terminals.

For example, after configuring your own TLS certificate and defining `$connection_upgrade` in the Nginx `http` block, proxy the site as follows:

```nginx
location / {
  proxy_pass http://127.0.0.1:5190;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_read_timeout 3600s;
}
```

If not already defined, use `map $http_upgrade $connection_upgrade { default upgrade; '' close; }` in `http {}`. Other proxies need equivalent WebSocket forwarding and should not cache real-time responses. This is a configuration example, not a complete TLS server block.

Expose only HTTPS publicly. Keep MySQL, Server loopback ports, Node private storage, SSH keys, and deployment environment files private.

Verify HTTPS login, public documentation, Node connectivity, and—when appropriate—Agent responses and terminal connections. Refresh a deep `/docs/...` link directly to confirm the proxy serves it. For failures, start with [Network, TLS, and WebSocket](network.md) and the proxy and container health logs.
