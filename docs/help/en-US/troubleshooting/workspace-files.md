---
title: Workspace, File, or Git Issues
lastUpdated: 2026-10-29
---

# Workspace, File, or Git Issues

1. Confirm that the real Workspace path is below a configured `allowedRoots` entry, including after symbolic-link resolution.
2. Read and write the directory as the Node service account; correct ownership, ACLs, and mount permissions.
3. For Git failures, run read-only Git checks as that account in the same directory and verify access to `.git`.
4. Refresh the Workspace in Web. If the directory moved, unregister and register the real new path instead of forcing the old record.

File size, type, search, and download limits may produce a deliberate error even when permissions are correct. Review the displayed error and [Versions, Capacity, and Limits](../reference/limits.md).

Do not add an entire user directory or disk to `allowedRoots` merely to bypass a problem; grant only the required parent directory. For rename, move, or delete failures, check name conflicts, write access to the destination parent, and any uncommitted Git changes before acting. Refresh the file tree afterward to verify the actual result.
