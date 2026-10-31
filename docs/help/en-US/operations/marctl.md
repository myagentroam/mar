---
title: Manage Nodes with marctl
lastUpdated: 2026-10-31
---

# Manage Nodes with marctl

`marctl` is a Node CLI for the personal and enterprise editions; the Node package includes `marnodes`, `marssh`, and `marscp` entrypoints, for use only in MAR-managed execution contexts. It uses Server authorization to list usable Nodes, open an interactive terminal, run a one-off command, or copy a file. Nodes do not need to expose an SSH port. The `ssh` subcommand is a familiar name, **not the system SSH protocol**.

Ordinary MAR-launched Workbench terminals, Workspace Agent Runs, and their local MCP subprocesses automatically include these commands in `PATH`. Scripts can check `MAR_NODE_CONTEXT=1` for the MAR execution context and `MAR_USERNAME` for the current MAR account username, not a nickname or OS account. Scheduled runs use the task owner's username. Without a trusted execution identity, the username is empty rather than inherited from the Node service process. These variables provide context only: they do not grant permissions or change hosted conversations' separate sandbox boundary.

## Load Agent guidance on demand

In managed Workspaces with a marctl execution context, MAR Agent uses its built-in `marctl` Skill. Codex, Claude Code, and OpenCode load the same guide through the built-in `mar_cli` MCP tool `load_guide`. Server instructions and the tool description provide short discovery hints; whether the client exposes server instructions depends on the Runner.

Loading the guide only returns instructions, not command results. The Agent still runs marctl through its own shell tool and consults local command help when needed. Guidance already loaded and still in context can be reused. This entrypoint does not grant permissions or change collaboration message origins or existing schedule tools.

## Check command help

```text
marctl help
marctl help ssh
marctl ssh --help
marnodes --help
marssh --help
marscp --help
```

Each entrypoint also supports `-h`. Help needs no configuration, authorization, or Server connection. `marctl help` presents the product description, usage, commands, options, examples, and authorization notes. Command help is organized into usage, arguments, options, examples, and notes. Each alias shows only its own operation, using `marnodes`, `marssh`, or `marscp` rather than unrelated commands. In `marssh <node> tool --help`, the help flag belongs to the remote command; arguments after `marscp --` are literal paths.

## Check the CLI version

```text
marctl version
marctl --version
marnodes --version
marssh --version
marscp --version
```

Each entrypoint also supports `-V` and writes one line, `marctl <version>`, to standard output, followed by a newline. No banner, dependency versions, or diagnostics are appended; successful queries exit with code 0. This is the installed `@myagentroam/marctl` package version, not the Node or Server version. No configuration, authorization, or Server connection is required. Use `marctl help version` or `marctl version --help` for version-command help. In `marssh <node> --version`, the option remains part of the remote command rather than showing the local CLI version.

## Execution-context authorization

The CLI is only for MAR-managed execution contexts. In a Workbench terminal or Workspace Agent Run started by a user on a Node, it automatically uses the current user's Node permissions; scheduled runs use the task owner. No key, environment file, or manually configured authorization variables are needed.

The Server checks the user credential, account, login session (when applicable), and current permissions on every request. Credentials expire **24 hours after issue**, without sliding or automatic renewal. After expiry, open a new terminal or submit a new authorized input. Goal continuation and tool calls do not renew credentials. Ordinary OS terminals and other external scripts cannot access Nodes independently. Administrator keys, home-directory configuration files, and `--env-file` are not supported. Do not copy, persist, or share execution-context user credentials.

## Coordinate Workspace Sessions

For `show/config/history/graph/rename/prompt` and `schedule get/create/update`, omit the Session ID to use the current execution-context Session. An explicit ID takes precedence. Without a current Session, the command fails rather than guessing a recent one. `send/goal/stop/wait/approval` always require an explicit target ID; `list` and `schedule list` still query the current Workspace.

Use `marctl agents rename [<session-id>] --title 'fixer#42 Updated title' --json` to rename a Session. The trimmed title must be nonempty and at most 160 characters. There is no parent-tree restriction. Renaming uses the Web title-update flow without starting or interrupting execution. Use `agents current --json` to read the current title.

Scheduled tasks share data and agent editing rules with the built-in MCP: edits by the saving user apply directly; another user's edits return a `PENDING` proposal for the saving user to confirm, without changing execution identity. Scheduled and manual executions use the same user permissions and task editing rules. Read the current `revision` before passing `--expected-revision`; conflicts and uncertain writes are not retried automatically. MAR Agent hides the duplicate schedule MCP when its built-in marctl skill is available. Other Runners, or executions without that skill, retain the MCP.

```text
marctl agents schedule list --limit 20 --json
marctl agents schedule get --json
marctl agents schedule create --cron '0 9 * * *' -m 'Check build results' --json
marctl agents schedule update --expected-revision 1 --message-file task.txt --json
marctl agents schedule get <session-id> --json
```

`schedule list` pages through Node SQLite and returns `tasks[]` (including `sessionTitle`) and `nextCursor`, without scanning Runners. Other schedule operations accept an explicit target Session. Creation requires cron and text; updates require at least one. Text uses `-m` / `--message-file` (including stdin), up to 20,000 characters. The Node chooses the time zone. The CLI does not provide task enable/disable, deletion, or proposal approval commands.

`view [<session-id>] --json` returns only state, the current Goal, and bounded recent activity, without history or history pagination options. Read records on demand with the separate `history [<session-id>] --cursor <cursor> --limit <1..100> --json` command; omit the cursor for the first page. For `history --json`, select `kind === "assistant_message"` in `segments[].items[]` and read `payload.text`; compact state fields are described below.

Use `marctl agents config <session-id> --model-id <id> --effort high --json` to switch an existing Session's model and reasoning effort. Either option can be set alone; omitted fields and permissions stay unchanged. Use `--effort ""` for the Runner's native default. Configuration applies through the existing subsequent execution flow without restarting active execution. `agents start` also accepts `--effort`.

Both `agents start` and `agents config` select a model with `--model-id <id>`, using an ID from the target Runner configuration's `models[].id`. For MAR Agent this is the internal configuration ID, not the display name or upstream model ID. Requests and Session summaries use `modelId`; the old `--model` option and request field `model` are rejected.

Tasks dispatched with `start`, `send`, or `goal set` suppress automatic notifications to avoid repeated pushes from collaborating Sessions. This applies to subsequent task turns and Goal continuation; status and history remain available. Later manual input restores normal notification rules. Explicit notification tools can still send authorized notifications.

`sessions` is bound to the current Node and Workspace by MAR authorization. It does not accept `--node`, `--workspace`, or another scope override; knowing a foreign Session ID or cursor does not grant access. A Workspace terminal may have no current Session. Missing trusted Workspace context is an explicit error. Existing `nodes`, `ssh`, and `scp` retain their cross-Node behavior.

Session listing, ID lookup, and `list --query <title-fragment>` read only Sessions registered or cached on the current Node, without actively scanning Runners. MAR-created Sessions are registered once their native identity is established; external Sessions are registered after successful Workbench discovery. Reads do not resume execution. List ordering follows the selected scope and results are bounded; excess matches set `truncated`, without pagination. For a mistyped ID, `SESSION_NOT_FOUND` details may suggest up to three nearby `<sessionId> <name>` entries from the same Workspace, without replacing the ID or replaying an operation. Failed waits retain the target Session, Run, failure stage, and available upstream diagnostics in JSON errors.

`list` accepts only `--scope tree|active`, `--query <title-fragment>`, and `--limit <1..100>`. With a current Session it defaults to the containing collaboration tree, including idle Sessions; a standalone terminal defaults to active, and explicit tree requires Session context. Active includes running or sleeping Sessions in the current Workspace, not inferred from timestamps, Goals, or queues. Query filters titles within the selected scope, ignoring surrounding whitespace and case and normalizing compatibility characters such as full-width letters, before applying limit (default and maximum 100). Results contain only `currentAgentId` (null without a Session), flat `sessions`, and `truncated`; entries contain only `id`, `parentSessionId`, `title`, `runner`, and `status`. No matches produce an empty list; excess matches set truncated, without a cursor or pagination. Reuse known IDs directly. `show` returns a compact `session` with the same identity and status, plus `modelId`, `effort`, `queuedCount`, `latestMessage`, up to three `recentTools`, plus `pendingApprovals` and `pendingApprovalsTruncated`; it does not include full Runs, queues, Goals, paths, or control settings. Use the existing Goal, schedule, graph, and history commands for their respective details. Model ID/effort are Node-known Session settings, or null when unknown; `queuedCount` excludes internal Goal continuation.

Session `status` is `RUNNING`, `IDLE`, or `SLEEPING`. Sleeping requires a confirmed foreground sleep in the current Run, not a tool name or an active Goal. Tool `state` remains its original lifecycle, such as `IN_PROGRESS` or `COMPLETED`. A running Session with no new public action has empty activity rather than borrowing a previous Run. Idle Sessions may show earlier in-memory activity with its observation time. Summaries are limited to 100 Unicode characters, tool names to 128, and the latest message to 300; `truncated` indicates shortened content. Full evidence remains in history.

## Persistent instructions and approvals

Use `prompt get/set/clear` on an existing ordinary Workspace Session to read, set or clear its Session Prompt; omit the ID to use the current Session. Set accepts `-m` or `--message-file` (including stdin); blank text is not a substitute for clear. Changes use existing metadata and prompt injection without changing titles or permissions. They apply to future executions; queued work reads the latest value when it starts. Active execution is not interrupted and old native history is not erased.

The `show` field `pendingApprovals` summarizes pending requests for the active Run with public `runId`, `approvalId`, `name`, `summary`, and `truncated`. `pendingApprovalsTruncated` marks an incomplete list; use history for full evidence. Raw tool inputs are excluded. The view shares the existing Watch progress source, not a separate approval store. `wait --until approval` also returns early with `stopReason: APPROVAL_REQUIRED` and the summaries, without stopping the Run. Terminal state takes precedence; unsupported older Nodes fail explicitly.

A decision requires explicit Session, public root Run and approval IDs, plus approve/reject. Existing user and operation authorization still applies; collaboration messages do not grant approval authority. A decision receipt confirms acceptance, not task completion; keep observing or wait again. Expired, duplicate and mismatched requests are rejected. Reconcile state/history before retrying an uncertain write; a missing pending request does not mean it was approved.

```text
marctl help agents
marctl agents current --json
marctl agents list --limit 20 --json
marctl agents list --query fixer#42 --json
marctl agents list --scope active --limit 20 --json
marctl agents graph <session-id> --limit 100 --json
marctl agents start --runner codex --title 'fixer#42 Handle empty totals' --message-file task.txt --json
marctl agents show <session-id> --json
marctl agents history <session-id> --limit 10 --json
marctl agents send <session-id> --steer -m 'Additional context: focus on the resume path.' --json
marctl agents send <session-id> --queue -m 'After the current task, review the final diff.' --json
marctl agents send <session-id> --approval <approval-id> --decision approve --json
marctl agents wait <session-id> --run <run-id> --timeout 30s --json
marctl agents prompt get <session-id> --json
marctl agents prompt set <session-id> --message-file instructions.txt --json
marctl agents prompt clear <session-id> --json
marctl agents wait <session-id> --run <run-id> --until approval --timeout 5m --json
marctl agents approval decide <session-id> --run <run-id> --approval <approval-id> --decision approve --json
marctl agents wait <session-id> --timeout 0ms --json
marctl agents stop <session-id> --execution <execution-id> --json
marctl agents goal get <session-id> --json
marctl agents goal set <session-id> --message-file objective.txt --json
marctl agents goal set <session-id> -m 'Finish the review and verify the fix' --json
marctl agents goal clear <session-id> --json
```

For `start`, `send` and `goal set`, use `-m` / `--message` to supply text directly, or `--message-file` to read a UTF-8 file or stdin; the two options are mutually exclusive. File paths in the text refer to resources the target is authorized to access; they do not upload files from the CLI host. `goal set` rejects the reserved objective `--clear`; use `goal clear` to clear the Goal.

`start` creates a Session at the Workspace root and submits its first message; it supports `mar-agent`, `codex`, `claude-code`, and `opencode`, subject to actual Runner capabilities. Omit `--model-id` to use the target Runner configuration, not the Coordinator's model. Creating a Session does not overwrite the default model, reasoning effort, or access saved for the Web Composer, with or without a parent Session; explicit configuration applies only to the new Session. `--message-file -` reads UTF-8 stdin. Record the returned native Session ID; titles are not unique routing identities.

When an Agent runs `start`, Node validates the creation source using its trusted Execution credential. Terminal users can specify a valid parent with `--parent`; Node checks the Workspace and stores the canonical `parentSessionId`. Without a parent it remains null, and it cannot be edited afterward. `list --scope tree` returns the current Session’s containing collaboration tree, and `graph <session-id>` returns creation descendants including the root. Graph defaults to at most 100 nodes; `--limit` accepts 1..100. Results contain `rootSessionId`, `nodes`, and `truncated`, using only Node-known Sessions without scanning Runners. Parent means creation source, not authorization, current coordinator, or task dependency. Sending messages and taking over work do not change it. Deleting a parent deletes its descendants under Node's tree rules; old relationships are not inferred from messages or titles.

Create workers as tasks need them, using `fixer#<task-id> <description>` or `reviewer#<task-or-change-id> <description>`. There is no fixed worker count, role registry, or worker pool. Put role, scope, and acceptance criteria in the first ordinary message, or use `prompt` for persistent instructions. Each Runner loads guidance through the entry described above; a target Session does not need to load the guide to receive collaboration messages.

`send` uses ordinary delivery by default; you can choose either `--steer` or `--queue`. Conflicting, repeated, or obsolete options are rejected locally before input is read or a request is sent. `--steer` prioritizes new context; managed waits may return early without stopping background tasks, while other cases may switch the current execution. Node decides delivery from actual state. Prefer `--steer` for timely coordination; reserve `--queue` for deferred input explicitly requested by the user or recipient. Queued messages are consumed after current work and earlier queued inputs finish, and an active Goal must exit first. Later explicit stops still apply. Start/send generate a `clientMessageId`, or accept `--client-message-id`. Message receipts report acceptance and delivery under `message.status` and `message.result`; acceptance does not guarantee immediate processing. An accepted message normally needs no separate receipt acknowledgment, request for one, or immediate history check just to confirm receipt. If delivery is unknown, inspect history before retrying; queued messages can be correlated using `queueItemId`/`clientMessageId`.

`send --approval <approval-id> --decision approve|reject` can decide an approval alone or alongside a message or Goal. Node still checks validity and target ownership. Deciding an approval alone does not require a model request.

While child Agents run, prefer advancing meaningful, non-overlapping work rather than duplicating delegated work. Waiting is generally useful once no other meaningful local task work remains and a required result is needed to unblock or finish the task. Prefer a concise final handoff to routine progress reports or duplicate completion messages; earlier contact is useful for requested updates, blockers, scope conflicts, or decisions.

The first message from `start` and messages from `send` inside an Agent Session are labeled `From {name}` in history and the queue, using the name captured at send time. The tooltip identifies the source as a Session and shows its ID. Web-share visitor messages use the same `From {name}` title, with a tooltip identifying a Web share; ordinary user messages and original author messages on shared pages keep their existing titles. Direct terminal user input does not impersonate a Session source. The internal origin marker is not shown in the message text.

Without `--run`, `wait` defaults to direct-child completion and 30 seconds; `--timeout 0ms` reads a snapshot. Use the snapshot's `executionId` with `stop --execution`: a stale identity cannot stop a later execution, and stop also clears the corresponding Goal. `wait --run` uses the existing Watch for that Run or an approval and releases observation on exit; a timeout error may include the last bounded `progress`, omitted if none was observed. Neither kind of wait stops the task on timeout or cancellation. A successful Run still requires checking artifacts and tests; a child terminal state does not wake the parent's sleep, so wait or read actively.

Only direct-child public updates are collected automatically by the parent. Sending to another Session does not subscribe to it; an explicit wait listens only for that call, not for later updates.

Sessions share files and the Git index, without automatic worktree isolation or a Git workflow. Commits, pushes, PRs, merges, and external messages still need applicable user authorization. If a mutation outcome is unknown, preserve its correlation ID and inspect state/history before retrying; do not blindly resend. In-memory receipt/Run recovery is not guaranteed across restarts.

`--json` emits one result/error object with stable English keys and codes. Exit codes: 1 failure, 2 invalid input, 3 authorization, 4 unsupported capability, 5 timeout, 6 unknown outcome, 130 cancelled waiting.

## List Nodes and run commands

```text
marctl nodes
marnodes
marctl ssh <node-id>
marctl ssh <node-name>
marssh <node-id|node-name>
marctl ssh <node-id> uname -a
marscp ./artifact.bin <node-id|node-name>:///absolute/path/artifact.bin
marscp ./artifact.bin <node-id|node-name>:///existing/directory/
marscp <node-id|node-name>:///absolute/path/artifact.bin ./
marscp <node-id|node-name>:///absolute/path/artifact.bin ./artifact.bin
marctl scp linux:///absolute/path/artifact.bin windows://C:\absolute\path\artifact.bin
```

`nodes` lists only Nodes the current authorized user may use for terminals. Its first line labels the ID, name, online status, and platform columns. `ssh` accepts a Node ID or an exact display name that is unique among accessible Nodes (including offline Nodes for duplicate checks). Duplicate names are rejected with a prompt to use the ID; an exact ID takes precedence over another Node's display name. Without a command, `ssh` opens an interactive shell. With a command, the CLI passes arguments after the Node to the remote shell in the usual SSH-like form, streams output, and returns the actual exit code for Agents or scripts. The joined command may contain at most 64 KiB of UTF-8 data; the target platform or shell may impose a lower practical limit. An argument starting with `-` after the Node is part of the remote command; no extra `--` is required. SSH options including `-t`, login, port, and identity are not supported, and no privilege escalation occurs. Do not pass secrets in commands.

The CLI tries the existing direct Node transport first and falls back to the Server relay if setup fails. Fallback reuses the same terminal rather than creating or running the command twice. The Server authorizes either transport, and commands always run as the **Node service account**. An enterprise ADMIN can operate their own personal Nodes and every organization Node, but cannot use another user's personal Node terminal.

`scp` transfers a single regular file between this machine and an accessible Node, or between two accessible Nodes. A Node endpoint uses `<node-id|node-name>://<absolute-path>` or `node:<absolute-path>`; names must be unique among accessible Nodes, so use an ID if names collide. A path without a Node prefix is local. Like standard `scp`, an existing regular destination file is overwritten by default without a special flag; its permissions are retained. `-p` preserves the source's mode and access/modify times; `-q` keeps progress output quiet (already the default). Other SCP options, including `-r` and SSH connection options, are rejected, not silently ignored. An existing real destination directory receives the source filename automatically; you do not need to specify the full destination filename. A directory target ending in a separator must already exist: no directory or same-named file is created. Directory sources, symlink sources or targets, and a final path inside the destination directory that is itself a directory or symlink are refused. Source filenames invalid on the receiving platform are also rejected. A verified copy is published atomically; transfer failure does not replace the original, though forced termination can leave a temporary file. The transfer reuses authorized Terminal connections in binary pipe mode, **not** the system SCP protocol or a separate file API. Both Server and Node must support binary Terminal mode; older versions are rejected rather than interpreting binary data through a PTY. File access uses each Node's service account permissions. Quote paths containing spaces for your local shell; Windows Node paths can use `C:\absolute\path` after `://`.

## Long-running tasks and disconnects

The Server relay has no fixed transfer-rate limit. Frames are written asynchronously, yielding the event loop to other operations. A congested copy pauses its pipe or CLI input and resumes in order without affecting a direct writer. Ordinary terminals keep reading to preserve output before exit; exceeding the send-buffer limit explicitly ends only that relay, without silently dropping frames or closing the shared connection for other terminals. Exit status never overtakes output, waiting writes or acknowledgements remain interruptible, and a normal disconnect after a successful exit is not reported as a copy failure. No new command option is required. Slow networks can still increase response times; this is not host-wide bandwidth isolation.

Connection setup has a timeout, but an attached command has no total runtime or output-idle timeout; keep the connection open to wait for a long-running task. Exiting the CLI or losing the connection irrecoverably closes the terminal it created. The CLI does not manage persistent background tasks; Node retains a detached terminal for at most 60 minutes. Use a separately managed task for work that must continue after a disconnect.
