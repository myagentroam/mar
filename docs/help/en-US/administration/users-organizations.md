---
title: Manage Users, Organizations, and Roles
lastUpdated: 2026-10-29
---

# Manage Users, Organizations, and Roles

The user list requests 20 entries per page from the Server; filters and sorting cover every user in your authorized scope. The organization tree is a complete hierarchical configuration and is shown without pagination.

Enterprise administrators first create the organization tree, then create users and assign each user to one organization. Choose Member, Organization Administrator, or System Administrator according to the required management scope. System administrators belong to the root organization.

System administrators can click **Edit** for the fixed `admin` account in the user list to change its display name and email without interrupting its existing Workbench or Terminal connections. Its username, System Administrator role, and root organization cannot be changed. Recovery protection still prevents deletion, disabling, demotion, or removal of its local password; password reset remains unavailable in user management. To change its password, use that account's account security settings.

Assign Nodes and Workspaces to a person or organization. Only organization resources can be shared. Use resource access management to grant the narrowest required user, organization, or enterprise access.

Creating a user or resetting a regular user's password displays the temporary password only once. Deliver it securely; the user must change it at first sign-in. Resetting also revokes that user's existing sign-in sessions. Before deleting users or organizations, move or remove owned resources and review inherited grants.

Enterprise management requires a valid License; Community retains its fixed administrator and personal resources. In the frozen state, restore a valid License before attempting management writes. The root organization cannot be deleted. Removing a user or resource registration does not delete files on the Node host.

If a user or organization is missing, check your managed subtree. If a grant does not provide access, refresh the recipient's resource tree and verify the Node–Workspace organization relationship and the grant's current status. Before deleting an organization, handle its child organizations, members, resources, and SSO references; consult the confirmation instead of assuming resources will be transferred automatically.
