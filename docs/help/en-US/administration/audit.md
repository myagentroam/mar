---
title: Audit Events and Export
lastUpdated: 2026-10-31
---

# Audit Events and Export

Enterprise audit records are available to authorized administrators in **Admin → Audit Log**. ADMIN can query all events; ORG_ADMIN is restricted to the managed organization subtree, and MEMBER has no audit entry. They cover authentication and management actions, plus accepted user input in organization-shared sessions. Filter by time, event type, outcome, actor, or resource, then open an event for permitted context and error details. An authorized detail can show the plaintext input accepted by a regular Workspace session on an organization-shared Node.

Use page numbers on desktop. On mobile, more events load automatically near the list bottom; if loading fails, retry in place.

Audit records organization-resource writes, controls and execution, including configuration, resource grants, ordinary Workspace session controls, file/Git changes, and writable terminal open. One terminal open produces a single event; authorization, attach and close phases are not recorded separately. Accepted first and follow-up user messages in ordinary organization Workspace sessions are available only in authorized details. Reads, previews, downloads, exports, Watch and heartbeats are not audited. Hosted conversations and personal internal resources are excluded; personal registration, removal and revocation that affect Server registration or identity trust are retained.

Lists and details use **Business: Action**, such as `Node: Rename` and `Session: Send message`, with 24-hour timestamps in your local time zone. Details show actors and named targets, organizations, Nodes, Workspaces, Sessions, and grant recipients as **name / ID**. Missing names fall back to the original ID; current names are not substituted for historical snapshots. Request, operation, Run, and QueueItem IDs remain available for troubleshooting.

Events include structured identifiers and friendly target-name snapshots with safe before/after changes, not HTTP request paths. Audit collection is asynchronous and best effort: failures, overload, disconnects or restarts may lose events, without delaying, rejecting or rolling back normal operations. Missing events are not recovered. Agent replies, file/terminal contents, passwords, cookies, OAuth tokens and secrets are never collected.

Lists, default CSV exports, browser persistence, logs, and metadata never include message text. Only an ADMIN or an ORG_ADMIN who manages the target organization's subtree can read it in one event detail; MEMBER has no audit access. CSV export follows the current user's visibility and active filters. Store exports in a controlled location because they may contain account, network, and resource identifiers.

Retention defaults to 180 days and administrators can configure 1–3650 days. CSV export neutralizes spreadsheet formula prefixes, but use a trusted tool and avoid forwarding exports to untrusted locations.
