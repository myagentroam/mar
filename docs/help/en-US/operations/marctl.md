---
title: Manage Nodes with marctl
lastUpdated: 2026-11-25
---

# Manage Nodes with marctl

`marctl` is a Node CLI for the personal and enterprise editions; the Node package includes `marnodes`, `marssh`, and `marscp` entrypoints, for use only in MAR-managed execution contexts. It uses Server authorization to list usable Nodes, open an interactive terminal, run a one-off command, or copy a file. Nodes do not need to expose an SSH port. The `ssh` subcommand is a familiar name, **not the system SSH protocol**.

Ordinary MAR-launched Workbench terminals, Workspace Agent Runs, and their local MCP subprocesses automatically include these commands in `PATH`. Scripts can check `MAR_NODE_CONTEXT=1` for the MAR execution context and `MAR_USERNAME` for the current MAR account username, not a nickname or OS account. Scheduled runs use the task owner's username. Without a trusted execution identity, the username is empty rather than inherited from the Node service process. These variables provide context only: they do not grant permissions or change hosted conversations' separate sandbox boundary.

## Load Agent guidance on demand

In managed Workspaces with a marctl execution context, MAR Agent uses its built-in `marctl` Skill. Codex, Claude Code, and OpenCode load the same guide through the built-in `mar_cli` MCP tool `load_guide`. Server instructions and the tool description provide short discovery hints; whether the client exposes server instructions depends on the Agent.

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

Each entrypoint also supports `-V` and writes one line, `marctl <version>`, to standard output, followed by a newline. No banner, dependency versions, or diagnostics are appended; successful queries exit with code 0. This is the installed Node package version, not the Server version. No configuration, authorization, or Server connection is required. Use `marctl help version` or `marctl version --help` for version-command help. In `marssh <node> --version`, the option remains part of the remote command rather than showing the local CLI version.

## Execution-context authorization

The CLI is only for MAR-managed execution contexts. In a Workbench terminal or Workspace Agent Run started by a user on a Node, it automatically uses the current user's Node permissions; scheduled runs use the task owner. No key, environment file, or manually configured authorization variables are needed.

The Server checks the user credential, account, login session (when applicable), and current permissions on every request. Credentials expire **24 hours after issue**, without sliding or automatic renewal. After expiry, open a new terminal or submit a new authorized input. Goal continuation and tool calls do not renew credentials. Ordinary OS terminals and other external scripts cannot access Nodes independently. Administrator keys, home-directory configuration files, and `--env-file` are not supported. Do not copy, persist, or share execution-context user credentials.

Credentials are signed by the Server. An ordinary Server restart neither invalidates an otherwise valid credential nor extends its lifetime; current permissions are still checked after reconnection. Update the Server, Node, and bundled CLI together. Old in-memory credentials cannot be converted to signed credentials, so open a new terminal or submit a new authorized input when first switching formats.

## Coordinate Workspace Sessions

For `show/config/history/graph/rename/prompt`, omit the Session ID to use the current execution-context Session. An explicit ID takes precedence. Without a current Session, the command fails rather than guessing a recent one. `send/goal/stop/wait/approval` always require an explicit target ID; `list` queries the current Workspace.

Use `marctl agents rename [<session-id>] --title 'fixer#42 Updated title' --json` to rename a Session. The trimmed title must be nonempty and at most 160 characters. There is no parent-tree restriction. Renaming uses the Web title-update flow without starting or interrupting execution. Use `agents current --json` to read the current title.

`view [<session-id>] --json` returns only state, the current Goal, and bounded recent activity, without history or history pagination options. Read records on demand with the separate `history [<session-id>] --cursor <cursor> --limit <1..100> --json` command; omit the cursor for the first page. For `history --json`, select `kind === "assistant_message"` in `segments[].items[]` and read `payload.text`; compact state fields are described below.

Use `marctl agents config <session-id> --model-id <id> --effort high --json` to switch an existing Session's model and reasoning effort. Either option can be set alone; omitted fields and permissions stay unchanged. Use `--effort ""` for the Agent's native default. Configuration applies through the existing subsequent execution flow without restarting active execution. `agents start` also accepts `--effort`.

Both `agents start` and `agents config` select a model with `--model-id <id>`, using an ID from the target Agent configuration's `models[].id`. For MAR Agent this is the internal configuration ID, not the display name or upstream model ID. Requests and Session summaries use `modelId`; the old `--model` option and request field `model` are rejected.

Tasks dispatched with `start`, `send`, or `goal set` suppress automatic notifications to avoid repeated pushes from collaborating Sessions. This applies to subsequent task turns and Goal continuation; status and history remain available. Later manual input restores normal notification rules. Explicit notification tools can still send authorized notifications.

`sessions` is bound to the current Node and Workspace by MAR authorization. It does not accept `--node`, `--workspace`, or another scope override; knowing a foreign Session ID or cursor does not grant access. A Workspace terminal may have no current Session. Missing trusted Workspace context is an explicit error. Existing `nodes`, `ssh`, and `scp` retain their cross-Node behavior.

Session listing, ID lookup, and `list --query <title-fragment>` read only Sessions registered or cached on the current Node, without actively scanning native Agent session histories. MAR-created Sessions are registered once their native identity is established; external Sessions are registered after successful Workbench discovery. Reads do not resume execution. List ordering follows the selected scope and results are bounded; excess matches set `truncated`, without pagination. For a mistyped ID, `SESSION_NOT_FOUND` details may suggest up to three nearby `<sessionId> <name>` entries from the same Workspace, without replacing the ID or replaying an operation. Failed waits retain the target Session, Run, failure stage, and available upstream diagnostics in JSON errors.

`list` accepts only `--scope tree|active`, `--query <title-fragment>`, and `--limit <1..100>`. With a current Session it defaults to the containing collaboration tree, including idle Sessions; a standalone terminal defaults to active, and explicit tree requires Session context. Active includes running or sleeping Sessions in the current Workspace, not inferred from timestamps, Goals, or queues. Query filters titles within the selected scope, ignoring surrounding whitespace and case and normalizing compatibility characters such as full-width letters, before applying limit (default 10, maximum 100). Active Sessions come first, then recent activity descending. Results contain only `scope`, `currentAgentId` (null without a Session), flat `sessions`, and `truncated`; entries contain only `id`, `parentSessionId`, `title`, and `status`. No matches produce an empty list; excess matches set truncated, without a cursor or pagination. Reuse known IDs directly. `show` returns a compact `session` with the same identity and status, plus `modelId`, `effort`, `queuedCount`, `latestMessage`, up to three `recentTools`, plus `pendingApprovals` and `pendingApprovalsTruncated`; it does not include full Runs, queues, Goals, paths, or control settings. Use the existing Goal, schedule, graph, and history commands for their respective details. Model ID/effort are Node-known Session settings, or null when unknown; `queuedCount` excludes internal Goal continuation.

Session `status` is `RUNNING`, `IDLE`, or `SLEEPING`. Sleeping requires a confirmed foreground sleep in the current Run, not a tool name or an active Goal. Tool `state` remains its original lifecycle, such as `IN_PROGRESS` or `COMPLETED`. A running Session with no new public action has empty activity rather than borrowing a previous Run. Idle Sessions may show earlier in-memory activity with its observation time. Summaries are limited to 100 Unicode characters, tool names to 128, and the latest message to 300; `truncated` indicates shortened content. Full evidence remains in history.

## Scheduled tasks

`marctl agents schedule` works in the current authorized regular Workspace. `list` defaults to the whole Workspace and returns compact `tasks[]` and `nextCursor`. Use `--current` to list only this session's tasks, or `--session <session-id>` to filter by a specific session. These options are mutually exclusive, and `--current` fails if there is no current session. Keep the same filter when passing `--cursor` for the next page. `get`, `update`, and `runs` require `--task <task-id>`, not a session ID. `runs` uses `--page`, defaults to page one, and returns trigger times, outcomes, and any available run references without the task prompt.

`create` always creates a separate task; it never overwrites an existing one. It targets the current session by default. Use `--session <session-id>` to select a session in the same Workspace. To create a new session on each trigger instead, use `--new-session --runner <runner>` with either `--model-id <id>` or `--default-model` and optionally `--effort <value>`. If there is no current session, specify a target explicitly.

If you ask an Agent to “check the build at 18:00” as a new task without requesting a repeat, it treats the request as one-time. When the Node time zone is known and no other date is implied, it picks the next date on which 18:00 occurs. If the date or time zone is unclear, the Agent asks only for the missing detail. The creation receipt contains the next trigger time and time zone. When you change a time on an existing task, the Agent preserves any other times and recurrence you did not ask to change.

Use the `taskId` from the creation receipt or list as `TASK_ID`, and the current `revision` from the task detail as `REVISION`:

```sh
marctl agents schedule list --current --limit 20 --json
marctl agents schedule create --name 'Build review' --triggers-file triggers.json -m 'Check build results' --json
marctl agents schedule get --task "$TASK_ID" --json
marctl agents schedule update --task "$TASK_ID" --expected-revision "$REVISION" --message-file task.txt --json
marctl agents schedule runs --task "$TASK_ID" --page 1 --json
```

`--triggers-file` reads a UTF-8 JSON array, not a Cron expression. Each entry has one `HH:mm` time. New tasks use the Node time zone; updates retain the task's saved time zone. A `once` trigger requires an explicit future date; the CLI does not suggest one. This `triggers.json` demonstrates the one-time, daily, weekly, and monthly forms:

```json
[
  { "kind": "once", "date": "2030-03-21", "time": "14:30" },
  { "kind": "daily", "time": "10:00" },
  { "kind": "weekly", "time": "09:00", "weekdays": [1, 2, 3, 4, 5] },
  { "kind": "monthly", "time": "09:00", "monthDays": [1, 15] }
]
```

`weekly.weekdays` uses 0 (Sunday) through 6 (Saturday); `monthly.monthDays` uses 1 through 31. Invalid dates in shorter months do not trigger. Supplying `--triggers-file` on update replaces the entire trigger list; omit it to retain the current schedule. Pass the task prompt with `-m` or `--message-file`, up to 20,000 characters. Either `--triggers-file` or `--message-file` can read stdin using `-`, but not both in the same command.

An update must specify a name, triggers, or a task prompt. Updating your own task applies directly. Updating someone else's returns `proposalId` and `baseRevision` for the creator to resolve without transferring execution identity. Re-read after a revision conflict. If a write result is unknown, check the task before retrying. Use the [Scheduled tasks page](../workbench/sessions.md#scheduled-tasks) to pause, resume, delete, or resolve proposals; these actions are not available in the CLI.

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
marctl agents send <session-id> -m 'Additional context: focus on the resume path.' --json
marctl agents send <session-id> --queue -m 'After the current task, review the final diff.' --json
marctl agents send <session-id> --approval <approval-id> --decision approve --json
marctl agents wait <session-id> --run <run-id> --timeout 30s --json
marctl agents prompt get <session-id> --json
marctl agents prompt set <session-id> --message-file instructions.txt --json
marctl agents prompt clear <session-id> --json
marctl agents wait <session-id> --run <run-id> --until approval --timeout 5m --json
marctl agents approval decide <session-id> --run <run-id> --approval <approval-id> --decision approve --json
marctl agents wait <session-id> --timeout 0ms --json
marctl agents stop <session-id> --json
marctl agents goal get <session-id> --json
marctl agents goal set <session-id> --message-file objective.txt --json
marctl agents goal set <session-id> -m 'Finish the review and verify the fix' --json
marctl agents goal clear <session-id> --json
```

For `start`, `send` and `goal set`, use `-m` / `--message` to supply text directly, or `--message-file` to read a UTF-8 file or stdin; the two options are mutually exclusive. File paths in the text refer to resources the target is authorized to access; they do not upload files from the CLI host. `goal set` rejects the reserved objective `--clear`; use `goal clear` to clear the Goal.

`start` creates a Session at the Workspace root and submits its first message; it supports `mar-agent`, `codex`, `claude-code`, and `opencode`, subject to the capabilities of each Agent. If you omit `--runner` when calling from an Agent, `start` uses the calling Agent's type. From a terminal, specify `--runner` or `--parent`; without `--runner`, the parent Session supplies the Agent type. Omit `--model-id` to use the target Agent configuration, not the Coordinator's model. Creating a Session does not overwrite the default model, reasoning effort, or access saved for the Web Composer, with or without a parent Session; explicit configuration applies only to the new Session. `--message-file -` reads UTF-8 stdin. Record the returned native Session ID; titles are not unique routing identities.

When an Agent runs `start`, Node validates the creation source using its trusted Execution credential. Terminal users can specify a valid parent with `--parent`; Node checks the Workspace and stores the canonical `parentSessionId`. Without a parent it remains null, and it cannot be edited afterward. `list --scope tree` returns the current Session’s containing collaboration tree, and `graph <session-id>` returns creation descendants including the root. Graph defaults to at most 100 nodes; `--limit` accepts 1..100. Results contain `rootSessionId`, `nodes`, and `truncated`, using only Node-known Sessions without scanning native Agent session histories. Parent means creation source, not authorization, current coordinator, or task dependency. Sending messages and taking over work do not change it. Deleting a parent deletes its descendants under Node's tree rules; old relationships are not inferred from messages or titles.

Create workers as tasks need them, using `fixer#<task-id> <description>` or `reviewer#<task-or-change-id> <description>`. There is no fixed worker count, role registry, or worker pool. Put role, scope, and acceptance criteria in the first ordinary message, or use `prompt` for persistent instructions. Each Agent loads guidance through the entry described above; a target Session does not need to load the guide to receive collaboration messages.

When text is supplied, `send` defaults to `--steer`, like `agent_send`. Steering can end a managed wait early without stopping its background task. If Node cannot deliver the message in the current execution, it may interrupt that execution to deliver the new input. Use `--queue` for explicitly deferred input: queued messages are consumed after current work and earlier queued inputs finish, and an active Goal must exit first. Later explicit stops still apply. Goal-only updates and approval decisions do not involve message delivery. Conflicting, repeated, or obsolete options are rejected locally before input is read or a request is sent. Start/send generate a `clientMessageId`, or accept `--client-message-id`. Message receipts report acceptance and delivery under `message.status` and `message.result`; acceptance does not guarantee immediate processing. An accepted message normally needs no separate receipt acknowledgment, request for one, or immediate history check just to confirm receipt. If delivery is unknown, inspect history before retrying; queued messages can be correlated using `queueItemId`/`clientMessageId`.

`send --approval <approval-id> --decision approve|reject` can decide an approval alone or alongside a message or Goal. Node still checks validity and target ownership. Deciding an approval alone does not require a model request.

While child Agents run, prefer advancing meaningful, non-overlapping work rather than duplicating delegated work. Waiting is generally useful once no other meaningful local task work remains and a required result is needed to unblock or finish the task. Prefer a concise final handoff to routine progress reports or duplicate completion messages; earlier contact is useful for requested updates, blockers, scope conflicts, or decisions.

The first message from `start` and messages from `send` inside an Agent Session are labeled `From {name}` in history and the queue, using the name captured at send time. The tooltip identifies the source as a Session and shows its ID. Web-share visitor messages use the same `From {name}` title, with a tooltip identifying a Web share; ordinary user messages and original author messages on shared pages keep their existing titles. Direct terminal user input does not impersonate a Session source. The internal origin marker is not shown in the message text.

Without `--run`, `wait` follows `agent_wait`: it selects direct children when no target is given and defaults to waiting for completion for 30 seconds. Explicit targets, including a single one, are returned in an `agents` array. `--timeout 0ms` reads a snapshot, and positive timeouts use the requested duration. `stop <session-id>` stops the target's current execution and clears its Goal without an execution ID; an idle target is reported as idle and its Goal is cleared. `wait --run` uses the existing Watch for that Run or an approval and releases observation on exit; a timeout error may include the last bounded `progress`, omitted if none was observed. Neither kind of wait stops the task on timeout or cancellation. A successful Run still requires checking artifacts and tests; a child terminal state does not wake the parent's sleep, so wait or read actively.

`view` returns state, Goal, and bounded recent activity without Run or Execution IDs.

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
