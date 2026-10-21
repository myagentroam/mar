---
title: Data, Credentials, and Security Boundaries
lastUpdated: 2026-09-18
---

# Data, Credentials, and Security Boundaries

| Location     | Main data                                                                          | Protect                                                    |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Server/MySQL | Accounts, registrations, grants, MAR model keys, enterprise settings, audit events | Backups, TLS, administrator password, access controls      |
| Node         | Private configuration and required Workspace/terminal records                      | Service account, configuration permissions, `allowedRoots` |
| Agent CLI    | Authentication, provider settings, conversation history                            | Official Agent account and configuration directory         |
| Workspace    | Source, Git data, and build outputs                                                | Filesystem permissions, repository credentials, backups    |

Browsers never connect directly to Node, receive Node/Agent credentials, or retain terminal output on Server. MyAgentRoam does not replace host patching, disk encryption, least privilege, code review, or Agent security controls.

MAR Agent model API keys are stored as plaintext in Server MySQL but are never returned by query APIs, audit events, or the UI. MAR Agent has no per-call tool approval; fixed `full-access` is not an operating-system sandbox. Tools use the Node service account's existing permissions, while Host path and resource validation remains active.

Next: [Backup and Restore](../deployment/backup-restore.md) and the [Production Security Checklist](../deployment/security-checklist.md).
