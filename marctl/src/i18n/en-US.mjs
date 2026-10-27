const configurationHelp = `Authorization:
  Node access is available only in MAR-launched terminals and Workspace Agent Runs;
  scheduled runs use the task owner. MAR supplies short-lived user credentials.
  External terminals and persistent administrator keys are not supported.`;

export default Object.freeze({
  help: `marctl — MyAgentRoam command-line interface

Usage:
  marctl [options] <command> [arguments]
  marctl help [command]

Commands:
  sessions Inspect and coordinate Sessions in the current Workspace.
  nodes    List accessible Nodes and their connection status.
  ssh      Open a Node terminal or execute a remote command.
  scp      Copy a regular file between this machine and Nodes, or between Nodes.
  version  Print the installed CLI package version.
  help     Show help for the CLI or a command.

Options:
  -h, --help       Show help and exit.
  -V, --version    Print the CLI package version and exit.

Examples:
  marctl nodes
  marctl ssh <node> uname -a
  marctl scp ./artifact.bin <node>:///tmp/artifact.bin
  marctl --version
  marctl help ssh

Aliases:
  marnodes  Equivalent to the nodes command.
  marssh    Equivalent to the ssh command.
  marscp    Equivalent to the scp command.

${configurationHelp}

Notes:
  Help and version work offline without configuration or authorization.
  Put local help/version options before a Node or file endpoint.
  Each alias shows only its own command help. Use marctl help <command> for details.
  Remote access uses authorized Node Terminal transport, not system SSH or SCP.`,
  commandHelp: Object.freeze({
    sessions: `{program} — Coordinate Sessions in the current MAR Workspace

Usage:
  {program} current [--json]
  {program} list [--query <title>] [--parent <session-id>]
    [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} show [<session-id>] [--json]
  {program} config [<session-id>]
    [--model <id>] [--effort <value>] [--json]
  {program} rename [<session-id>] --title <name> [--json]
  {program} prompt get|clear [<session-id>] [--json]
  {program} prompt set [<session-id>]
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule list [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} schedule get [<session-id>] [--json]
  {program} schedule create [<session-id>] --cron <cron>
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule update [<session-id>]
    --expected-revision <revision>
    [--cron <cron>] [-m <text> | --message-file <file|->] [--json]
  {program} graph [<session-id>] [--limit <1..100>] [--json]
  {program} history [<session-id>]
    [--cursor <cursor>] [--limit <1..100>] [--json]

  {program} start --runner <runner>
    [-m <text> | --message-file <file|->] [--image <path> ...]
    [--model <id>] [--effort <value>] [--title <name>]
    [--client-message-id <id>] [--json]

  {program} send <session-id>
    [-m <text> | --message-file <file|->] [--image <path> ...]
    (--steer | --queue)
    [--client-message-id <id>] [--json]

  {program} stop <session-id> [--run <run-id>] [--json]
  {program} goal get|clear <session-id> [--json]
  {program} goal set <session-id>
    (-m <text> | --message-file <file|->) [--json]
  {program} wait <session-id>
    --run <run-id> --timeout <30s|5m> [--until approval] [--json]
  {program} approval decide <session-id> --run <run-id>
    --approval <approval-id> --decision <approve|reject> [--json]

Input:
  show/config/history/graph/rename and prompt may omit the ID.
  schedule get/create/update follow the same rule.
  They use the current Session; without one, specify an ID explicitly.
  send/goal/stop/wait/approval always require an explicit Session ID.
  Runners: mar-agent, codex, claude-code, opencode; actual capabilities apply.
  -m / --message supplies text; it is mutually exclusive with --message-file.
  Files use UTF-8; - reads stdin. Repeat --image for PNG/JPEG/GIF/WebP files.
  Start/send allow image-only input: up to 5 images, 5 MiB each, 10 MiB total.
  Goal set accepts text only.
  Config requires model or effort; other fields and permissions are unchanged.
  Use --effort "" for the Runner default. Active execution is not restarted.
  Prompt reads, sets or clears persistent instructions for future executions.

Titles and scheduled tasks:
  rename uses the existing title update; no parent-tree restriction.
  It does not restart execution. schedule list reads local Workspace tasks.
  schedule get/create/update share MCP task data.
  Schedule text is limited to 20,000 characters; update requires cron or text.
  Other-owner edits create PENDING proposals.
  Read the current revision before updating; a version conflict is not retried.

Reading JSON:
  list: id/title/runner/status/runId and one latestActivity per Session.
  show: session.status, session.title, session.runId,
    session.model, session.effort, session.queuedCount,
    session.latestMessage, session.recentTools (up to three summaries).
    session.pendingApprovals shows current requests; pendingApprovalsTruncated
    marks an incomplete summary. Full evidence remains in history.
  Status is RUNNING/IDLE/SLEEPING; tools keep their original states.
  history: segments[].items[]; select kind === "assistant_message",
    read payload.text.

Delivery and waiting:
  Start/send return a clientMessageId.
  Send requires exactly one of --steer or --queue, even when idle.
  --steer prioritizes time-sensitive updates affecting current work and may
    switch the current execution. Node decides from actual state; processing
    is not guaranteed to be immediate.
  --queue does not interrupt active execution; during normal active work it
    waits for that execution and earlier queued work. An active Goal can delay
    it until the Goal exits.
    Use --steer instead when the update is needed during current work.
    New input resumes a paused FIFO without interrupting
    active execution; cancellation settles before resuming.
  Example:
    marctl sessions send <session-id> --steer \\
      -m "Additional context: focus on the resume path." --json
  A queued runId may identify another
  active input: correlate queueItemId/clientMessageId with visible history.
  Wait observes the specified Run through Watch. Timeout does not stop it;
  timeout errors may include progress, the last observed bounded snapshot.
  --until approval also returns when the Run needs an approval decision.
  Approval decide explicitly approves or rejects one request, subject to
    existing user authorization. Accepted decisions do not prove completion.
  Run success is not proof of task success.
  Completion never wakes a Coordinator.
  On an unknown delivery outcome, inspect state/history; do not blindly resend.

Credentials and scope:
  Credentials expire 24 hours after issue without automatic renewal.
  Scope is bound by MAR to the current Node/Workspace;
  there are no scope override options.
  List and ID lookup use Node-known Sessions without scanning Runners.
  --query filters display titles; missing IDs may suggest nearby IDs, not retry.
  Start records the current Session as parent; no parent override.
  --parent lists direct children; graph includes the root and descendants.
  Graph defaults to 100 nodes and reports truncation, not task dependencies.

Workers:
  Create workers as needed, e.g. --title "fixer#42 Handle empty totals" or
  --title "reviewer#42 Review empty totals". Titles are not routing identities;
  record returned Session IDs. Put task/role instructions in the first message.
  Sessions share files and the Git index; no automatic worktree or worker pool.

Exit codes:
  1 failure, 2 input, 3 authorization, 4 unsupported, 5 timeout,
  6 unknown outcome, 130 cancelled wait.
  --json prints one result/error object.`,
    nodes: `{program} — List accessible Nodes

Usage:
  {program} [options]

Options:
  -h, --help       Show help and exit.
  -V, --version    Print the CLI package version and exit.

Examples:
  {program}

Output:
  Tab-separated columns: ID, NAME, STATUS, PLATFORM.
  Includes offline Nodes for which the current user has terminal permission.

${configurationHelp}`,
    ssh: `{program} — Open a terminal or execute a remote command

Usage:
  {program} [options] <node> [command [arg...]]

Arguments:
  <node>          An authorized Node ID or an exact, unique Node name.
  [command ...]   A command for the remote shell; omit it for an interactive shell.

Options (before <node>):
  -h, --help       Show help and exit.
  -V, --version    Print the CLI package version and exit.

Examples:
  {program} ubuntu-develop
  {program} ubuntu-develop uname -a
  {program} ubuntu-develop "echo hello && whoami"

Notes:
  Names must be unique across accessible Nodes, including offline Nodes; use an ID on conflict.
  Remote arguments are joined with spaces. Quote shell expressions for your local shell.
  Remote --help, -h, and --version are not local options. The remote exit code is preserved.
  Commands run as the Node service account; login accounts, privilege escalation, and SSH
  connection options such as -t, -p, and -i are unsupported. No SSH port is required.
  Connection setup has a timeout, but attached commands have no runtime or output-idle timeout.
  Commands are not retried. Exit or unrecoverable disconnection closes the terminal;
  this is not a background-job service.

${configurationHelp}`,
    scp: `{program} — Copy a regular file

Usage:
  {program} [options] <source> <destination>

Arguments:
  <source>        A local file or an authorized Node file endpoint.
  <destination>   A local file/directory or an authorized Node endpoint.
  Node endpoints: <node>://<absolute-path> or <node>:<absolute-path>.
  <node> is an ID or an exact, unique name, including offline Nodes.
  At least one endpoint must be a Node. Linux and Windows paths are supported.

Options:
  -p              Preserve source permissions and access/modification times.
  -q              Suppress progress output (already the default).
  -h, --help       Show help and exit; place before the first endpoint.
  -V, --version    Print the CLI package version and exit; place before the first endpoint.
  --              Treat remaining arguments as literal paths.

Examples:
  {program} ./artifact.bin ubuntu-develop:///tmp/artifact.bin
  {program} ubuntu-develop:///tmp/artifact.bin ./
  {program} -p linux:///tmp/artifact.bin "windows://C:/Artifacts/"

Notes:
  Existing directories receive the source filename; directory paths must already exist.
  Existing regular files are overwritten, retaining their permissions unless -p is used.
  Directory sources, symlinks, invalid destination filenames, and directory final targets
  are rejected. Recursive -r, multiple sources, and SSH connection options are unsupported.
  Both Server and Node must support binary Terminal pipes; this is not system SCP.
  File access uses the Node service account's permissions. Checksums are verified before
  atomic publication; failed transfers leave the original unchanged. Forced termination
  may leave a temporary file. Transfers are not retried.

${configurationHelp}`,
    version: `marctl — MyAgentRoam CLI version

Usage:
  {program} [options]
  marctl --version
  marctl -V

Options:
  -h, --help       Show help and exit.
  -V, --version    Print the CLI package version and exit.

Examples:
  {program}
  marctl --version

Output:
  marctl <version>

Prints one line from the installed @myagentroam/marctl package, followed by a newline.
The version is independent of Node and Server. No configuration, authorization,
or Server connection is required.`
  }),
  nodesHeader: 'ID\tNAME\tSTATUS\tPLATFORM',
  connected: 'connected',
  disconnected: 'disconnected',
  errors: Object.freeze({
    sessionOutcomeUnknown:
      'The delivery outcome is unknown. Inspect Session state/history before retrying.',
    sessionMessageInvalid:
      'The message must be non-empty and within the length limit; input files must be readable UTF-8.',
    sessionImageInvalid:
      'Images must be readable PNG, JPEG, GIF or WebP files: at most 5 images, 5 MiB each and 10 MiB total.',
    sessionWaitUnknown: 'The specified Run could not be confirmed. Inspect Session state/history.',
    sessionWaitCancelled: 'Waiting was cancelled; the target Run was not stopped.',
    sessionWaitTimeout: 'Waiting timed out; the target Run was not stopped.',
    sessionApprovalUnsupported: 'This Node does not provide pending approval observations.',

    userContextUnavailable: 'This Node session has no valid marctl user authorization.',
    sessionContextRequired: 'No current Session is available; specify a Session ID explicitly.',
    serverUrlInvalid: 'MAR_CTL_SERVER_URL is invalid.',
    serverUrlTransport: 'MAR_CTL_SERVER_URL must use HTTPS or loopback HTTP.',
    serverUrlOrigin: 'MAR_CTL_SERVER_URL must be an origin without credentials or query data.',
    fetchUnavailable: 'Fetch is unavailable in this Node.js runtime.',
    serverInvalidNodes: 'The server returned an invalid node list.',
    serverInvalidManifest: 'The server returned an invalid node manifest.',
    terminalCommandInvalid: 'The terminal command is invalid.',
    terminalSequenceInvalid: 'The terminal sequence is invalid.',
    terminalTicketInvalid: 'The terminal ticket is invalid.',
    terminalIdInvalid: 'The terminal identifier is invalid.',
    nodeIdInvalid: 'The node identifier is invalid.',
    nodeNameAmbiguous: 'Multiple accessible nodes share that name; use a node ID.',
    nodeNotFound: 'No accessible node matches this ID or name.',
    terminalSizeInvalid: 'The terminal size is invalid.',
    serverInvalidTerminalId: 'The server returned an invalid terminal identifier.',
    serverInvalidTicket: 'The server returned an invalid terminal ticket.',
    serverInvalidJson: 'The server returned invalid JSON.',
    serverTimeout: 'The marctl server did not respond before the control request timeout.',
    serverUnreachable: 'The marctl server could not be reached.',
    serverRejected: 'The marctl server rejected the request.',
    terminalConnectionStart: 'The terminal connection could not be started.',
    terminalConnectionOpen: 'The terminal connection could not be opened.',
    terminalAttachTimeout: 'The terminal did not attach before the connection setup timeout.',
    terminalAttachConnection: 'The terminal connection failed during attachment.',
    terminalAttachLost: 'The terminal connection was lost during attachment.',
    terminalRemoteError: 'The remote terminal reported an error.',
    terminalClosedBeforeAttach: 'The remote terminal closed before attachment.',
    terminalFrameInvalid: 'The terminal frame was invalid.',
    terminalInvalidJson: 'The terminal sent invalid JSON.',
    terminalBinaryFrame: 'The terminal sent an invalid binary frame.',
    terminalBinaryUnavailable:
      'Binary copy requires a Server and Node that support pipe terminals.',
    terminalConnectionFailed: 'The terminal connection failed.',
    terminalConnectionLost: 'The terminal connection was lost.',
    terminalUnexpectedFrame: 'The remote terminal sent an unexpected frame.',
    terminalInputFailed: 'The terminal input could not be sent.',
    terminalResizeFailed: 'The terminal resize could not be sent.',
    terminalInteractiveRequired: 'An interactive terminal is required.',
    terminalInteractiveInit: 'The interactive terminal could not be initialized.',
    terminalCloseFailed: 'The remote terminal could not be closed.',
    terminalSessionFailed: 'The terminal session failed.',
    terminalDirectUnsafeFallback:
      'Direct terminal setup could not be safely canceled after OPEN; relay fallback was skipped.',
    invalidArguments: 'Invalid command arguments.',
    sessionDeliveryRequired: 'Send requires exactly one of --steer or --queue, even when idle.',
    sshOptionsUnsupported: 'SSH options are not supported; use marssh <host>.',
    scpOptionsUnsupported: 'This SCP option is not supported by the Node Terminal transport.',
    commandFailed: 'The command failed.'
  })
});
