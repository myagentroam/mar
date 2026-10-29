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
  agents   Inspect and coordinate Sessions in the current Workspace.
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
    agents: `{program} — Coordinate Agents in the current MAR Workspace

Usage:
  {program} start [-m <text> | --message-file <file|->] [--image <path> ...]
    [--runner <runner>] [--parent <id>] [--model <id>] [--effort <value>]
    [--title <name>] [--goal <objective> | --clear-goal]
    [--client-message-id <id>] [--json]
  {program} send <id> [-m <text> | --message-file <file|->]
    [--image <path> ...]
    [--steer | --queue] [--goal <objective> | --clear-goal]
    [--approval <id> --decision <approve|reject>]
    [--client-message-id <id>] [--json]
  {program} wait [<id>] [--agent <id> ...] [--mode any|all]
    [--wait-for message|completion] [--timeout <duration>] [--json]
  {program} stop <id> --execution <execution-id> [--json]
  {program} list [--scope children|descendants|workspace|profile]
    [--agent <id>]
    [--runner <runner>] [--query <title>] [--parent <id>]
    [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} view [<id>] [--history] [--cursor <cursor>]
    [--limit <1..100>] [--json]

Management:
  {program} config [<id>] [--model <id>] [--effort <value>] [--json]
  {program} rename [<id>] --title <name> [--json]
  {program} prompt get|clear [<id>] [--json]
  {program} prompt set [<id>] (-m <text> | --message-file <file|->) [--json]
  {program} schedule list [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} schedule get [<id>] [--json]
  {program} schedule create [<id>] --cron <cron>
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule update [<id>] --expected-revision <revision>
    [--cron <cron>] [-m <text> | --message-file <file|->] [--json]
  {program} approval decide <id> --run <run-id> --approval <approval-id>
    --decision <approve|reject> [--json]
  {program} wait <id> --run <run-id> [--until approval] --timeout <duration>
  {program} goal get|clear <id> [--json]
  {program} goal set <id> (-m <text> | --message-file <file|->) [--json]
  {program} current | show [<id>] | graph [<id>] | history [<id>]

Input and results:
  Start defaults to the current Session Runner; a terminal without a current
  Session must specify --runner or --parent. Profile lists configured models,
  not guaranteed account availability. Start returns without waiting.
  Send appends by default; --steer provides timely input and --queue defers.
  --goal sets or replaces a Goal; --clear-goal clears it. Send can update a Goal
  without text; omitted Goal is unchanged. Stop clears the target Session Goal.
  Wait defaults to direct-child completion and 30s; 0ms is a snapshot.
  Positive timeouts below 10s become 10s; maximum is 5m. Waiting does not stop.
  Images may be supplied without text: at most 5, 5 MiB each, 10 MiB total.
  -m and --message-file are exclusive; files use UTF-8 and - reads stdin.
  List exposes current identity and bounded pages; nextCursor marks more.
  Configuration and prompt changes apply to future executions.
  Prefer --steer for timely communication or course correction.
  Use --queue only for deliberately deferred input: it is consumed after
  current work and earlier queued inputs finish. With an active Goal it is
  not consumed until that Goal exits.
  Acceptance does not guarantee immediate processing.

  show --json includes session.status, session.model, session.effort,
  session.title, session.runId, session.recentTools, session.queuedCount and
  session.latestMessage. list reports latestActivity; wait may include progress.
  Status is RUNNING/IDLE/SLEEPING. In history, segments[].items[] with
  kind === "assistant_message" expose payload.text.

Exit codes: 1 failure, 2 input, 3 authorization, 4 unsupported, 5 timeout,
  6 unknown outcome, 130 cancelled wait. --json prints one result or error.`,
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
