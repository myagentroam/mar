---
title: Production Security Checklist
lastUpdated: 2026-08-24
---

# Production Security Checklist

- Serve only through a trusted HTTPS origin and keep MySQL and Server internal ports private.
- Replace the initial administrator password and review active sign-in sessions.
- Use dedicated, unprivileged Server and Node accounts with private configuration directories.
- Keep `allowedRoots` narrow; review filesystem ownership, ACLs, symbolic links, and mounts.
- Give Server SSH credentials only the repository access required for configured sources.
- Protect database, Node, Workspace, Agent, and repository backups and test restoration.
- Grant organization roles, resource access, and secrets by least privilege; review OAuth mappings before enabling SSO.
- Monitor audit events and service logs without printing passwords, tokens, secrets, or License documents.
- Patch hosts, Node.js, reverse proxies, MySQL, Agent CLIs, and MyAgentRoam through controlled maintenance windows.
