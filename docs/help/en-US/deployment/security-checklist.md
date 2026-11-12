---
title: Production Security Checklist
lastUpdated: 2026-11-12
---

# Production Security Checklist

- Match `MAR_PUBLIC_ORIGIN` to the actual HTTP/HTTPS entry point and keep MySQL and internal components private. Set it explicitly behind an HTTPS reverse proxy: without it, Server sees only the internal HTTP listener and cookies do not automatically get `Secure` by default. HTTP is plaintext; HTTPS is recommended on untrusted networks.
- Replace the initial administrator password and review active sign-in sessions.
- Use dedicated, unprivileged Server and Node accounts with private configuration directories.
- Keep `allowedRoots` narrow; review filesystem ownership, ACLs, symbolic links, and mounts.
- Give Server SSH credentials only the repository access required for configured sources.
- Protect database, Node, Workspace, Agent, and repository backups and test restoration.
- Grant organization roles, resource access, and secrets by least privilege; review OAuth mappings before enabling SSO.
- Monitor audit events and service logs without printing passwords, tokens, secrets, or License documents.
- Patch hosts, Node.js, reverse proxies, MySQL, Agent CLIs, and MyAgentRoam through controlled maintenance windows.
