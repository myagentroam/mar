---
title: Node Registration or Offline Issues
lastUpdated: 2026-11-12
---

# Node Registration or Offline Issues

1. Confirm that the Node service is running and inspect its foreground, systemd, or Task Scheduler logs.
2. Verify that `serverUrl` is the browser-facing HTTP or HTTPS origin and that system time is correct.
3. Test DNS, TLS, and outbound HTTP/WS or HTTPS/WSS from the Node host. The control connection does not require a public Node HTTP API; see [network guidance](../deployment/network.md) for optional direct-connection UDP settings.
4. Create a new one-time token after a failed first registration. An already registered Node reconnects with the identity and credentials written to its private configuration.
5. After recovery, verify heartbeat, platform, Agent discovery, and Workspace access in Node details.

Do not start two instances with the same Node identity. A newer instance takes over the connection and the older one must be stopped.

After recovery, reopen a Workspace, read a file, and start a short session to check the connection. Do not delete and re-register a Node merely because of a brief outage: re-registration changes its identity and authorization relationships. If the Node is online but an Agent is unavailable, see [Agent troubleshooting](../runners/runner-troubleshooting.md).

## Online Node Requests Require User Authorization

`USER_AUTHORIZATION_REQUIRED` does not mean that the Node is offline. Connection and heartbeat checks determine online status; operations such as reading Workspaces also require per-request user authorization.

The declared authorization lifetime is at most 15 seconds. The issue and expiry boundaries each allow up to one hour of clock skew, including the boundary, so otherwise valid requests can execute when Server and Node clocks differ by ±1 hour. This tolerance does not extend request timeouts or relax user, session fingerprint, Node, operation, or request ID checks.

Check the actual system time on both hosts; different displayed time zones alone do not indicate clock skew. Synchronize clocks if the skew exceeds the tolerance. If time is correct but requests still fail, record the Node application version, Server request ID, and Node request ID, then correlate logs on both sides to check authorization fields and running-version compatibility. Do not delete and re-register the Node solely because of this error.
