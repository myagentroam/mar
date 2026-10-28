---
title: Workspace Terminals
lastUpdated: 2026-10-29
---

# Workspace Terminals

On mobile, select **Open terminal** in the conversation title bar. Terminal slides up from the bottom as a full-width, half-screen sheet. Select the scrim above it to hide the sheet without ending the terminal; reopening preserves its tabs. Explicitly close a terminal tab to end its process.

Open Terminal to start a shell on the selected Node, normally with the Workspace as its working directory. The process runs with the Node service account and receives the authorized secret snapshot created at startup.

Create additional tabs with the plus action. Collapsing the dock, switching Workspaces, or briefly reconnecting Web does not close a terminal. Closing a tab terminates that process; closing the last desktop tab collapses the dock. Restarting Node ends all terminals.

A new browser page gets its own terminal when you first expand the dock; it does not take over another page's terminal. A read-only attachment can observe output but cannot type. Never use Terminal as a way to bypass Workspace, host, or organizational policy.

When a local direct connection between the browser and Node is available, Node-level and Workspace-level Terminals use it after authorization; otherwise they use the Server relay. Disconnections trigger an automatic fallback or retry with output replay from the last received sequence. No transport selection is needed. The Server continues to authorize and renew direct attachments, while the Node validates Terminal input and write permission. Reconnection stops if access is revoked or the Terminal has ended.

On desktop, selecting terminal text does not copy it automatically. Right-click to open a menu with Copy (available when text is selected), Paste, and Clear; right-click does not send a mouse press to terminal applications. Clear removes displayed output and scrollback while keeping the current cursor line, without sending a shell command or ending the process. If Vim or another application enables mouse mode, hold Shift (Windows/Linux) or Option (macOS) while dragging to select terminal text for copying. Clipboard access may require browser permission. HTTP(S) URLs in terminal output are underlined on hover. Hold `Ctrl` and click, or `Command` and click on macOS, to open a URL in a new browser tab. A normal click does not navigate; local paths and other protocols are not detected.

The limit is 10 terminals per Node and 5 per Workspace. Mobile browsers may restrict background work and keyboard behavior; use a desktop for long-running operations. A new terminal receives an authorized secret environment snapshot, which commands can read: do not publish `env` output, secrets, or terminal screenshots.

If a terminal cannot open, check capacity, the Node connection, authorization, and whether the service account can start its shell. If output stops, wait for reconnection; if Node restarted or access changed, create a new terminal. See [Terminal Troubleshooting](../troubleshooting/terminal.md).

## Personal Git identity and credentials

Open **Settings → Git configuration** to set a complete Git remote address or an SSH-host rule plus a commit name and email for each credential. Set or clear the identity fields together; they are used with that credential. Add HTTPS tokens/passwords or SSH private keys. SSH private keys may use OpenSSH or PEM format; only encrypted keys need an unlock passphrase. The form validates only when saving, so complete addresses and private keys can be pasted first. Secrets cannot be read back after saving. Leave a secret blank while editing to keep it; select the passphrase removal option to clear a stored passphrase.

Enter `https://git.example.com/team/project.git` or `git@git.example.com:team/project.git`; the current user's credential is selected by the normalized protocol, host, port, and complete repository path. If one SSH key applies to every repository on a host, enter `git@git.example.com`; a complete repository rule takes precedence over a rule for the same host. Default ports are 443 for HTTPS and 22 for SSH. Duplicate rules are rejected. In an existing repository, commit identity comes from the credential matched by the current branch upstream, or `origin`. When a complete identity matches, `git config user.name` and `git config user.email` show that effective identity without writing global Git configuration or `.git/config`. Without a matching rule, a remote, or a complete commit identity, existing environment/repository identity and authentication remain in use. A matched credential that fails is not replaced by another personal account.

Create a new terminal after saving, then run ordinary commands such as `git clone https://git.example.com/team/project.git` or `git clone git@git.example.com:team/project.git`. No account-selection command is required. Cloning creates a directory but does not register a Workspace. Git commands executed by Agents in ordinary Workspaces use the initiating user's configuration too; hosted conversations do not use it.

Select **Do not override Git parameters** during Workspace registration, or change it later in Workspace details with management permission. The policy applies to every Workspace user. Existing Workspaces preserve their original configuration after upgrade; new registrations enable personal configuration by default. Users with use permission can read but not change the policy. Enabling preservation keeps the Node/repository identity and authentication without rewriting global Git settings or `.git/config`. A Node below the current business baseline must be [upgraded](../deployment/upgrade.md) before Workspace operations.

A terminal keeps its creator's configuration and creation-time Workspace policy; `cd` does not switch that policy, although credentials still match the actual remote. Close and recreate terminals after changes. Accepted queued inputs and continuing missions retain their original snapshot. Personal Git configuration is injected only into Agent and terminal processes created by MyAgentRoam; it does not rewrite global Git settings, so commands in host terminals, IDEs, and other programs are unchanged. Other users cannot list, attach to or close terminals carrying personal Git configuration.

HTTPS certificate validation remains enabled. Unknown or changed SSH host keys are rejected; ask the Node administrator to maintain known_hosts through a trusted channel instead of disabling verification. Never put tokens in repository URLs, commands, screenshots or logs.
