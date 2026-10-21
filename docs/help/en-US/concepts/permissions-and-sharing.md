---
title: Users, Organizations, and Resource Access
lastUpdated: 2026-10-21
---

# Users, Organizations, and Resource Access

Community Edition has the fixed `admin` account and no limit on registered Nodes. An Enterprise license enables organizations, roles, resource sharing, SSO, and auditing.

| Role                       | Scope                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| System Administrator       | System features and registration governance for every Node; resource use still requires ownership or authorization |
| Organization Administrator | Permitted users and resources in the organization and its descendants                                              |
| Member                     | Personal resources and authorized organization resources                                                           |

Nodes and Workspaces belong either to a person or an organization. Personal resources cannot be shared. Organization resources can be granted to users or organizations; selecting the root organization covers the entire enterprise, with no separate “entire enterprise” tier. A grant provides use of the corresponding resource but does not grant deletion, re-sharing, or ownership changes.

Every resource operation checks the current authorization again. With a Workspace-only grant, the Server uses only canonical Node resource responses to establish the Workspace of Sessions, Runs, and terminals, never messages, logs, or tool output. Requests with unknown or conflicting scope are denied rather than falling back to broader Node access.

Session names and Run associations in audit records are best-effort context and may be unavailable after cache eviction or disconnection. This does not change resource permissions or affect operation results.

System administrators can list and govern every registered Node, including another user's personal Node, because Node registrations consume Server connection and management resources. This does not grant use of the Node, its Workspaces, files, terminals, or Agents, and it does not extend to personal models, credentials, or catalogs. Organization administrators remain limited to their organization subtree.

When a license is frozen, configured resources remain readable and normal work can continue, while management writes are restricted. Import a valid license to restore them.

Next: [Manage Users, Organizations, and Roles](../administration/users-organizations.md).
