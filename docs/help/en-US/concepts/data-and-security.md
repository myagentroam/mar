---
title: Data, Credentials, and Security Boundaries
lastUpdated: 2026-10-29
---

# Data, Credentials, and Security Boundaries

| Location     | Main data                                                                          | Protect                                                    |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Server/MySQL | Accounts, registrations, grants, MAR model keys, enterprise settings, audit events | Backups, TLS, administrator password, access controls      |
| Node         | Private configuration and required Workspace/terminal records                      | Service account, configuration permissions, `allowedRoots` |
| Agent CLI    | Authentication, provider settings, conversation history                            | Official Agent account and configuration directory         |
| Workspace    | Source, Git data, and build outputs                                                | Filesystem permissions, repository credentials, backups    |

Browsers authenticate and obtain authorization through Server; they do not access a general Node API directly. Authorized ordinary Workspace file, Git, and terminal data may use a direct WebRTC connection, falling back to Server relay when unavailable; direct transfer does not replace authorization. Server does not persist terminal output or give Node or Agent credentials to browsers. MyAgentRoam does not replace host patching, disk encryption, least privilege, code review, or Agent security controls.

MAR Agent model API keys are stored as plaintext in Server MySQL but are never returned by query APIs, audit events, or the UI. Tool permission modes do not replace an operating-system sandbox: Host path and resource restrictions still apply, and tools use the Node service account's actual permissions. See [MAR Agent sessions and permissions](../runners/mar-agent.md#sessions-and-permissions) for defaults and approval rules by entry point.

Next: [Backup and Restore](../deployment/backup-restore.md) and the [Production Security Checklist](../deployment/security-checklist.md).
