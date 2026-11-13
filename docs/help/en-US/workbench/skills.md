---
title: Favorite and Install Skills
lastUpdated: 2026-11-13
---

# Favorite and Install Skills

Configurable and added catalog lists request 20 entries per page from the Server. Search, ordering and categories cover the complete visible catalog; category tags do not shrink to the current page or search results. Source definitions and the current target’s installed Skill/MCP entries are complete configuration snapshots and are shown without pagination. An installation remains visible if its catalog reference disappears, but only its existing permitted operations remain available; this does not grant reinstallation or changes to inherited configuration.

Open **Admin > Skill Configuration** to browse Skill and MCP entries made available from enabled sources. Skill Configuration, Skill Sources, and Secrets are consecutive flat Admin entries; there is no separate top-level Skills or Skill Center entry.

Choose the Node and, when required, the Workspace before installing. Review version, source, and target status. Updating replaces the installed copy with the selected catalog version; reinstalling restores the same version. If files conflict, inspect the target before approving an overwrite.

Skill Configuration shows installed state and environment checks. Removing an installation does not remove the catalog favorite or its source. Authorized users administer external sources under **Admin > Skill Sources** and configure referenced secrets under **Admin > Environment Secrets**.

## Skill sources and installation

When management writes are enabled, only administrators can enable or disable the preinstalled `skills.sh` source and Official MCP Registry; neither can be deleted. This includes the fixed `admin` account in Community mode and does not grant management access to organization sources, other users' personal sources, or enterprise catalogs.

Skills provide reusable instructions; MCP servers connect Agents to tools and services. Node-level configuration applies to its Workspaces, while a same-named Workspace configuration takes precedence. In **Skill Sources**, choose an enabled source and add a Skill to the available personal, organization, or enterprise catalog. Check its source and version before adding it. Catalog updates do not automatically update installed copies: check for updates, confirm the new version, and install it on each intended target.

Repository sources require a recognizable Git revision. Public Git repositories can use HTTPS; SSH sources use `git@host:owner/repo.git` and the Server deployment account's SSH configuration. Both transports shallow-clone a complete snapshot of the default branch and read Skills locally, without depending on GitHub or GitLab per-file API quotas. HTTPS URLs must point directly to a repository; redirects are not supported. SSH Skill sources skip host fingerprint verification, so use only trusted networks and sources; see [Server deployment](../getting-started/server-installation.md). Sources may use public, private, or local addresses reachable from the Server, without additional DNS or public-IP validation. TLS verification is enabled by default; disabling it for a self-signed source is a separate, high-risk administrator setting. Cache construction, downloads, and installation process content in chunks on disk instead of loading the complete Skill into memory, without separate per-Skill content-size or file-count limits.

Choose an online Node and optionally its Workspace in **Skill Configuration**. Check the environment, then install, update, or reinstall. Node installations use the service account's `~/.agents/skills`; Workspace installations maintain `.agents/skills` and `.claude/skills`, with managed local Git exclusions rather than changes to the tracked `.gitignore`. A Node or browser interruption does not automatically retry an installation. If confirmation times out, refresh the target's actual status before deciding whether to retry. Unknown installed versions can be reinstalled; inspect permission, target path, and environment errors before trying again.

To see a Workspace's shared skills, open the Workspace and choose **Loaded Skills** from the menu next to **New Session**. This list and the Composer's `/` skill list read only the Node account's `~/.agents/skills` and the Workspace's `.agents/skills`, not the `.claude/skills` compatibility directories. Entries show their source, and a same-named Workspace skill takes precedence. Installation and removal remain in **Skill Configuration**; removing a Workspace override can expose a same-named Node entry again.

## MCP servers

In **MCP Sources**, search an enabled Registry, inspect the server and pinned version, and add it to the available catalog. In **Skill Configuration**, switch to the MCP tab, select the online Node or Workspace, and install the intended entry. Node installation uses the Node account's command environment: npm-based entries may download a pinned package via `npx`. MAR validates initialization and reads at least one tool before saving the configuration. Resolve network, authentication, package, or system dependency errors on that Node before retrying.

Changes affect new or reopened Agent sessions, not an already running session. Removing the configuration does not clear npm caches. Environment variables and request headers refer to names in **Environment Secrets**, not secret values; add a missing referenced secret before using the MCP. Use **Loaded MCP** beside **New Session** to inspect the effective Workspace and Node configuration.

For Playwright, add a pinned Registry version and install it on the intended target. Its default browser is headless, each Agent session has an isolated browser context, and browser state is not retained after the session. The Node must be able to run the package and access the target site. If tools are unavailable, verify the target and installation and start a new session.
