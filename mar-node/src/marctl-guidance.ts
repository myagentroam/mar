import { scheduleTimeGuidance } from './schedule-guidance.js';

export function hasMarctlContext(environment: Readonly<Record<string, string>>): boolean {
  return (
    environment['MAR_CTL_CONTEXT_REQUIRED'] === '1' &&
    !!environment['MAR_CTL_USER_TOKEN'] &&
    !!environment['MAR_CTL_SERVER_URL'] &&
    !!environment['MAR_CTL_NODE_ID'] &&
    !!environment['MAR_CTL_WORKSPACE_ID']
  );
}

export const marctlManagementDescription =
  'Use marctl to manage MAR Agent session settings (model, effort, title, and persistent prompts) and Workspace scheduled tasks, read paginated public history, discover authorized MAR Nodes, and execute commands or transfer files on those Nodes. Use native agent_* tools for other Agent lifecycle and collaboration operations.';

const marctlHistory =
  'Use marctl agents history <id> [--cursor <cursor>] [--limit <1..100>] --json to read public history on demand; agents view returns state, Goal and recent activity only.';

const marctlSafety =
  'If a request result is unknown, inspect history before retrying. Session IDs and parent relationships do not grant authorization.';

const marctlSchedule = [
  'Use marctl agents schedule list [--session <session-id>] [--cursor <cursor>] --json to list tasks in the authorized Workspace. Use schedule get --task <task-id> for the current revision and settings and schedule runs --task <task-id> [--page <page>] for trigger results. A Session can have multiple tasks; never use a Session ID as a task ID.',
  'Use schedule create --name <name> --triggers-file <file|-> (-m <text> | --message-file <file|->). This creates a separate task bound to the current Session unless you give --session <session-id> or --new-session --runner <runner> with exactly one of --model-id <id> and --default-model (and optional --effort). A new-session task creates a Session at each trigger.',
  `${scheduleTimeGuidance} Use stdin for either the triggers or the task text, not both. After creation, confirm the next trigger and time zone from the receipt. This schedules MAR tasks, not CI or system jobs.`,
  'Use schedule update --task <task-id> --expected-revision <revision> with at least one of --name, --triggers-file, -m or --message-file. Supplying --triggers-file replaces all triggers; omit it when only the name or prompt changes. Other users’ tasks receive proposals instead of direct updates. Re-read on revision conflict; after an unknown write, list or get to check the result before retrying.'
].join('\n\n');

export const marctlManagementInstructions = [
  '## MAR Workspace management',
  'Use native agent_* tools for Agent discovery, creation, communication, observation, waiting and stopping. Do not switch to marctl when a native operation fails.',
  marctlHistory,
  'Use marctl agents config <id> --model-id <id> --effort <effort> to change future model settings; agents rename <id> --title <title> changes a title.',
  'Use agents prompt get/set/clear for persistent instructions; set accepts -m or --message-file.',
  marctlSchedule,
  'marctl nodes lists authorized Nodes; marctl ssh executes remote commands and marctl scp transfers files. Use marctl help agents, nodes, ssh or scp for options.',
  marctlSafety
].join('\n\n');

export const marctlDescription =
  'Use marctl agents to create, send to, wait for, stop, list and view Agents, configure models and effort, rename Sessions, manage prompts and schedules, or make explicitly authorized approval decisions; use nodes, ssh and scp for authorized Node operations.';

export const marctlInstructions = [
  '## MAR Workspace CLI',
  'Run marctl from the shell. Commands use the authenticated Node and Workspace; marctl help agents, nodes, ssh or scp shows options.',
  "Use agents start --title <title> -m <text> [--runner <runner>] [--parent <id>] [--model-id <id>] [--effort <effort>] [--goal <objective>]. An Agent must supply a nonblank title; a manual terminal may omit it. From an Agent, omit --runner to use the calling Agent's type. From a terminal, specify --runner or --parent. Without --runner, the parent Session supplies the Agent type. Start returns without waiting for completion.",
  'Use agents send <id> -m <text> [--steer|--queue], agents wait [<id>] [--wait-for message|completion] [--timeout <duration>], agents stop <id>, agents list [--scope tree|active], and agents view <id>. --timeout 0ms takes a snapshot; positive durations are used as requested. Stop targets the current Session execution and clears its Goal.',
  marctlHistory,
  'While children run, prefer advancing meaningful, non-overlapping task work rather than duplicating delegated work. Waiting is generally useful once no meaningful local task work remains and a required result is needed to unblock or finish the task.',
  'agents send defaults to --steer for timely communication or course correction. If it cannot deliver in place, Node may interrupt the current execution. --queue is best reserved for deferred input explicitly requested by the user or recipient: it is consumed after current work and earlier queued inputs finish, and with an active Goal it is not consumed until that Goal exits. Acceptance is not a guarantee of immediate processing.',
  'An accepted message normally needs no separate acknowledgment. Requests for receipt-only replies and immediate agents view checks solely to confirm receipt are usually unnecessary.',
  'Send can update a Goal alone with --goal <objective> or --clear-goal; omitted Goal leaves it unchanged. Decide an authorized Agent approval with send <id> --approval <approval-id> --decision approve|reject.',
  'List accepts only --scope tree|active, optional --query <title-fragment> and --limit <1..100> (default 10). With a current Session it defaults to the containing collaboration tree, including idle Sessions; without one it defaults to active Workspace Sessions (running or sleeping), and explicit tree is rejected. Active Sessions come first, then recent activity descending. Returns scope, currentAgentId (null without a Session), flat sessions with id, parentSessionId, title and status, and truncated; no cursor or pagination. Reuse known IDs directly.',
  'Only direct-child updates are collected automatically. Sending to a non-child never subscribes; an explicit wait observes it only for that call.',
  'Use agents config, rename and prompt for Session management. marctl nodes, ssh and scp use authorized Nodes.',
  marctlSchedule,
  marctlSafety
].join('\n\n');
