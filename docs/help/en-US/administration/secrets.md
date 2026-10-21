---
title: Manage Environment Secrets
lastUpdated: 2026-10-13
---

# Manage Environment Secrets

The main secret list requests 20 entries per page from the Server, with search over the complete management scope. Secret configuration in Node or Workspace details is a complete target snapshot and is shown without pagination.

Environment secrets manage API keys, tokens, and other sensitive information required by Agents and terminals. Manage personal and authorized organization environment secrets under **Admin → Environment Secrets**, and manage Node environment secrets in Node details and independent Workspace secrets in Workspace details. Each environment variable name must be a valid identifier. Secret values are visible only to users allowed to manage that scope.

For duplicate names, personal values override Workspace values, Workspace values override Node values, and Node values override the nearest effective organization ancestor. Organization environment secrets stay private to that organization unless explicitly made inheritable by descendants.

Workspace secret management requires permission to manage that Workspace, not permission to manage Node secrets. Permission to use a Workspace does not allow viewing or changing its secret values. Unregistering a Workspace deletes its secrets. These values are not injected into Node-level terminals or hosted conversations.

Start a new Agent run or terminal to verify an update; existing processes retain their earlier environment snapshot. Avoid exposing values in command output, screenshots, messages, or commits.
