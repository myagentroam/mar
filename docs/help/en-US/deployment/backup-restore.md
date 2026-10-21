---
title: Backup and Restore
lastUpdated: 2026-09-25
---

# Backup and Restore

Back up data according to its owner; a Server-only backup is not sufficient.

| Data                               | Location and backup requirement                                                                                                                                                                                                                                      | Restore check                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Server database                    | Always back up MySQL accounts, registrations, grants, models and credentials, template catalog, enterprise configuration, and audit records                                                                                                                          | Sign-in, resources, and configuration are readable                                 |
| Server persistent files            | Also back up `MAR_DATA_DIR`, including the runtime-ticket signing key and Skill cache; enterprise Compose defaults to the deployment directory's `data/`                                                                                                             | Configuration and Skill catalog are usable                                         |
| Node identity and index            | Back up the private Node JSON and `dataDirectory`; `node-runtime.sqlite` contains resource settings and hosted indexes                                                                                                                                               | Original Node identity and Workspaces work                                         |
| Templates and hosted conversations | When hosting is used, back up the entire directory selected by `conversationHosting.storeDirectory` within `dataDirectory` (default `hosted-conversations`), including published templates, conversation history, uploads, and outputs; SQLite alone is insufficient | Existing conversations, attachments, outputs, and published templates are readable |
| Ordinary MAR Agent history         | Back up the Node service account's `~/.mar/agent/`, including sessions and related generated files; this does not replace the hosted-directory backup                                                                                                                | Ordinary history and related files are readable                                    |
| Workspaces and other Agents        | Back up required source, Git, business data, installed Skills, and other Agents' officially documented configuration/history; protect deployment-account repository credentials separately                                                                           | Files, Git, Skills, and Agent authentication work                                  |

Resolve actual paths from the service account, Node configuration, and Compose mounts; see [Ports and Data Locations](../reference/ports-paths-data.md). Logs are not backups. Active runs, queues, Goals, and terminals are not recoverable runtime state.

## Before backing up

1. Choose a maintenance window and stop Node, Server, and other application writes. For a logical backup, keep MySQL running, export with a database backup tool, then back up persistent directories. For a cold backup, shut down MySQL cleanly before copying data according to the chosen tool's requirements. Database and files must belong to the same maintenance window; do not copy live database files directly.
2. Record the Server/Web product version, Node common-component version, configuration paths, mounts, and service-account permissions so that database and file restoration use matching versions.
3. Encrypt backups, restrict access, and rehearse in an isolated environment before considering them recoverable.

## Restore

**Keep an untouched complete backup before starting restored services.** After recovering its hosted store, Node immediately runs inactive-conversation cleanup, then repeats it every 24 hours; the default threshold is 60 days. Conversations in an old backup may already qualify for deletion on the first startup. Check `conversationHosting.inactiveRetentionDays`, backup age, and retention requirements offline first. Start only a disposable isolated copy for the rehearsal, never the only backup.

1. Stop affected services and restore the database, persistent directories, and configuration from the same backup set into an isolated environment, initially using matching application versions.
2. Prevent restored copies from connecting to production Server. Never run two instances with the same Node identity. If identity continuity cannot be guaranteed, [register a replacement Node](../getting-started/connect-node.md) and recheck resource relationships.
3. Start Server and verify health and sign-in. Start Nodes one at a time and check Workspace paths and service-account permissions.
4. Read ordinary sessions and files. If hosting is used, open an existing conversation, read uploads and outputs, create a test conversation from a published template, and perform a read-only request.
5. Switch the production services only after validation. Runs, queues, Goals, and terminals active before Node restarted are not restored; do not assume their work completed.

**Success:** registrations and Agent history are readable, and new tasks and terminals can be created.

Backups may contain credentials and source code. Encrypt them, restrict access, and rehearse recovery.
