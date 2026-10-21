---
title: Manage Users, Organizations, and Roles
lastUpdated: 2026-10-17
---

# Manage Users, Organizations, and Roles

The user list requests 20 entries per page from the Server; filters and sorting cover every user in your authorized scope. The organization tree is a complete hierarchical configuration and is shown without pagination.

Enterprise administrators first create the organization tree, then create users and assign each user to one organization. Choose Member, Organization Administrator, or System Administrator according to the required management scope. System administrators belong to the root organization.

System administrators can click **Edit** for the fixed `admin` account in the user list to change its display name and email without interrupting its existing Workbench or Terminal connections. Its username, System Administrator role, and root organization cannot be changed. Recovery protection still prevents deletion, disabling, demotion, or removal of its local password; password reset remains unavailable in user management. To change its password, use that account's account security settings.

Assign Nodes and Workspaces to a person or organization. Only organization resources can be shared. Use resource access management to grant the narrowest required user, organization, or enterprise access.

Temporary passwords must be delivered securely and changed on first sign-in. Before deleting users or organizations, move or remove owned resources and review inherited grants.
