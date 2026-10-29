---
title: Manage Conversation Templates
lastUpdated: 2026-10-29
---

# Manage Conversation Templates

Template management requests 20 entries per page from the Server; sorting covers the complete list, not just the current page. The template selector for creating conversations still shows every available template.

A conversation template publishes the source Workspace’s complete safety-filtered directory tree as an immutable snapshot and defines allowed models, MCP servers, network mode, total conversation storage, and the per-file upload limit. Server stores the editable draft. The selected hosting Linux Node stores the published directory inventory, files and controlled symbolic links, manifest, and MCP configuration snapshot.

## Edition scope

In the Community state, the fixed Admin can create, test, and publish templates on an owned personal Linux Node and use hosted conversations without an enterprise License or organization grants. The Enterprise state requires organization-owned Nodes for shared templates; the organization ownership and grant steps below apply only to the Enterprise state. In either license state, enable hosting in [Node details](nodes-workspaces.md) and confirm that it is available first.

## Prerequisites

- Your account can manage templates. In the Enterprise state, enterprise administrator permission is required to manage template grants.
- At least one online, enabled Linux Node supports conversation hosting, and the source Workspace is registered and readable. The Enterprise state requires an organization-owned Node and does not allow personal Nodes to host shared templates. The Community state uses a personal Node owned by Admin.
- The source Workspace root cannot already contain `inbox/` or `output/`. Those names are reserved for each conversation's writable directories.

## Create, validate, and publish

1. Open **Admin → Chat Templates** and select **New template**.
2. Choose the source Node and Workspace, then enter the name and description. The complete Workspace is published; there is no included-path field. The source is fixed after creation; create another template to use a different Node or Workspace. Follow [Maintain a Conversation Template Workspace](template-workspace-maintenance.md) to separate maintainer documents from runtime template instructions.
3. Select allowed and default models. Candidates come only from effective model grants for the source Node owner. Multiple connection configurations for the same upstream model appear as one option. The template stores the upstream model ID and a current name snapshot rather than a specific connection configuration. While editing, unavailable models are removed and the default falls back to the first remaining option. Save, test, and publish are blocked when no model remains. Reasoning uses the model default, and templates do not configure tools, Skills, or model output limits.
4. Select MCP servers from the source Workspace's currently effective MCP configuration. You cannot type arbitrary IDs. Skills are discovered automatically from `.agents/skills/` in the published image and are not selected or displayed on the template page.
5. Select a network mode:
   - **No network:** local processes cannot use the network, and Web tools, model Hosted Web, and remote HTTP MCP are unavailable. Sandboxed local stdio MCP can still run offline.
   - **Unrestricted:** sandboxed processes, Node-local Web Fetch, available Web Search, model Hosted Web, and selected remote HTTP MCP can reach networks available to the Node. File and process isolation still apply.
6. Set total conversation storage and the per-file upload limit in MiB, then save the draft.
7. While editing an existing draft, select **Test draft**. This validates the complete Workspace, exclusions, reserved paths, file types, symbolic links, models, MCP, network, and quotas without creating a test conversation, Agent session, or persistent directory.
8. Select **Publish** and confirm the current configuration. The page waits for this publication result. Success creates the next sequential published version, such as `1`, `2`, or `3`. Only a successful publication increments the version; editing or saving the configuration alone does not. Each version contains directory, file, and link inventories, per-file hashes, a whole-content hash, and an MCP configuration hash. Later Workspace, MCP, or draft changes do not modify an existing published version.

Publishing excludes root `README.md` and root `AGENTS.md`, then publishes the optional root `AGENTS.template.md` as `AGENTS.md`; that template-instruction source must be a regular file. Sensitive content such as `.git`, `.mar`, `.env*`, credentials, and explicit key files is also excluded. `node_modules`, `.venv`, normal dependencies, and hidden workflow resources remain part of the complete snapshot. Regular files and empty directories are retained. A symbolic link is allowed only when it resolves inside the same snapshot or into the sandbox’s fixed read-only `/usr`, `/bin`, `/sbin`, `/lib`, or `/lib64` runtime trees. Broken, cyclic, escaping, excluded-target links and special files such as sockets, devices, and named pipes fail publication. Resolve the reported source, reserved `inbox/output`, MCP, link, capacity, file-change, or Node interruption issue and publish again. If the page reaches its wait limit, publication may still continue. Refresh the list or details later and check whether the published version increased.

## Published versions, template status, and access

- **Details** shows the current published version and published records ordered by descending version number. Each record includes the published version, file count, size formatted as `B/KB/MB/GB`, and publication time. The page does not expose internal publish jobs or internal version status.
- **Disable version** prevents new conversations and later automatic upgrades from selecting that version. Existing conversations already bound to it remain available.
- Each version stores one independent Workspace snapshot. Conversations share it through a read-only mount instead of receiving per-conversation copies.
- Publishing a new version does not immediately rewrite existing conversations. Before each new Run, Node queries and fully validates the latest available version, then starts the Run with that candidate. The switch becomes atomic only after the Run starts successfully and the message is accepted. If the upgrade fails, the current send fails while the old version, history, and writable files remain intact; the next send queries and retries again.
- **Archive** stops future use. **Delete** removes the template from new-conversation catalogs while existing conversations retain their template-name snapshot and last active version.
- In the Enterprise state, **Grant** selects an organization under the hosting Node's owning organization. Selecting the root organization makes the template available to everyone in the enterprise; there is no separate **Entire enterprise** target, and templates cannot be granted directly to one user. Users without an effective organization grant do not see the template in **Chat**. A valid template grant is sufficient to create, view, and continue the user's own hosted conversations, but it does not grant access to the hosting Node, source Workspace, ordinary files, or terminal.

**Success:** the template is shown as **Published**, and an authorized user can explicitly select it from the main **Chat** entry.

Maintain the source directory: [Maintain a Conversation Template Workspace](template-workspace-maintenance.md).

Next: [Start a conversation from a template](../workbench/hosted-conversations.md).
