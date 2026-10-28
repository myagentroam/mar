---
title: Manage Environment Secrets
lastUpdated: 2026-10-29
---

# Manage Environment Secrets

The main secret list requests 20 entries per page from the Server, with search over the complete management scope. Secret configuration in Node or Workspace details is a complete target snapshot and is shown without pagination.

Environment secrets manage API keys, tokens, and other sensitive information required by Agents and terminals. Manage personal and authorized organization environment secrets under **Admin → Environment Secrets**, and manage Node environment secrets in Node details and independent Workspace secrets in Workspace details. Each environment variable name must be a valid identifier. Secret values are visible only to users allowed to manage that scope.

For duplicate names, personal values override Workspace values, Workspace values override Node values, and Node values override the nearest effective organization ancestor. Organization environment secrets stay private to that organization unless explicitly made inheritable by descendants.

Workspace secret management requires permission to manage that Workspace, not permission to manage Node secrets. Permission to use a Workspace does not allow viewing or changing its secret values. Unregistering a Workspace deletes its secrets. These values are not injected into Node-level terminals or hosted conversations.

Start a new Agent run or terminal to verify an update; existing processes retain their earlier environment snapshot. Deleting a secret affects future runs and terminals but does not revoke values already injected into processes. Avoid exposing values in command output, screenshots, messages, or commits.

If a new run does not see the value, check its creation time, the variable name's case, and higher-priority scopes. If saving fails, check management permission, any frozen state, and the variable name format. If a value appears in logs, revoke or rotate it immediately, clean up public logs, and check whether the command explicitly printed its environment. See [environment secrets and precedence](../concepts/secrets.md) for the security boundary.
