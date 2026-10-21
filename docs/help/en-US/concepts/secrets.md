---
title: Environment Secrets and Injection Order
lastUpdated: 2026-10-11
---

# Environment Secrets and Injection Order

Environment secrets are API keys, tokens, and other sensitive information passed to Agents and terminals through environment variables. They are injected when a new Agent run or terminal starts. For the same name, precedence is **personal, Workspace, Node, nearest effective organization ancestor**; the earlier scope wins.

| Scope        | Typical use                                                   | Management entry    |
| ------------ | ------------------------------------------------------------- | ------------------- |
| Personal     | API keys used only by you                                     | Environment Secrets |
| Workspace    | Project configuration limited to one Workspace                | Workspace details   |
| Node         | Values limited to one Node                                    | Node details        |
| Organization | Shared enterprise values, optionally inherited by descendants | Environment Secrets |

Organization values merge from distant to near ancestors. Node values override organization values, Workspace values override Node values, and personal values have the highest priority. Community Edition has no organization environment secrets.

Workspace secrets apply only to runs, scheduled executions, MCP configuration, and Workspace terminals for that Workspace—not other Workspaces, Node-level terminals, or hosted conversations. Only Workspace managers can view or change the values; permission to use a Workspace does not grant secret management. Unregistering a Workspace deletes its secrets.

Existing runs and terminals keep their original snapshot after an environment secret changes. Values may be shown to authorized managers but are not stored in persistent browser caches.

Environment secrets reduce the need to place values in messages or Git, but terminal processes can still read their environment. Grant the narrowest scope and avoid printing values in logs, screenshots, or commits.

Next: [Manage Environment Secrets](../administration/secrets.md).
