---
title: Maintain a Conversation Template Workspace
lastUpdated: 2026-09-14
---

# Maintain a Conversation Template Workspace

A conversation template’s source Workspace serves two purposes: maintainers continuously edit, test, and document the template there, while publication creates the read-only version used by ordinary users. Separate maintenance documents from runtime template instructions so maintainer guidance does not enter user conversations.

## Recommended layout

```text
template-workspace/
├── README.md
├── AGENTS.md
├── AGENTS.template.md
├── .agents/
│   └── skills/
├── knowledge/
├── scripts/
└── ...
```

The three root files have different roles:

- `README.md`: maintainer-facing goals, dependencies, validation steps, release procedure, and version notes. Publication excludes it.
- `AGENTS.md`: instructions for Agents maintaining the source Workspace, such as how to edit material, run checks, and preserve compatibility. Publication excludes it.
- `AGENTS.template.md`: instructions for the Agent using the published template. Publication renames it to `AGENTS.md` at the snapshot root; the source name is not retained.

`AGENTS.template.md` is an optional regular file. A template can be published without it, but the published version then has no root `AGENTS.md`. Draft validation and publication fail if that path is a directory, symbolic link, or another special file. These special rules apply only at the Workspace root; documents with the same names in subdirectories remain ordinary template content.

## Write template instructions

Template instructions should describe the user task, available reference material, delivery format, and necessary quality requirements. Do not include maintainer commands, publishing accounts, physical host paths, or secrets. The Host already declares the read-only template root, writable directories, network mode, and sandbox boundary; template instructions must not try to relax those controls.

A minimal example:

```md
## Conversation instructions

- Read user-provided files from `/workspace/inbox`.
- Read `/workspace/inbox/AGENTS.md` when it exists and follow its conversation-specific requirements.
- Automatically identify requirements or working conventions that the user directly states or reasonably clearly implies should apply to later Runs. Maintain `/workspace/inbox/AGENTS.md` as concise current rules after preserving unrelated instructions; do not save ambiguous or one-off guidance.
- Keep disposable intermediate work in `/tmp`. It can be reused by later Runs in this conversation, but the host may clear it.
- Place final deliverables under `/workspace/output`.
- Use the reference material under `/workspace/knowledge`.
- Do not invent missing facts; state what additional input is required.
```

Conversation-scoped `/tmp` is excluded from related files and persistent quota. Later Runs in the same conversation can reuse it, but the host may clear it under the system temporary-directory policy, so it must not be the only long-term copy. Put final deliverables and working files that the user must inspect or download under `/workspace/output`.

## Distinguish maintenance, draft validation, and runtime environments

These stages use the same source content but have different execution environments:

| Stage                               | Directory and process behavior                                                                                                                    | What it proves                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Source Workspace maintenance        | Edits the live, writable source directory directly. An Agent or terminal in a regular Workspace is not the hosted-conversation sandbox            | Whether content, scripts, and dependencies work in the maintenance environment                                                                 |
| **Test draft** static validation    | Scans a fixed draft revision and checks exclusions, reserved paths, file types, links, models, MCP, network settings, and quotas without an Agent | Whether a safe publication candidate can be formed; not whether scripts, imports, networking, MCP calls, or writes work in a real conversation |
| A published conversation's real Run | Uses an immutable publication snapshot, conversation-private writable directories, and the Linux Bubblewrap sandbox                               | Complete template behavior in the environment used by end users                                                                                |

Success in the source Workspace and a successful **Test draft** do not replace post-publication validation. After publishing, maintainers should create a conversation as an authorized user and run at least one small acceptance task that exercises the primary script, dependencies, input, and output.

## Directory mappings after publication

The Agent's canonical Workspace is `/workspace`. Commands start from that logical Workspace, and relative template paths are resolved from it.

| Path inside the sandbox                                            | Access and lifetime                                                      | Maintainer guidance                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/workspace`                                                       | Read-only immutable published version                                    | Template material, scripts, Skills, and packaged dependencies. Runtime processes cannot modify, install into, or generate files under this tree                          |
| `/workspace/inbox`                                                 | Writable, private to the conversation, retained across Runs              | User uploads, input files, and conversation `AGENTS.md`; appears in related files and counts toward persistent quota                                                     |
| `/workspace/output`                                                | Writable, private to the conversation, retained across Runs              | Working files and final deliverables; appears in related files and counts toward persistent quota                                                                        |
| The source Workspace's canonical absolute path at publication      | Compatibility alias for the same read-only snapshot                      | Supports sealed dependencies such as absolute virtual-environment shebangs and editable packages; its `inbox/` and `output/` aliases refer to the same writable data     |
| `/tmp`                                                             | Writable and conversation-private; reused across Runs but may be cleared | Disposable caches, intermediate results, and resumable state; excluded from related files and persistent quota, so it must not be the only copy                          |
| `HOME=/home/mar`                                                   | Writable in-sandbox tmpfs; disappears no later than the end of each Run  | Temporary HOME data, tool caches, and runtime configuration; do not assume that another local process or later Run can see its contents                                  |
| `/home/mar/.mar/agent/sessions/<sessionId>/generated_images/`      | Read-only view of generated images for the current Session               | Read existing generated images and explicitly copy deliverables to `/workspace/output`; never hard-code a concrete `sessionId`                                           |
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, and the Node.js runtime | Read-only runtime from the hosting Node                                  | Provides system commands, shared libraries, and Node.js. Available commands and versions depend on the hosting Node and may differ from a maintainer's interactive shell |
| `/etc/fonts` and `/etc/libreoffice`                                | Fixed read-only allowlist when the host directories exist                | Provides Fontconfig and office-runtime configuration and resolves system links from `/usr`; the complete `/etc` tree is not mounted                                      |

Session history, other Sessions, other users or conversations, Node configuration, `/etc` content outside the allowlist, the host HOME, the live source Workspace, and credential directories are not mounted into the sandbox. The Agent accesses the published snapshot at `/workspace`, not the directory that administrators continue to edit. The Web **Related files** panel shows only uploads and outputs for the current conversation and does not expose a template-root browser.

## Path guidance

Use paths in this order of preference:

1. Prefer relative paths for template-owned resources, such as `knowledge/policy.md`, `scripts/render.sh`, or `./.venv/bin/python`.
2. When the Workspace boundary must be explicit, use the stable sandbox path `/workspace/...`. Use `/workspace/inbox`, `/workspace/output`, and `/tmp` for input, output, and temporary data.
3. Do not add the source Workspace's physical host path, such as `/home/admin/templates/example`, to new scripts, Skills, configuration, or template instructions. Its read-only alias exists only to support already-sealed content such as virtual-environment shebangs and editable packages; it is not a new template interface.
4. Do not hard-code a Session ID, conversation ID, user directory, Node data directory, or complete `/home/mar/.mar/agent/sessions/...` path. The Session ID in the generated-image path varies by conversation.
5. Do not write to the `/workspace` root, template subdirectories, system runtime directories, or the source-path alias. Those locations are read-only. Runtime writes belong under `inbox/`, `output/`, or `/tmp`.

The canonical `/workspace` sandbox paths are safe absolute paths. The paths to avoid are **physical host absolute paths**. Relative paths usually make local maintenance and hosted execution easier to reuse, while explicit `/workspace/inbox` and `/workspace/output` paths make input and delivery behavior clear.

Published `.venv/`, `node_modules/`, and other dependencies are read-only at runtime. Install and build them in the source Workspace before testing and publishing; do not design a template to modify those directories during each conversation Run. Temporary downloads, extraction, and caches can use `/tmp`, with durable or user-facing results copied to `/workspace/output`.

## Sandbox, environment, and network rules

- Hosted conversations run only on an enabled organization-owned Linux Node that passed capability probing. Every local command and local stdio MCP process must enter the Bubblewrap sandbox. If the sandbox is unavailable, the policy is invalid, or a mount fails, the Run is rejected rather than falling back to direct host execution.
- The sandbox exposes only the documented mounts and a limited read-only system runtime. It isolates user, process, hostname, and IPC namespaces, uses a separate cgroup namespace when supported, drops Linux capabilities, and applies seccomp and process resource limits. Fixed `full-access` removes per-operation application prompts but does not relax these boundaries. See [System limits](../reference/limits.md) for per-process CPU, address-space, process-count, file-descriptor, and file-size limits.
- Processes start from a clean environment. The Host fixes `PATH`, `HOME=/home/mar`, `TMPDIR=/tmp`, and locale variables, then adds only variables explicitly permitted for the current tool or published MCP server. Do not depend on a maintainer's login profile, shell aliases, current directory, SSH agent, global proxy variables, or source Workspace `.env` files.
- **No network** isolates local process networking and also disables Web Search, Web Fetch, model Hosted Web, and remote HTTP MCP. Local stdio MCP can still run offline.
- **Unrestricted** allows those components to reach networks available from the hosting Node, but it does not guarantee DNS, proxy, firewall, service, or credential availability and does not change file or process isolation.
- Never echo secrets into template instructions, diagnostic output, `inbox/`, `output/`, or logs. Excluding `.env*` and credential files is a publication safeguard, not a secret-management system.

## Debug the runtime environment

In a post-publication acceptance conversation, ask the Agent to run these minimum checks. Print only known non-sensitive variables; do not use `env`, `set`, or read `/proc/*/environ`:

```sh
pwd
printf 'HOME=%s\nTMPDIR=%s\nPATH=%s\n' "$HOME" "$TMPDIR" "$PATH"
test -r /workspace
test ! -w /workspace
test -w /workspace/inbox
test -w /workspace/output
test -w /tmp
```

Then validate the capabilities used by the template:

- Read one template resource through a relative path and run the primary entry point. Confirm that neither depends on the maintenance shell's working directory or a physical host path.
- Read test input from `/workspace/inbox`, write the final result to `/workspace/output`, and confirm that the user can preview or download it from related files.
- Put disposable intermediate state in `/tmp` and resume it during the next Run of the same conversation. Also ensure the task can recover from durable input and output if `/tmp` has been cleared.
- For `.venv/`, `node_modules/`, native extensions, or system commands, validate interpreter paths, shared libraries, architecture, and command versions in the hosted Run rather than only in the source Workspace's maintenance shell.
- Validate networking and MCP under the template's selected mode. A no-network template must treat external access as unavailable; an unrestricted template must still report DNS, timeout, proxy, and service failures clearly.
- Verify that the template root and normal template subdirectories are not writable and that the task never tries to modify the published snapshot.

A new conversation uses the newly published version directly. An existing conversation attempts to upgrade when its next Run starts. When debugging an upgrade, validate both a new conversation and an existing one so continued operation on the old active version is not mistaken for success of the new version.

## Separate template rules from per-conversation memory

The three `AGENTS` files have distinct responsibilities:

| File                                       | Maintainer and scope                                                                                                                                  | Publication and runtime behavior                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source Workspace root `AGENTS.md`          | Template maintainers and maintenance Agents; controls how to edit, test, and publish the source Workspace                                             | Excluded from publication and unavailable to ordinary hosted conversations                                                                                  |
| Source Workspace root `AGENTS.template.md` | Template administrators; defines reusable rules for every conversation that uses the template                                                         | Published into the read-only snapshot as root `AGENTS.md`; changes require draft validation and a new published version                                     |
| Conversation `/workspace/inbox/AGENTS.md`  | The current conversation's user and Agent; stores requirements, preferences, terminology, and working conventions for later Runs in that conversation | Not part of the template; persists across Runs, appears in related files, counts toward persistent quota, and can be viewed, edited, or deleted by the user |

To change rules for all new conversations and existing conversations after they upgrade, edit `AGENTS.template.md` in the source Workspace, run **Test draft**, and publish a new version. An Agent inside a hosted conversation sees an immutable published snapshot. It cannot directly maintain the reusable template and must not describe changes under `inbox/` or `output/` as template updates.

When a user directly or indirectly indicates that a delivery format, fixed terminology, naming convention, quality check, recurring workflow, or similar requirement should continue to apply to later work in the current conversation, the Agent recognizes it automatically; the user does not have to say “remember.” The Agent first reads the existing `/workspace/inbox/AGENTS.md`, then maintains a concise set of current rules by preserving unrelated content, removing duplicates, and replacing or deleting rules that newer guidance contradicts, cancels, or supersedes. It must not automatically save requirements limited to the current task, quoted or third-party material the user asks it to inspect, preferences inferred only by the Agent, secrets, or language that attempts to pre-authorize later destructive actions or external side effects. Current explicit user instructions, Host security boundaries, and published template instructions take precedence over saved conversation rules. Conversation-history Rollback does not roll back this file.

The hosted instruction also requires the Agent to maintain `output/` as the current deliverable set. It keeps revising a stable canonical path for the same logical document, archives an earlier version under `output/bak/` only when it has meaningful rollback value or the user requests history, places assets used by current deliverables in meaningful subdirectories such as `output/assets/`, and keeps exploratory files in `/tmp`. It does not create a backup for every small edit or delete user uploads and unrelated pre-existing files as cleanup.

## What publication includes

- `.agents/skills/`, ordinary dependencies, `.venv/`, `node_modules/`, hidden workflow resources, regular files, and empty directories remain part of the complete snapshot.
- Root `README.md`, root `AGENTS.md`, `.git/`, `.mar/`, `.env*`, credential directories, and explicit key files are excluded.
- Root `AGENTS.template.md` enters the snapshot as `AGENTS.md`.
- Root `inbox/` and `output/` are writable mount points created for each conversation. Do not create those names in the source Workspace.
- A symbolic link may point only inside the same published snapshot or into the sandbox’s fixed read-only runtime directories. Broken, cyclic, escaping links and special files fail publication.

Do not treat publication exclusions as a secret-management system. The source Workspace should contain only material appropriate for its maintainers, and runtime credentials should be supplied through MyAgentRoam secret configuration.

## Recommended maintenance flow

1. Use `README.md` to record the template purpose, required inputs, expected deliverables, dependencies, and manual acceptance steps.
2. Put maintenance constraints in root `AGENTS.md` and user-conversation behavior in `AGENTS.template.md`.
3. After changing reference material, Skills, scripts, or dependencies, run **Test draft** from template management.
4. Resolve source-file, reserved-directory, symbolic-link, MCP, capacity, or model problems before publishing.
5. After publication, create a conversation as an authorized user and verify template instructions, input access, conversation-scoped `/tmp` continuation, current deliverables and `output/bak/` archival under `/workspace/output`, and creation and later-Run loading of `inbox/AGENTS.md` after the user directly or indirectly expresses a continuing requirement.
6. Later source changes do not modify an immutable version. Test and publish another version; existing conversations attempt to upgrade when their next Run starts.

See [Manage Conversation Templates](conversation-templates.md) for administration and [Start a Conversation from a Template](../workbench/hosted-conversations.md) for user-side validation.
